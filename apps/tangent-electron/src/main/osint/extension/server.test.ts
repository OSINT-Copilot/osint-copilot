import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { ExtensionServer, type BundleContext, type FileUpload, type InboxBackend } from './server'
import { PairingManager } from './pairing'
import { ExtensionSecretStore } from './secret-store'
import { MAX_CONTROL_BODY, type Manifest } from './protocol'
import {
	b64url,
	deriveClientKey,
	endpointFor,
	helloProofString,
	hmac,
	pairingIdFor,
	pairProofString,
	parsePairingString,
	responseStringToSign,
	sha256Hex,
	signRequest,
	verifyMac,
} from './signing'

/**
 * The server end to end over real sockets on an ephemeral port, with a fake inbox. Each
 * security property in PROTOCOL.md has a test here; every response any test sees is also
 * checked for CORS headers at the end.
 */

const ORIGIN = 'chrome-extension://' + 'a'.repeat(32)
const OTHER_ORIGIN = 'chrome-extension://' + 'b'.repeat(32)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-ext-server-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** Every response header set seen by any test. */
const seenHeaders: Record<string, unknown>[] = []

afterAll(() => {
	expect(seenHeaders.length).toBeGreaterThan(20)
	for (const headers of seenHeaders) {
		for (const name of Object.keys(headers)) expect(name.toLowerCase()).not.toMatch(/^access-control-/)
	}
})

class FakeBackend implements InboxBackend {
	calls: string[] = []
	bundles: { manifest: Manifest; ctx: BundleContext }[] = []
	next: Awaited<ReturnType<InboxBackend['acceptBundle']>> | null = null

	async status() {
		this.calls.push('status')
		return { licensed: true, receiving: true, pendingCount: 3 }
	}

	async listWorkspaces() {
		this.calls.push('listWorkspaces')
		return [{ id: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'Case', open: true }]
	}

	async acceptBundle(manifest: Manifest, ctx: BundleContext) {
		this.calls.push('acceptBundle')
		this.bundles.push({ manifest, ctx })
		return this.next ?? { status: 'accepted' as const, bundleId: manifest.bundleId, receivedAt: ctx.receivedAt }
	}

	files: { upload: Omit<FileUpload, 'body'>; bytes: Buffer }[] = []

	async receiveFile(upload: FileUpload, _ctx: BundleContext) {
		this.calls.push('receiveFile')
		const chunks: Buffer[] = []
		for await (const chunk of upload.body) chunks.push(chunk)
		const { body: _body, ...rest } = upload
		this.files.push({ upload: rest, bytes: Buffer.concat(chunks) })
		return { received: true as const }
	}

	async commitBundle(bundleId: string, ctx: BundleContext) {
		this.calls.push('commitBundle')
		return { status: 'accepted' as const, bundleId, receivedAt: ctx.receivedAt }
	}
}

interface Response {
	status: number
	headers: http.IncomingHttpHeaders
	raw: Buffer
	json: any
}

interface Client {
	clientId: string
	key: Buffer
	origin: string
}

let n = 0
let ctx: {
	server: ExtensionServer
	pairing: PairingManager
	secrets: ExtensionSecretStore
	backend: FakeBackend
	clock: { now: number }
	port: number
	confirm: ReturnType<typeof vi.fn>
}

beforeEach(async () => {
	const dir = path.join(root, String(n++))
	fs.mkdirSync(dir)
	const clock = { now: 1_760_000_000_000 }
	const secrets = await ExtensionSecretStore.open(dir, null)
	const confirm = vi.fn(async () => true)
	const pairing = await PairingManager.open({ userDataDir: dir, secrets, confirm, now: () => clock.now })
	const backend = new FakeBackend()
	const server = new ExtensionServer({ pairing, backend, appVersion: '0.13.1-test', now: () => clock.now })
	const port = await server.start({ ports: [0] })
	ctx = { server, pairing, secrets, backend, clock, port, confirm }
})

afterEach(async () => {
	await ctx.server.stop()
})

function request(opts: {
	method: string
	path: string
	headers?: Record<string, string | undefined>
	body?: Buffer | string
	chunks?: Buffer[]
	/** Where to dial; the server's own port unless a test relays. */
	port?: number
}): Promise<Response> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {}
		for (const [k, v] of Object.entries(opts.headers ?? {})) if (v !== undefined) headers[k] = v
		const req = http.request({
			host: '127.0.0.1',
			port: opts.port ?? ctx.port,
			method: opts.method,
			path: opts.path,
			headers,
			agent: false,
		}, res => {
			const chunks: Buffer[] = []
			res.on('data', c => chunks.push(c))
			res.on('end', () => {
				seenHeaders.push(res.headers)
				const raw = Buffer.concat(chunks)
				let json: any = null
				try { json = JSON.parse(raw.toString('utf8')) } catch { /* not JSON */ }
				resolve({ status: res.statusCode!, headers: res.headers, raw, json })
			})
		})
		req.on('error', reject)
		if (opts.chunks) {
			for (const c of opts.chunks) req.write(c)
			req.end()
		} else {
			req.end(opts.body)
		}
	})
}

function baseHeaders(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return { 'X-OC-Proto': '1', ...extra }
}

function jsonHeaders(origin = ORIGIN, extra: Record<string, string | undefined> = {}) {
	return baseHeaders({ 'Content-Type': 'application/json', Origin: origin, ...extra })
}

