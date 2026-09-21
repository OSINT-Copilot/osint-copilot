import { describe, it, expect, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto'

// Tangent's workspace registry imports electron for app paths it does not touch here.
vi.mock('electron', () => ({
	app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
	BrowserWindow: class {},
	ipcMain: null,
}))

import { ExtensionController } from '../extension/controller'
import { tangentInboxHost, type WindowContents, type WindowLike } from './tangent-host'
import { verifySealedManifest } from './manifest-mac'

/**
 * Tangent's own registry. Loaded through a specifier TypeScript does not follow: this
 * folder is inside `typecheck:osint`, and Tangent's tree does not build under strict
 * null checks (see guarded-ipc.ts). The shape is the part tangent-host.ts relies on.
 */
interface TangentRegistry {
	workspaceMap: Map<string, unknown>
	contentsMap: Map<WindowContents, WindowLike>
}
const workspacesModule = '../../workspaces'
let registry: TangentRegistry | null = null

/**
 * The whole path a bundle takes, as the extension would drive it: the real server and the
 * real inbox over a workspace registered in Tangent's own workspaceMap, and a client that
 * implements PROTOCOL.md from scratch with node:crypto rather than the app's signing.ts, so
 * the two halves are checked against the document and not against each other.
 */

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osint-e2e-')))
const workspace = path.join(dir, 'Case Alpha')
const docs = path.join(dir, 'Documentation')
fs.mkdirSync(workspace)
fs.mkdirSync(docs)

const window = { isDestroyed: () => false, send: vi.fn() }

afterAll(() => {
	registry?.workspaceMap.delete(workspace)
	registry?.workspaceMap.delete(docs)
	registry?.contentsMap.delete(window)
	fs.rmSync(dir, { recursive: true, force: true })
})

// --- a client written from PROTOCOL.md ---------------------------------------------------

const ORIGIN = 'chrome-extension://' + 'k'.repeat(32)
const b64 = (bytes: Buffer) => bytes.toString('base64url')
const mac = (key: Buffer, text: string) => createHmac('sha256', key).update(text, 'utf8').digest()
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

interface Reply { status: number; headers: http.IncomingHttpHeaders; raw: Buffer; json: any }

function send(port: number, method: string, target: string, headers: Record<string, string>, body?: Buffer): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, res => {
			const chunks: Buffer[] = []
			res.on('data', c => chunks.push(c))
			res.on('end', () => {
				const raw = Buffer.concat(chunks)
				resolve({ status: res.statusCode!, headers: res.headers, raw, json: JSON.parse(raw.toString('utf8')) })
			})
		})
		req.on('error', reject)
		req.end(body)
	})
}

class ScriptedExtension {
	clientId = ''
	key = Buffer.alloc(0)
	instanceId = ''
	port = 0

	async pair(pairingString: string): Promise<void> {
		const [tag, port, instanceId, secretText] = pairingString.split('.')
		expect(tag).toBe('ocpair1')
		const secret = Buffer.from(secretText, 'base64url')
		this.port = Number(port)
		this.instanceId = instanceId
		const clientNonce = b64(randomBytes(16))
		const body = Buffer.from(JSON.stringify({
			pairingId: createHash('sha256').update(secret).digest('hex').slice(0, 32),
			clientNonce,
			extVersion: '1.0.0',
			proof: b64(mac(secret, `OCPAIR1\n${clientNonce}`)),
		}))
		const res = await send(this.port, 'POST', '/v1/pair', {
			'Host': `127.0.0.1:${this.port}`, 'X-OC-Proto': '1', 'Content-Type': 'application/json',
			'Origin': ORIGIN, 'Content-Length': String(body.length),
		}, body)
		expect(res.status, JSON.stringify(res.json)).toBe(200)
		const { clientId, serverNonce, serverProof } = res.json
		expect(res.json.instanceId).toBe(instanceId)
		expect(serverProof).toBe(b64(mac(secret, `OCPAIR1S\n${clientNonce}\n${serverNonce}\n${clientId}`)))
		this.clientId = clientId
		this.key = mac(secret, `oc-k1\n${clientNonce}\n${serverNonce}\n${clientId}`)
	}

	async hello(): Promise<void> {
		const clientNonce = b64(randomBytes(16))
		const body = Buffer.from(JSON.stringify({ clientId: this.clientId, clientNonce }))
		const res = await send(this.port, 'POST', '/v1/hello', {
			'Host': `127.0.0.1:${this.port}`, 'X-OC-Proto': '1', 'Content-Type': 'application/json',
			'Origin': ORIGIN, 'Content-Length': String(body.length),
		}, body)
		expect(res.status).toBe(200)
		const endpoint = `127.0.0.1:${this.port}`
		expect(res.json.serverProof).toBe(b64(mac(this.key, `OCHELLO1\n${endpoint}\n${clientNonce}\n${res.json.serverNonce}\n${this.instanceId}`)))
	}

