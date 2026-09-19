import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { ExtensionController } from '../extension/controller'
import { inProcessRunner } from '../capture/test-runners'
import { tangentInboxHost, type WindowContents, type WindowLike } from './tangent-host'
import { verifySealedDerived, verifySealedManifest } from './manifest-mac'
import {
	b64url,
	deriveClientKey,
	endpointFor,
	hmac,
	pairingIdFor,
	pairProofString,
	responseStringToSign,
	sha256Hex,
	verifyMac,
} from '../extension/signing'
import { parsePairingString, signRequest } from '../extension/test-client'

/**
 * A capture over real sockets, through the real controller: pair, create, upload two
 * files as signed octet-stream bodies, commit, and watch main derive it. The parser runs
 * in-process and the render is faked; everything else is the app's.
 */

const ORIGIN = 'chrome-extension://' + 'c'.repeat(32)
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osint-capture-http-')))
const workspace = path.join(dir, 'Case Capture')
fs.mkdirSync(workspace)
const MHTML = fs.readFileSync(path.join(__dirname, '..', 'capture', 'fixtures', 'blink-page.mhtml'))
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(4096)])
const RENDERED = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(128)])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

let controller: ExtensionController
let port = 0
let clientId = ''
let key: Buffer = Buffer.alloc(0)

interface Reply { status: number; headers: http.IncomingHttpHeaders; raw: Buffer; json: any }

function send(method: string, target: string, headers: Record<string, string>, body?: Buffer): Promise<Reply> {
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

/** A signed POST; fails the test unless the reply's signature verifies. */
async function post(target: string, body: Buffer, type = 'application/json'): Promise<Reply> {
	const nonce = b64url(randomBytes(16))
	const ts = String(Date.now())
	const parts = { endpoint: endpointFor(port), method: 'POST', pathWithQuery: target, ts, nonce, clientId, contentLength: String(body.length), bodySha256: sha256Hex(body) }
	const res = await send('POST', target, {
		'Host': `127.0.0.1:${port}`, 'X-OC-Proto': '1', 'Content-Type': type, 'Origin': ORIGIN,
		'Content-Length': String(body.length), 'X-OC-Client': clientId, 'X-OC-Ts': ts, 'X-OC-Nonce': nonce,
		'X-OC-Body-Sha256': parts.bodySha256, 'X-OC-Sig': signRequest(key, parts),
	}, body)
	const sig = res.headers['x-oc-sig']
	expect(typeof sig === 'string' && verifyMac(key, responseStringToSign(endpointFor(port), res.status, nonce, sha256Hex(res.raw)), sig)).toBe(true)
	return res
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8')

beforeAll(async () => {
	const window: WindowContents = { isDestroyed: () => false, send: () => {} }
	controller = await ExtensionController.open({
		userDataDir: path.join(dir, 'userData'),
		encryptor: null,
		confirm: async () => true,
		licensed: async () => true,
		host: tangentInboxHost({
			workspaceMap: new Map<string, unknown>([[workspace, null]]),
			contentsMap: new Map<WindowContents, WindowLike>([[window, { assignedWorkspacePath: workspace }]]),
			documentationPath: () => null,
		}),
		appVersion: '0.0.0-test',
		ports: [0],
		capture: { runParser: inProcessRunner, renderArchive: async () => ({ png: RENDERED }) },
	})
	await controller.setEnabled(true)
	port = controller.server.port!

	const { pairSecret } = parsePairingString((await controller.pairBegin()).pairingString)!
	const clientNonce = b64url(randomBytes(16))
	const res = await send('POST', '/v1/pair', {
		'Host': `127.0.0.1:${port}`, 'X-OC-Proto': '1', 'Content-Type': 'application/json', 'Origin': ORIGIN,
	}, json({ pairingId: pairingIdFor(pairSecret), clientNonce, extVersion: '1.0.0', proof: b64url(hmac(pairSecret, pairProofString(clientNonce))) }))
	expect(res.status).toBe(200)
	clientId = res.json.clientId
	key = deriveClientKey(pairSecret, clientNonce, res.json.serverNonce, clientId)
})

afterAll(async () => {
	await controller.stop()
	fs.rmSync(dir, { recursive: true, force: true })
})

describe('a capture over HTTP', () => {
	it('create, two files, commit, derive: pending holds the files, the sealed manifest and derived.json', async () => {
		const workspaceId = (await controller.inbox.listWorkspaces())[0].id
		const bundleId = randomUUID()
		const manifest = {
			v: 1, bundleId, workspaceId, kind: 'capture',
			page: { url: 'https://news.example/2026/09/cafe-owner?ref=home', title: 'Café owner' },
			clientTime: new Date().toISOString(),
			capture: { files: { 'page.mhtml': { size: MHTML.length, sha256: sha(MHTML) }, 'viewport.png': { size: PNG.length, sha256: sha(PNG) } } },
		}
		const created = await post('/v1/bundles', json(manifest))
		expect(created.status).toBe(200)
		expect(created.json).toEqual({ status: 'created', bundleId, missing: ['page.mhtml', 'viewport.png'] })

		const early = await post(`/v1/bundles/${bundleId}/commit`, json({}))
		expect(early.status).toBe(409)
		expect(early.json).toEqual({ error: 'incomplete', detail: ['page.mhtml', 'viewport.png'] })

		// An archive offered as the viewport image is refused on its content.
		const sniffed = await post(`/v1/bundles/${bundleId}/files/viewport.png`, MHTML, 'application/octet-stream')
		expect(sniffed.status).toBe(422)

		expect((await post(`/v1/bundles/${bundleId}/files/page.mhtml`, MHTML, 'application/octet-stream')).json).toEqual({ received: true })
		expect((await post(`/v1/bundles/${bundleId}/files/viewport.png`, PNG, 'application/octet-stream')).json).toEqual({ received: true })
		// A repeat, as after a lost reply: answered without storing it again.
		expect((await post(`/v1/bundles/${bundleId}/files/viewport.png`, PNG, 'application/octet-stream')).json).toEqual({ received: true })

		const committed = await post(`/v1/bundles/${bundleId}/commit`, json({}))
		expect(committed.status).toBe(200)
		expect(committed.json).toMatchObject({ status: 'accepted', bundleId })
		expect((await post(`/v1/bundles/${bundleId}/commit`, json({}))).json.status).toBe('duplicate')
		expect((await post('/v1/bundles', json(manifest))).json.status).toBe('duplicate')

		await controller.deriver!.idle()
		const pending = path.join(workspace, '.osint-inbox', 'pending', bundleId)
		expect(fs.readdirSync(pending).sort()).toEqual(['derived.json', 'fullpage.png', 'manifest.json', 'page.markdown', 'page.mhtml', 'upload.json', 'viewport.png'])
		const stored = JSON.parse(fs.readFileSync(path.join(pending, 'manifest.json'), 'utf8'))
		expect(verifySealedManifest(controller.secrets.manifestKey(), stored)).toBe(true)
		expect(stored.server).toMatchObject({ clientId, origin: ORIGIN, files: manifest.capture.files })
		const derived = JSON.parse(fs.readFileSync(path.join(pending, 'derived.json'), 'utf8'))
		expect(verifySealedDerived(controller.secrets.manifestKey(), derived, bundleId)).toBe(true)
		expect(derived).toMatchObject({ status: 'done', urlMismatch: false, fullpage: { sha256: sha(RENDERED) } })

		const listed = await controller.inbox.listPending(fs.realpathSync(workspace))
		expect(listed.map(b => [b.bundleId, b.derived?.status])).toEqual([[bundleId, 'done']])
	})
})