/** Headers for a signed request, as the extension computes them. */
function signedHeaders(client: Client, method: string, pathWithQuery: string, body: Buffer, over: {
	ts?: string
	nonce?: string
	contentLength?: string
	bodySha256?: string
	sig?: string
	/** The port the extension believes it is talking to. */
	port?: number
} = {}) {
	const endpoint = endpointFor(over.port ?? ctx.port)
	const ts = over.ts ?? String(ctx.clock.now)
	const nonce = over.nonce ?? b64url(randomBytes(16))
	const contentLength = over.contentLength ?? String(body.length)
	const bodySha256 = over.bodySha256 ?? sha256Hex(body)
	const sig = over.sig ?? signRequest(client.key, { endpoint, method, pathWithQuery, ts, nonce, clientId: client.clientId, contentLength, bodySha256 })
	return {
		'X-OC-Client': client.clientId,
		'X-OC-Ts': ts,
		'X-OC-Nonce': nonce,
		'X-OC-Body-Sha256': bodySha256,
		'X-OC-Sig': sig,
	}
}

async function signed(client: Client, method: 'GET' | 'POST', pathWithQuery: string, bodyValue?: unknown, over = {}) {
	const body = bodyValue === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(bodyValue), 'utf8')
	const headers = signedHeaders(client, method, pathWithQuery, body, over)
	const res = await request({
		method,
		path: pathWithQuery,
		headers: method === 'POST' ? jsonHeaders(client.origin, headers) : baseHeaders(headers),
		body: method === 'POST' ? body : undefined,
	})
	return { res, nonce: headers['X-OC-Nonce'] }
}

function responseSigOk(client: Client, res: Response, nonce: string, port = ctx.port): boolean {
	const sig = res.headers['x-oc-sig']
	return typeof sig === 'string' && verifyMac(client.key, responseStringToSign(endpointFor(port), res.status, nonce, sha256Hex(res.raw)), sig)
}

/**
 * A process squatting a port that pipes every byte to the real server, Host header
 * included (as if rewritten): the relay attack the endpoint binding exists to stop.
 */
async function startRelay(): Promise<{ port: number; close: () => Promise<void> }> {
	const sockets = new Set<net.Socket>()
	const relay = net.createServer(inbound => {
		const outbound = net.connect(ctx.port, '127.0.0.1')
		sockets.add(inbound).add(outbound)
		inbound.pipe(outbound).pipe(inbound)
		inbound.on('error', () => outbound.destroy())
		outbound.on('error', () => inbound.destroy())
	})
	await new Promise<void>(r => relay.listen(0, '127.0.0.1', r))
	return {
		port: (relay.address() as net.AddressInfo).port,
		close: () => new Promise<void>(r => {
			for (const socket of sockets) socket.destroy()
			relay.close(() => r())
		}),
	}
}

/** Pairs over HTTP exactly as the extension would. */
async function pair(origin = ORIGIN): Promise<Client> {
	const { pairingString } = ctx.pairing.begin(ctx.port)
	const { pairSecret } = parsePairingString(pairingString)!
	const clientNonce = b64url(randomBytes(16))
	const res = await request({
		method: 'POST',
		path: '/v1/pair',
		headers: jsonHeaders(origin),
		body: JSON.stringify({
			pairingId: pairingIdFor(pairSecret),
			clientNonce,
			extVersion: '1.0.0',
			proof: b64url(hmac(pairSecret, pairProofString(clientNonce))),
		}),
	})
	expect(res.status, JSON.stringify(res.json)).toBe(200)
	const { clientId, serverNonce } = res.json
	return { clientId, origin, key: deriveClientKey(pairSecret, clientNonce, serverNonce, clientId) }
}

function manifest(over: Record<string, unknown> = {}) {
	return {
		v: 1,
		bundleId: randomUUID(),
		workspaceId: 'AAAAAAAAAAAAAAAAAAAAAA',
		kind: 'note',
		page: { url: 'https://example.com/a', title: 'A' },
		clientTime: new Date(ctx.clock.now).toISOString(),
		note: { text: 'seen on the page' },
		...over,
	}
}

/** Resolves if something accepts a connection on `port`, rejects otherwise. */
function connects(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const s = net.connect(port, '127.0.0.1')
		s.on('connect', () => { s.destroy(); resolve() })
		s.on('error', reject)
	})
}

/** Sends raw bytes and returns the parsed reply, or null if none arrives in `waitMs`. */
function rawExchange(text: string, waitMs: number): Promise<{ status: number; headers: Record<string, string>; body: string } | null> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(ctx.port, '127.0.0.1')
		let data = ''
		const timer = setTimeout(() => { socket.destroy(); resolve(null) }, waitMs)
		socket.on('data', chunk => {
			data += chunk.toString('utf8')
			const end = data.indexOf('\r\n\r\n')
			if (end < 0) return
			const [statusLine, ...lines] = data.slice(0, end).split('\r\n')
			const headers: Record<string, string> = {}
			for (const line of lines) {
				const i = line.indexOf(':')
				headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
			}
			const length = Number(headers['content-length'] ?? 0)
			const body = data.slice(end + 4)
			if (Buffer.byteLength(body) < length) return
			clearTimeout(timer)
			socket.destroy()
			seenHeaders.push(headers)
			resolve({ status: Number(statusLine.split(' ')[1]), headers, body })
		})
		socket.on('error', err => { clearTimeout(timer); reject(err) })
		socket.write(text)
	})
}

// --- tests ---------------------------------------------------------------------------