	/** A signed request; fails the test unless the response signature verifies. */
	async signed(method: 'GET' | 'POST', target: string, value?: unknown): Promise<Reply> {
		const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value), 'utf8')
		const endpoint = `127.0.0.1:${this.port}`
		const ts = String(Date.now())
		const nonce = b64(randomBytes(16))
		const bodySha256 = sha256(body)
		const contentLength = String(body.length)
		const sig = b64(mac(this.key, ['OC1', endpoint, method, target, ts, nonce, this.clientId, contentLength, bodySha256].join('\n')))
		const headers: Record<string, string> = {
			'Host': endpoint, 'X-OC-Proto': '1', 'X-OC-Client': this.clientId, 'X-OC-Ts': ts,
			'X-OC-Nonce': nonce, 'X-OC-Body-Sha256': bodySha256, 'X-OC-Sig': sig,
		}
		if (method === 'POST') Object.assign(headers, { 'Content-Type': 'application/json', 'Origin': ORIGIN, 'Content-Length': contentLength })
		const res = await send(this.port, method, target, headers, method === 'POST' ? body : undefined)
		const expected = b64(mac(this.key, `OC1R\n${endpoint}\n${res.status}\n${nonce}\n${sha256(res.raw)}`))
		expect(res.headers['x-oc-sig'], 'response signature').toBe(expected)
		return res
	}
}

// --- the test -----------------------------------------------------------------------------

describe('extension to inbox, end to end', () => {
	it('pairs, sends an entity bundle into a registered workspace, and a resend is a duplicate', async () => {
		registry = await vi.importActual<TangentRegistry>(workspacesModule)
		const { workspaceMap, contentsMap } = registry
		workspaceMap.set(workspace, null)
		workspaceMap.set(docs, null)
		contentsMap.set(window, { assignedWorkspacePath: workspace })

		const controller = await ExtensionController.open({
			userDataDir: path.join(dir, 'userData'),
			encryptor: null,
			confirm: async () => true,
			licensed: async () => true,
			host: tangentInboxHost({ workspaceMap, contentsMap, documentationPath: () => docs }),
			appVersion: '0.0.0-test',
			ports: [0],
		})
		try {
			await controller.setEnabled(true)
			const extension = new ScriptedExtension()
			await extension.pair((await controller.pairBegin()).pairingString)
			await extension.hello()

			const listed = await extension.signed('GET', '/v1/workspaces')
			expect(listed.status).toBe(200)
			// The documentation is not an investigation; the case is, and a window has it open.
			expect(listed.json.workspaces).toEqual([{ id: expect.any(String), name: 'Case Alpha', open: true }])
			const workspaceId: string = listed.json.workspaces[0].id

			const manifest = {
				v: 1,
				bundleId: randomUUID(),
				workspaceId,
				kind: 'entity',
				page: { url: 'https://example.com/team', title: 'Our team' },
				clientTime: new Date().toISOString(),
				entity: { kind: 'wallet', chain: 'eth', value: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', context: 'Donate here' },
			}
			const first = await extension.signed('POST', '/v1/bundles', manifest)
			expect(first.status, JSON.stringify(first.json)).toBe(200)
			expect(first.json).toEqual({ status: 'accepted', bundleId: manifest.bundleId, receivedAt: expect.any(String) })
			expect(window.send).toHaveBeenCalledWith('osint:inbox.changed')

			const pending = path.join(workspace, '.osint-inbox', 'pending')
			expect(fs.readdirSync(pending)).toEqual([manifest.bundleId])
			const stored = JSON.parse(fs.readFileSync(path.join(pending, manifest.bundleId, 'manifest.json'), 'utf8'))
			expect(verifySealedManifest(controller.secrets.manifestKey(), stored)).toBe(true)
			expect(stored.server).toEqual({ receivedAt: first.json.receivedAt, clientId: extension.clientId, origin: ORIGIN, extVersion: '1.0.0' })
			const bundles = await controller.inbox.listPending(workspace)
			expect(bundles).toHaveLength(1)
			expect(bundles[0].manifest).toEqual(manifest)

			const status = await extension.signed('GET', '/v1/status')
			expect(status.json).toEqual({ licensed: true, pendingCount: 1 })

			const again = await extension.signed('POST', '/v1/bundles', manifest)
			expect(again.json).toEqual({ status: 'duplicate', bundleId: manifest.bundleId, receivedAt: first.json.receivedAt })
			expect(fs.readdirSync(pending)).toEqual([manifest.bundleId])
			expect(fs.readdirSync(path.join(workspace, '.osint-inbox', '.staging'))).toEqual([])
			expect(fs.existsSync(path.join(docs, '.osint-inbox'))).toBe(false)
		} finally {
			await controller.stop()
		}
	// A real server, a real pairing and three signed requests: about 5s of work, which the
	// default 5s timeout lost whenever the rest of the suite was running beside it.
	}, 30_000)
})