describe('happy path', () => {
	it('pairs, says hello, and serves status, workspaces and a bundle', async () => {
		const client = await pair()
		expect(ctx.confirm).toHaveBeenCalledWith({ origin: ORIGIN, extVersion: '1.0.0' })

		const clientNonce = b64url(randomBytes(16))
		const hello = await request({
			method: 'POST',
			path: '/v1/hello',
			headers: jsonHeaders(),
			body: JSON.stringify({ clientId: client.clientId, clientNonce }),
		})
		expect(hello.status).toBe(200)
		expect(hello.json.proto).toEqual({ min: 1, max: 1 })
		expect(hello.json.appVersion).toBe('0.13.1-test')
		expect(hello.json.instanceId).toBe(ctx.pairing.instanceId)
		expect(verifyMac(client.key, helloProofString(endpointFor(ctx.port), clientNonce, hello.json.serverNonce, hello.json.instanceId), hello.json.serverProof)).toBe(true)
		expect(ctx.pairing.listClients()[0].lastSeenAt).toBe(new Date(ctx.clock.now).toISOString())

		const status = await signed(client, 'GET', '/v1/status')
		expect(status.res.status).toBe(200)
		expect(status.res.json).toEqual({ licensed: true, receiving: true, pendingCount: 3 })
		expect(responseSigOk(client, status.res, status.nonce)).toBe(true)

		const workspaces = await signed(client, 'GET', '/v1/workspaces')
		expect(workspaces.res.json).toEqual({ workspaces: [{ id: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'Case', open: true }] })
		expect(responseSigOk(client, workspaces.res, workspaces.nonce)).toBe(true)

		const m = manifest({ page: { url: 'https://user:pw@example.com/a', title: 'A' } })
		const bundle = await signed(client, 'POST', '/v1/bundles', m)
		expect(bundle.res.status).toBe(200)
		expect(bundle.res.json).toEqual({ status: 'accepted', bundleId: m.bundleId, receivedAt: new Date(ctx.clock.now).toISOString() })
		expect(responseSigOk(client, bundle.res, bundle.nonce)).toBe(true)
		const received = ctx.backend.bundles[0]
		expect(received.manifest.page.url).toBe('https://example.com/a')
		expect(received.ctx).toMatchObject({ clientId: client.clientId, origin: ORIGIN, extVersion: '1.0.0' })
		expect(received.ctx.bodySha256).toBe(sha256Hex(JSON.stringify(m)))
	})

	it('binds 127.0.0.1 only and persists the port', async () => {
		expect(ctx.pairing.port).toBe(ctx.port)
		await expect(new Promise((resolve, reject) => {
			const s = net.connect(ctx.port, '::1')
			s.on('connect', () => { s.destroy(); resolve('connected') })
			s.on('error', reject)
		})).rejects.toThrow()
	})

	it('falls back to the next port when one is taken', async () => {
		const blocker = net.createServer()
		await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r))
		const taken = (blocker.address() as net.AddressInfo).port
		await ctx.server.stop()
		try {
			const port = await ctx.server.start({ ports: [taken, 0] })
			expect(port).not.toBe(taken)
			expect(ctx.pairing.port).toBe(port)
			ctx.port = port
		} finally {
			blocker.close()
		}
	})

	it('overlapping starts share one listener, and stop closes it', async () => {
		await ctx.server.stop()
		const [a, b] = await Promise.all([ctx.server.start({ ports: [0] }), ctx.server.start({ ports: [0] })])
		expect(b).toBe(a)
		ctx.port = a
		await ctx.server.stop()
		await expect(connects(a)).rejects.toThrow()
	})

	it('a stop issued while a start is binding leaves nothing listening', async () => {
		await ctx.server.stop()
		const starting = ctx.server.start({ ports: [0] })
		await ctx.server.stop()
		const port = await starting
		await expect(connects(port)).rejects.toThrow()
		expect(ctx.server.port).toBeNull()
	})
})

describe('a relay squatting another port', () => {
	it('cannot pass on a request the extension signed for the port it dialled', async () => {
		const client = await pair()
		const relay = await startRelay()
		try {
			const headers = signedHeaders(client, 'GET', '/v1/status', Buffer.alloc(0), { port: relay.port })
			const res = await request({
				method: 'GET',
				path: '/v1/status',
				port: relay.port,
				headers: baseHeaders({ ...headers, Host: `127.0.0.1:${ctx.port}` }),
			})
			expect(res.status).toBe(401)
			expect(res.json).toEqual({ error: 'bad_signature' })
			expect(res.headers['x-oc-sig']).toBeUndefined()
			expect(ctx.backend.calls).toEqual([])
		} finally {
			await relay.close()
		}
	})

	it('gets a hello proof and response signatures that fail for the port the extension dialled', async () => {
		const client = await pair()
		const relay = await startRelay()
		try {
			const clientNonce = b64url(randomBytes(16))
			const hello = await request({
				method: 'POST',
				path: '/v1/hello',
				port: relay.port,
				headers: jsonHeaders(ORIGIN, { Host: `127.0.0.1:${ctx.port}` }),
				body: JSON.stringify({ clientId: client.clientId, clientNonce }),
			})
			expect(hello.status).toBe(200)
			const { serverNonce, instanceId, serverProof } = hello.json
			expect(instanceId).toBe(ctx.pairing.instanceId)
			expect(verifyMac(client.key, helloProofString(endpointFor(relay.port), clientNonce, serverNonce, instanceId), serverProof)).toBe(false)
			expect(verifyMac(client.key, helloProofString(endpointFor(ctx.port), clientNonce, serverNonce, instanceId), serverProof)).toBe(true)

			// Even a response the app did sign names its own port, not the relay's.
			const { res, nonce } = await signed(client, 'GET', '/v1/status')
			expect(res.status).toBe(200)
			expect(responseSigOk(client, res, nonce, relay.port)).toBe(false)
			expect(responseSigOk(client, res, nonce)).toBe(true)
		} finally {
			await relay.close()
		}
	})
})

describe('checks before routing', () => {
	it('wrong Host gets 421 and no handler runs', async () => {
		const client = await pair()
		ctx.confirm.mockClear()
		ctx.pairing.begin(ctx.port)
		for (const host of [`evil.example:${ctx.port}`, `127.0.0.1:${ctx.port + 1}`, '127.0.0.1', `LOCALHOST:${ctx.port}`]) {
			const body = Buffer.from(JSON.stringify(manifest()))
			const res = await request({
				method: 'POST',
				path: '/v1/bundles',
				headers: jsonHeaders(ORIGIN, { Host: host, ...signedHeaders(client, 'POST', '/v1/bundles', body) }),
				body,
			})
			expect(res.status).toBe(421)
			expect(res.json).toEqual({ error: 'bad_host' })
			const pairRes = await request({ method: 'POST', path: '/v1/pair', headers: jsonHeaders(ORIGIN, { Host: host }), body: '{}' })
			expect(pairRes.status).toBe(421)
		}
		expect(ctx.backend.calls).toEqual([])
		expect(ctx.confirm).not.toHaveBeenCalled()
	})

	it('accepts localhost:<port> as the Host', async () => {
		const client = await pair()
		const headers = signedHeaders(client, 'GET', '/v1/status', Buffer.alloc(0))
		const res = await request({ method: 'GET', path: '/v1/status', headers: baseHeaders({ Host: `localhost:${ctx.port}`, ...headers }) })
		expect(res.status).toBe(200)
	})

	it('OPTIONS gets 403', async () => {
		const res = await request({
			method: 'OPTIONS',
			path: '/v1/bundles',
			headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'X-OC-Proto': '1' },
		})
		expect(res.status).toBe(403)
		expect(res.json).toEqual({ error: 'forbidden' })
	})

	it('a missing or wrong X-OC-Proto gets 400', async () => {
		for (const proto of [undefined, '2', '']) {
			const res = await request({ method: 'GET', path: '/v1/status', headers: { 'X-OC-Proto': proto } })
			expect(res.status).toBe(400)
			expect(res.json).toEqual({ error: 'bad_proto' })
		}
	})

	it('a POST that is not application/json gets 400', async () => {
		const client = await pair()
		const body = Buffer.from(JSON.stringify(manifest()))
		const res = await request({
			method: 'POST',
			path: '/v1/bundles',
			headers: { ...jsonHeaders(ORIGIN, signedHeaders(client, 'POST', '/v1/bundles', body)), 'Content-Type': 'text/plain' },
			body,
		})
		expect(res.status).toBe(400)
		expect(res.json).toEqual({ error: 'bad_content_type' })
		expect(ctx.backend.calls).toEqual([])
	})

	it('/v1/pair without a chrome-extension Origin gets 403', async () => {
		ctx.pairing.begin(ctx.port)
		for (const origin of [undefined, 'https://evil.example', 'chrome-extension://' + 'z'.repeat(32), 'chrome-extension://' + 'a'.repeat(31), 'null']) {
			const res = await request({ method: 'POST', path: '/v1/pair', headers: { ...jsonHeaders(), Origin: origin }, body: '{}' })
			expect(res.status).toBe(403)
			expect(res.json).toEqual({ error: 'bad_origin' })
		}
		expect(ctx.confirm).not.toHaveBeenCalled()
	})

	it('a later POST from an Origin other than the one paired gets 403', async () => {
		const client = await pair()
		const forged = { ...client, origin: OTHER_ORIGIN }
		const { res } = await signed(forged, 'POST', '/v1/bundles', manifest())
		expect(res.status).toBe(403)
		expect(res.json).toEqual({ error: 'bad_origin' })
		// Unsigned: the MAC was never checked, so this may be anyone holding the clientId.
		expect(res.headers['x-oc-sig']).toBeUndefined()

		const hello = await request({
			method: 'POST',
			path: '/v1/hello',
			headers: jsonHeaders(OTHER_ORIGIN),
			body: JSON.stringify({ clientId: client.clientId, clientNonce: b64url(randomBytes(16)) }),
		})
		expect(hello.status).toBe(403)
		expect(ctx.backend.calls).toEqual([])
	})

	it('GET needs no Origin', async () => {
		const client = await pair()
		const { res } = await signed(client, 'GET', '/v1/status')
		expect(res.status).toBe(200)
	})
})

describe('request authentication', () => {
	it('an unknown client gets 401', async () => {
		const stranger = { clientId: b64url(randomBytes(16)), key: randomBytes(32), origin: ORIGIN }
		const { res } = await signed(stranger, 'GET', '/v1/status')
		expect(res.status).toBe(401)
		expect(res.json).toEqual({ error: 'unauthenticated' })
		expect(res.headers['x-oc-sig']).toBeUndefined()
	})

	it('missing signing headers get 401', async () => {
		const client = await pair()
		const res = await request({ method: 'GET', path: '/v1/status', headers: baseHeaders({ 'X-OC-Client': client.clientId }) })
		expect(res.status).toBe(401)
		expect(ctx.backend.calls).toEqual([])
	})

	it('a bad signature gets 401, unsigned, and the handler never runs', async () => {
		// Signing it would hand anyone who knows a clientId an authentic-looking terminal
		// failure for a nonce of their choosing.
		const client = await pair()
		const { res } = await signed(client, 'GET', '/v1/status', undefined, { sig: b64url(randomBytes(32)) })
		expect(res.status).toBe(401)
		expect(res.json).toEqual({ error: 'bad_signature' })
		expect(res.headers['x-oc-sig']).toBeUndefined()
		expect(ctx.backend.calls).toEqual([])
	})

	it('missing signing headers after a known clientId get an unsigned 401', async () => {
		const client = await pair()
		const res = await request({
			method: 'GET',
			path: '/v1/status',
			headers: baseHeaders({ 'X-OC-Client': client.clientId, 'X-OC-Nonce': b64url(randomBytes(16)) }),
		})
		expect(res.status).toBe(401)
		expect(res.json).toEqual({ error: 'unauthenticated' })
		expect(res.headers['x-oc-sig']).toBeUndefined()
	})

	it('a signature over a different path or query does not verify', async () => {
		const client = await pair()
		const nonce = b64url(randomBytes(16))
		const headers = signedHeaders(client, 'GET', '/v1/status', Buffer.alloc(0), { nonce })
		const res = await request({ method: 'GET', path: '/v1/status?x=1', headers: baseHeaders(headers) })
		expect(res.status).toBe(401)
		expect(res.json).toEqual({ error: 'bad_signature' })
	})

	it('a bad signature is answered without reading the body', async () => {
		// Content-Length promises 200 KB and no body byte is ever sent. A server that read
		// before verifying would sit waiting for it; this one must answer at once.
		const client = await pair()
		const headers = signedHeaders(client, 'POST', '/v1/bundles', Buffer.alloc(0), {
			contentLength: '200000',
			bodySha256: 'a'.repeat(64),
			sig: b64url(randomBytes(32)),
		})
		const head = (h: Record<string, string>) => [
			'POST /v1/bundles HTTP/1.1',
			`Host: 127.0.0.1:${ctx.port}`,
			'X-OC-Proto: 1',
			'Content-Type: application/json',
			`Origin: ${ORIGIN}`,
			...Object.entries(h).map(([k, v]) => `${k}: ${v}`),
			'Content-Length: 200000',
			'', '',
		].join('\r\n')

		const started = Date.now()
		const reply = await rawExchange(head(headers), 3_000)
		expect(reply?.status).toBe(401)
		expect(JSON.parse(reply!.body)).toEqual({ error: 'bad_signature' })
		expect(Date.now() - started).toBeLessThan(1_000)

		// Control: the same request correctly signed *does* wait for its body.
		const good = signedHeaders(client, 'POST', '/v1/bundles', Buffer.alloc(0), {
			contentLength: '200000',
			bodySha256: 'a'.repeat(64),
		})
		expect(await rawExchange(head(good), 300)).toBeNull()
		expect(ctx.backend.calls).toEqual([])
	})

	it('a timestamp more than 60 s off gets 401 clock_skew', async () => {
		const client = await pair()
		for (const offset of [-60_001, 60_001]) {
			const { res, nonce } = await signed(client, 'GET', '/v1/status', undefined, { ts: String(ctx.clock.now + offset) })
			expect(res.status).toBe(401)
			expect(res.json).toEqual({ error: 'clock_skew' })
			expect(responseSigOk(client, res, nonce)).toBe(true)
		}
		const { res } = await signed(client, 'GET', '/v1/status', undefined, { ts: String(ctx.clock.now - 60_000) })
		expect(res.status).toBe(200)
	})

	it('an identical signed request replayed gets 401 replay', async () => {
		const client = await pair()
		const body = Buffer.from(JSON.stringify(manifest()))
		const headers = jsonHeaders(ORIGIN, signedHeaders(client, 'POST', '/v1/bundles', body))
		const first = await request({ method: 'POST', path: '/v1/bundles', headers, body })
		expect(first.status).toBe(200)
		const again = await request({ method: 'POST', path: '/v1/bundles', headers, body })
		expect(again.status).toBe(401)
		expect(again.json).toEqual({ error: 'replay' })
		expect(ctx.backend.bundles).toHaveLength(1)
	})

	it('a replay after the nonce window is still refused, by the clock', async () => {
		const client = await pair()
		const headers = baseHeaders(signedHeaders(client, 'GET', '/v1/status', Buffer.alloc(0)))
		expect((await request({ method: 'GET', path: '/v1/status', headers })).status).toBe(200)
		ctx.clock.now += 121_000
		const late = await request({ method: 'GET', path: '/v1/status', headers })
		expect(late.status).toBe(401)
		expect(late.json).toEqual({ error: 'clock_skew' })
	})

	it('a revoked client gets 401', async () => {
		const client = await pair()
		expect((await signed(client, 'GET', '/v1/status')).res.status).toBe(200)
		await ctx.pairing.revokeClient(client.clientId)
		ctx.server.forgetClient(client.clientId)
		const { res } = await signed(client, 'GET', '/v1/status')
		expect(res.status).toBe(401)
		expect(res.json).toEqual({ error: 'unauthenticated' })
		const hello = await request({
			method: 'POST',
			path: '/v1/hello',
			headers: jsonHeaders(),
			body: JSON.stringify({ clientId: client.clientId, clientNonce: b64url(randomBytes(16)) }),
		})
		expect(hello.status).toBe(401)
	})
})

describe('body handling', () => {
	it('a body whose digest differs from the signed one gets 422 hash_mismatch', async () => {
		const client = await pair()
		const signedBody = Buffer.from(JSON.stringify(manifest({ note: { text: 'AAAA' } })))
		const sentBody = Buffer.from(signedBody.toString().replace('AAAA', 'BBBB'))
		expect(sentBody.length).toBe(signedBody.length)
		const headers = signedHeaders(client, 'POST', '/v1/bundles', signedBody)
		const res = await request({ method: 'POST', path: '/v1/bundles', headers: jsonHeaders(ORIGIN, headers), body: sentBody })
		expect(res.status).toBe(422)
		expect(res.json).toEqual({ error: 'hash_mismatch' })
		expect(responseSigOk(client, res, headers['X-OC-Nonce'])).toBe(true)
		expect(ctx.backend.calls).toEqual([])
	})

	it('a body larger than declared (chunked, declared 0) gets 413 and nothing is kept', async () => {
		const client = await pair()
		const headers = signedHeaders(client, 'POST', '/v1/bundles', Buffer.alloc(0), { contentLength: '0' })
		const res = await request({
			method: 'POST',
			path: '/v1/bundles',
			headers: jsonHeaders(ORIGIN, { ...headers, 'Transfer-Encoding': 'chunked' }),
			chunks: [Buffer.from(JSON.stringify(manifest()))],
		})
		expect(res.status).toBe(413)
		expect(res.json).toEqual({ error: 'too_large' })
		expect(ctx.backend.calls).toEqual([])
	})

	it('a declared length over the 256 KB cap gets 413 before any body is sent', async () => {
		const client = await pair()
		const declared = String(MAX_CONTROL_BODY + 1)
		const headers = signedHeaders(client, 'POST', '/v1/bundles', Buffer.alloc(0), { contentLength: declared, bodySha256: 'b'.repeat(64) })
		const reply = await rawExchange([
			'POST /v1/bundles HTTP/1.1',
			`Host: 127.0.0.1:${ctx.port}`,
			'X-OC-Proto: 1',
			'Content-Type: application/json',
			`Origin: ${ORIGIN}`,
			...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
			`Content-Length: ${declared}`,
			'', '',
		].join('\r\n'), 3_000)
		expect(reply?.status).toBe(413)
		expect(JSON.parse(reply!.body)).toEqual({ error: 'too_large' })
		expect(ctx.backend.calls).toEqual([])
	})

	it('a GET may not carry a body', async () => {
		const client = await pair()
		const body = Buffer.from('{}')
		const headers = signedHeaders(client, 'GET', '/v1/status', body)
		// Node's client sends no length for a GET body unless told to.
		const res = await request({ method: 'GET', path: '/v1/status', headers: baseHeaders({ ...headers, 'Content-Length': '2' }), body })
		expect(res.json).toEqual({ error: 'too_large' })
		expect(res.status).toBe(413)
		expect(ctx.backend.calls).toEqual([])
	})

	it('malformed JSON gets 400 bad_json; an invalid manifest gets 422 with the field', async () => {
		const client = await pair()
		const body = Buffer.from('{"v":1,')
		const headers = signedHeaders(client, 'POST', '/v1/bundles', body)
		const bad = await request({ method: 'POST', path: '/v1/bundles', headers: jsonHeaders(ORIGIN, headers), body })
		expect(bad.status).toBe(400)
		expect(bad.json).toEqual({ error: 'bad_json' })

		const { res } = await signed(client, 'POST', '/v1/bundles', manifest({ page: { url: 'file:///etc/passwd', title: '' } }))
		expect(res.status).toBe(422)
		expect(res.json).toEqual({ error: 'invalid', detail: 'page.url: must be an http(s) URL' })

		// A highlight kind with no highlight payload is refused before the backend sees it.
		const highlight = await signed(client, 'POST', '/v1/bundles', manifest({ kind: 'highlight', note: undefined }))
		expect(highlight.res.status).toBe(422)
		expect(highlight.res.json).toEqual({ error: 'invalid', detail: 'highlight: must be an object' })
		expect(ctx.backend.calls).toEqual([])
	})
})

describe('backend outcomes', () => {
	it.each([
		['unknown_workspace', 404],
		['unlicensed', 403],
		['budget_exceeded', 507],
	] as const)('%s maps to %i, signed', async (error, status) => {
		const client = await pair()
		ctx.backend.next = { error }
		const { res, nonce } = await signed(client, 'POST', '/v1/bundles', manifest())
		expect(res.status).toBe(status)
		expect(res.json).toEqual({ error })
		expect(responseSigOk(client, res, nonce)).toBe(true)
	})

	it('passes a duplicate through', async () => {
		const client = await pair()
		const m = manifest()
		ctx.backend.next = { status: 'duplicate', bundleId: m.bundleId, receivedAt: '2025-01-01T00:00:00.000Z' }
		const { res } = await signed(client, 'POST', '/v1/bundles', m)
		expect(res.status).toBe(200)
		expect(res.json.status).toBe('duplicate')
	})

	it('a backend that throws gets 500, still signed', async () => {
		const client = await pair()
		ctx.backend.status = async () => { throw new Error('boom') }
		const { res, nonce } = await signed(client, 'GET', '/v1/status')
		expect(res.status).toBe(500)
		expect(res.json).toEqual({ error: 'internal' })
		expect(responseSigOk(client, res, nonce)).toBe(true)
	})

	it('unknown paths and wrong methods, once authenticated', async () => {
		const client = await pair()
		expect((await signed(client, 'GET', '/v1/nope')).res.status).toBe(404)
		expect((await signed(client, 'GET', '/v1/bundles')).res.status).toBe(405)
		expect((await signed(client, 'POST', '/v1/status', {})).res.status).toBe(405)
	})
})

describe('pairing over HTTP', () => {
	function pairBody(secret: Buffer, clientNonce = b64url(randomBytes(16))) {
		return JSON.stringify({
			pairingId: pairingIdFor(secret),
			clientNonce,
			extVersion: '1.0.0',
			proof: b64url(hmac(secret, pairProofString(clientNonce))),
		})
	}

	it('with no pairing active gets 403 pair_expired and reads nothing', async () => {
		const res = await request({ method: 'POST', path: '/v1/pair', headers: jsonHeaders(), body: '{}' })
		expect(res.status).toBe(403)
		expect(res.json).toEqual({ error: 'pair_expired' })
	})

	it('expires after five minutes', async () => {
		const { pairingString } = ctx.pairing.begin(ctx.port)
		ctx.clock.now += 5 * 60_000 + 1
		const res = await request({ method: 'POST', path: '/v1/pair', headers: jsonHeaders(), body: pairBody(parsePairingString(pairingString)!.pairSecret) })
		expect(res.status).toBe(403)
		expect(res.json).toEqual({ error: 'pair_expired' })
		expect(ctx.confirm).not.toHaveBeenCalled()
	})

	it('a bad proof gets 401 bad_signature', async () => {
		const { pairingString } = ctx.pairing.begin(ctx.port)
		const secret = parsePairingString(pairingString)!.pairSecret
		const body = JSON.parse(pairBody(secret))
		body.proof = b64url(randomBytes(32))
		const res = await request({ method: 'POST', path: '/v1/pair', headers: jsonHeaders(), body: JSON.stringify(body) })
		expect(res.status).toBe(401)
		expect(res.json).toEqual({ error: 'bad_signature' })
	})

	it('denied in the dialog gets 403 pair_denied', async () => {
		ctx.confirm.mockResolvedValueOnce(false)
		const { pairingString } = ctx.pairing.begin(ctx.port)
		const res = await request({ method: 'POST', path: '/v1/pair', headers: jsonHeaders(), body: pairBody(parsePairingString(pairingString)!.pairSecret) })
		expect(res.status).toBe(403)
		expect(res.json).toEqual({ error: 'pair_denied' })
		expect(ctx.pairing.listClients()).toEqual([])
	})

	it('is single use over HTTP too', async () => {
		const { pairingString } = ctx.pairing.begin(ctx.port)
		const body = pairBody(parsePairingString(pairingString)!.pairSecret)
		expect((await request({ method: 'POST', path: '/v1/pair', headers: jsonHeaders(), body })).status).toBe(200)
		const again = await request({ method: 'POST', path: '/v1/pair', headers: jsonHeaders(), body })
		expect(again.status).toBe(403)
		expect(again.json).toEqual({ error: 'pair_expired' })
	})

	it('re-pairing the same origin makes the old client 401', async () => {
		const first = await pair()
		const second = await pair()
		expect((await signed(first, 'GET', '/v1/status')).res.status).toBe(401)
		expect((await signed(second, 'GET', '/v1/status')).res.status).toBe(200)
	})

	it('is rate limited to 10 a minute', async () => {
		ctx.pairing.begin(ctx.port)
		const statuses: number[] = []
		for (let i = 0; i < 11; i++) {
			const body = JSON.stringify({ pairingId: 'f'.repeat(32), clientNonce: b64url(randomBytes(16)), extVersion: '1', proof: 'x' })
			statuses.push((await request({ method: 'POST', path: '/v1/pair', headers: jsonHeaders(), body })).status)
		}
		expect(statuses.slice(0, 10).every(s => s === 403)).toBe(true)
		expect(statuses[10]).toBe(429)
	})
})

describe('rate limits', () => {
	it('hello is limited to 10 a minute per client', async () => {
		const client = await pair()
		const statuses: number[] = []
		for (let i = 0; i < 11; i++) {
			const res = await request({
				method: 'POST',
				path: '/v1/hello',
				headers: jsonHeaders(),
				body: JSON.stringify({ clientId: client.clientId, clientNonce: b64url(randomBytes(16)) }),
			})
			statuses.push(res.status)
		}
		expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200))
		expect(statuses[10]).toBe(429)
		ctx.clock.now += 60_000
		const later = await request({
			method: 'POST',
			path: '/v1/hello',
			headers: jsonHeaders(),
			body: JSON.stringify({ clientId: client.clientId, clientNonce: b64url(randomBytes(16)) }),
		})
		expect(later.status).toBe(200)
	})

	it('bundles are limited to 20 a minute per client', async () => {
		const client = await pair()
		const statuses: number[] = []
		for (let i = 0; i < 21; i++) statuses.push((await signed(client, 'POST', '/v1/bundles', manifest())).res.status)
		expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200))
		expect(statuses[20]).toBe(429)
	})

	it('all requests are limited to 60 a second', async () => {
		const statuses: number[] = []
		for (let i = 0; i < 61; i++) statuses.push((await request({ method: 'GET', path: '/v1/status', headers: {} })).status)
		expect(statuses.slice(0, 60).every(s => s === 400)).toBe(true)
		expect(statuses[60]).toBe(429)
	})
})

describe('capture uploads', () => {
	const id = '0b7e7c1e-3f7a-4c56-9a3e-2d4f5b6c7d8e'

	async function upload(client: Client, name: string, body: Buffer, over: Parameters<typeof signedHeaders>[4] = {}, type = 'application/octet-stream') {
		const target = `/v1/bundles/${id}/files/${name}`
		const headers = signedHeaders(client, 'POST', target, body, over)
		return request({ method: 'POST', path: target, headers: baseHeaders({ 'Content-Type': type, Origin: client.origin, ...headers }), body })
	}

	it('streams a signed octet-stream body to the backend, and signs the reply', async () => {
		const client = await pair()
		const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(1000)])
		const target = `/v1/bundles/${id}/files/viewport.png`
		const headers = signedHeaders(client, 'POST', target, png)
		const res = await request({ method: 'POST', path: target, headers: baseHeaders({ 'Content-Type': 'application/octet-stream', Origin: client.origin, ...headers }), body: png })
		expect(res.status, res.raw.toString()).toBe(200)
		expect(res.json).toEqual({ received: true })
		expect(responseSigOk(client, res, headers['X-OC-Nonce'])).toBe(true)
		expect(ctx.backend.files).toHaveLength(1)
		expect(ctx.backend.files[0].upload).toEqual({ bundleId: id, name: 'viewport.png', size: png.length, sha256: sha256Hex(png) })
		expect(ctx.backend.files[0].bytes.equals(png)).toBe(true)
	})

	it('wants octet-stream for a file and JSON for the commit', async () => {
		const client = await pair()
		const body = Buffer.from('x')
		expect((await upload(client, 'viewport.png', body, {}, 'application/json')).json).toEqual({ error: 'bad_content_type' })
		expect((await upload(client, 'viewport.png', body, {}, 'text/plain')).json).toEqual({ error: 'bad_content_type' })
		const commit = await signed(client, 'POST', `/v1/bundles/${id}/commit`, {})
		expect(commit.res.status).toBe(200)
		expect(commit.res.json.status).toBe('accepted')
		const raw = Buffer.from('{}')
		const target = `/v1/bundles/${id}/commit`
		const wrong = await request({ method: 'POST', path: target, headers: baseHeaders({ 'Content-Type': 'application/octet-stream', Origin: client.origin, ...signedHeaders(client, 'POST', target, raw) }), body: raw })
		expect(wrong.json).toEqual({ error: 'bad_content_type' })
		expect(ctx.backend.files).toHaveLength(0)
	})

	it('refuses a name no capture carries, and a declared length over that name\'s cap, reading nothing', async () => {
		const client = await pair()
		const bad = await upload(client, 'evil.exe', Buffer.from('x'))
		expect(bad.status).toBe(422)
		expect(bad.json.error).toBe('invalid')
		const dotdot = await upload(client, '..%2F..%2Fx', Buffer.from('x'))
		expect(dotdot.status).toBe(422)
		// 25 MB + 1 declared for the PNG; nothing is sent past the headers.
		const over = await rawSigned(client, `/v1/bundles/${id}/files/viewport.png`, 25 * 1024 * 1024 + 1)
		expect(over?.status).toBe(413)
		expect(ctx.backend.calls).not.toContain('receiveFile')
	})

	it('checks the signature before reading a byte: a 40 MB body that is never sent gets 401 at once', async () => {
		const client = await pair()
		const started = Date.now()
		const reply = await rawSigned(client, `/v1/bundles/${id}/files/page.mhtml`, 40 * 1024 * 1024, { sig: b64url(randomBytes(32)) })
		expect(reply?.status).toBe(401)
		expect(JSON.parse(reply!.body)).toEqual({ error: 'bad_signature' })
		expect(reply!.headers['x-oc-sig']).toBeUndefined()
		expect(Date.now() - started).toBeLessThan(1500)
		expect(ctx.backend.calls).not.toContain('receiveFile')
	})

	it('an upload with a malformed bundle id is not found, and GET on an upload path is not allowed', async () => {
		const client = await pair()
		const target = '/v1/bundles/not-an-id/files/page.mhtml'
		const body = Buffer.from('x')
		const res = await request({ method: 'POST', path: target, headers: baseHeaders({ 'Content-Type': 'application/octet-stream', Origin: client.origin, ...signedHeaders(client, 'POST', target, body) }), body })
		expect(res.status).toBe(404)
		const get = await signed(client, 'GET', `/v1/bundles/${id}/commit`)
		expect(get.res.status).toBe(405)
	})

	/** Headers only, declaring `length` bytes that never follow; the reply or null. */
	function rawSigned(client: Client, target: string, length: number, over: { sig?: string } = {}) {
		const headers = signedHeaders(client, 'POST', target, Buffer.alloc(0), {
			contentLength: String(length),
			bodySha256: sha256Hex('something else'),
			...over,
		})
		const lines = [
			`POST ${target} HTTP/1.1`,
			`Host: 127.0.0.1:${ctx.port}`,
			'X-OC-Proto: 1',
			'Content-Type: application/octet-stream',
			`Origin: ${client.origin}`,
			`Content-Length: ${length}`,
			...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
		]
		return rawExchange(lines.join('\r\n') + '\r\n\r\n', 3000)
	}
})
