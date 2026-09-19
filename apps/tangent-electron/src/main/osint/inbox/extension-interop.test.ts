import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { IDBFactory } from 'fake-indexeddb'
import { startExtensionHarness, type ExtensionHarness } from './extension-harness'

/**
 * The two halves together: the app's real server and inbox (extension-harness.ts) driven
 * by the browser extension's real service-worker code -- its Channel, its send queue over
 * IndexedDB (fake-indexeddb here) and its manifest builder -- rather than by a client
 * written for the test. end-to-end.test.ts checks the app against PROTOCOL.md; this checks
 * it against what actually ships in the extension.
 *
 * The extension's sources are loaded through specifiers TypeScript does not follow: they
 * are built against chrome's types and their own tsconfig, and this folder is inside
 * `typecheck:osint`, which has neither. The shapes below are the parts used here.
 */
const extensionSrc = '../../../../../osint-copilot-extension/src'
const channelModule = `${extensionSrc}/sw/channel`
const queueModule = `${extensionSrc}/sw/queue`
const storageModule = `${extensionSrc}/sw/storage`
const manifestModule = `${extensionSrc}/shared/manifest`

type Manifest = { bundleId: string; workspaceId: string; kind: string; [k: string]: unknown }
type SendOutcome = { kind: 'delivered'; status: string } | { kind: 'transient' | 'permanent'; error: string }
interface PairingRecord { clientId: string; key: string; instanceId: string; port: number; pairingPort: number; pairedAt: number }
interface KV {
	get<T>(key: string): Promise<T | undefined>
	set(values: Record<string, unknown>): Promise<void>
	remove(keys: string | string[]): Promise<void>
}
interface Channel {
	pair(pairingString: string, extVersion: string): Promise<{ ok: true; port: number; connected: boolean; instanceId: string } | { ok: false; error: string }>
	hello(port: number): Promise<{ ok: boolean; reason?: string }>
	connect(): Promise<number>
	reset(): void
	request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }>
	readonly connectedPort: number | null
}
interface ChannelModule {
	Channel: new (deps: {
		fetch: (url: string, init: RequestInit) => Promise<Response>
		storage: KV
		now: () => number
		randomBytes: (n: number) => Uint8Array
	}) => Channel
	ChannelError: new (...args: any[]) => Error & { code: string }
}
interface Queue {
	enqueue(manifest: Manifest): Promise<unknown>
	drain(opts?: { force?: boolean }): Promise<void>
	list(): Promise<{ bundleId: string; state: string; lastError: string | null }[]>
}
interface QueueModule {
	Queue: new (deps: { indexedDB: IDBFactory; now: () => number; send: (m: Manifest) => Promise<SendOutcome> }) => Queue
	sendBundle(channel: Channel, manifest: Manifest): Promise<SendOutcome>
}
interface StorageModule {
	KEYS: { pairing: string }
	memoryKV(): KV
}
interface ManifestModule {
	buildManifest(input: unknown): { ok: true; value: Manifest } | { ok: false; detail: string }
}

/** The dev extension id the manifest's key pins; any [a-p]{32} id would do. */
const ORIGIN = 'chrome-extension://eokeefakkjidnblbahcdjobcpallgnfk'

/**
 * Node's fetch as Chrome's service worker would send it. Chrome adds the extension's
 * Origin to a POST by itself; node's fetch adds none, so this does, and only on POST,
 * as Chrome does. Everything else is the extension's own request.
 */
const extensionFetch = (url: string, init: RequestInit): Promise<Response> => {
	const headers = new Headers(init.headers)
	if (init.method === 'POST') headers.set('Origin', ORIGIN)
	return fetch(url, { ...init, headers })
}

/**
 * A process that grabbed another port and relays everything to the app, rewriting Host so
 * the app's Host check passes. Whatever it relays names the app's port, not its own.
 */
function startRelay(target: number): Promise<{ port: number; seen: string[]; close(): Promise<void> }> {
	const seen: string[] = []
	const server = http.createServer((req, res) => {
		seen.push(`${req.method} ${req.url}`)
		const headers = { ...req.headers, host: `127.0.0.1:${target}` }
		const upstream = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers, agent: false }, reply => {
			res.writeHead(reply.statusCode ?? 502, reply.headers)
			reply.pipe(res)
		})
		upstream.on('error', () => res.destroy())
		req.pipe(upstream)
	})
	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => resolve({
			port: (server.address() as AddressInfo).port,
			seen,
			close: () => new Promise<void>(done => server.close(() => done())),
		}))
	})
}

let harness: ExtensionHarness
let ext: { channel: ChannelModule; queue: QueueModule; storage: StorageModule; manifest: ManifestModule }

beforeAll(async () => {
	ext = {
		channel: await vi.importActual<ChannelModule>(channelModule),
		queue: await vi.importActual<QueueModule>(queueModule),
		storage: await vi.importActual<StorageModule>(storageModule),
		manifest: await vi.importActual<ManifestModule>(manifestModule),
	}
	harness = await startExtensionHarness()
})

afterAll(async () => {
	await harness?.stop()
})

describe('the extension\'s client against the app\'s server', () => {
	it('pairs, lists the case, queues an entity and a note into it, and a resend is a duplicate', async () => {
		const storage = ext.storage.memoryKV()
		const channel = new ext.channel.Channel({
			fetch: extensionFetch,
			storage,
			now: () => Date.now(),
			randomBytes: n => crypto.getRandomValues(new Uint8Array(n)),
		})

		// Pairing: the string as the app shows it, the app's confirm names our Origin, and
		// the channel proves the app with hello on the pairing port straight after.
		const paired = await channel.pair(await harness.pairingString(), '0.1.0')
		expect(paired).toEqual({ ok: true, instanceId: expect.any(String), port: harness.port, connected: true })
		expect(harness.confirmed).toEqual([ORIGIN])
		expect(channel.connectedPort).toBe(harness.port)
		expect(await channel.hello(harness.port)).toMatchObject({ ok: true })

		const listed = await channel.request('GET', '/v1/workspaces')
		expect(listed.status).toBe(200)
		expect(listed.body.workspaces).toEqual([{ id: expect.any(String), name: 'Case Alpha', open: true }])
		const workspaceId: string = listed.body.workspaces[0].id

		const status = await channel.request('GET', '/v1/status')
		expect(status).toEqual({ status: 200, body: { licensed: true, pendingCount: 0 } })

		// Items built the way the side panel builds them, sent through the durable queue.
		const page = { url: 'https://user:pw@example.com/team?x=1', title: 'Our team' }
		const entity = ext.manifest.buildManifest({
			kind: 'entity', workspaceId, page,
			entity: { kind: 'username', value: 'alice_01', platform: 'github.com', context: 'Maintainer' },
		})
		const note = ext.manifest.buildManifest({
			kind: 'note', workspaceId, page,
			note: { text: 'Line one\r\nLine two, with ünïcödé and 🙂' },
		})
		if (!entity.ok || !note.ok) throw new Error('the extension refused its own items')

		const queue = new ext.queue.Queue({
			indexedDB: new IDBFactory(),
			now: () => Date.now(),
			send: manifest => ext.queue.sendBundle(channel, manifest),
		})
		await queue.enqueue(entity.value)
		await queue.enqueue(note.value)
		await queue.drain({ force: true })
		// Both delivered: the queue drops an item only on 'accepted' or 'duplicate'.
		expect(await queue.list()).toEqual([])

		const pending = await harness.pending()
		expect(pending.map(p => p.bundleId).sort()).toEqual([entity.value.bundleId, note.value.bundleId].sort())
		for (const bundle of pending) {
			expect(bundle.macOk, `mac of ${bundle.bundleId}`).toBe(true)
			const sent = bundle.bundleId === entity.value.bundleId ? entity.value : note.value
			const { server, mac, ...manifest } = bundle.stored
			// What the app stored is exactly what the extension checked and queued.
			expect(manifest).toEqual(sent)
			expect(server).toMatchObject({ origin: ORIGIN, extVersion: '0.1.0' })
		}
		const storedNote = pending.find(p => p.bundleId === note.value.bundleId)!.stored as any
		expect(storedNote.page.url).toBe('https://example.com/team?x=1')
		expect(storedNote.note.text).toBe('Line one\nLine two, with ünïcödé and 🙂')

		// A retry after a lost reply reuses the bundleId, and the app says it has it.
		expect(await ext.queue.sendBundle(channel, entity.value)).toEqual({ kind: 'delivered', status: 'duplicate' })
		const again = await channel.request('POST', '/v1/bundles', note.value)
		expect(again.body).toMatchObject({ status: 'duplicate', bundleId: note.value.bundleId })
		expect((await harness.pending()).length).toBe(2)
		expect((await channel.request('GET', '/v1/status')).body.pendingCount).toBe(2)
	})

	it('refuses a relay squatting another port, and finds the app on its own port instead', async () => {
		const storage = ext.storage.memoryKV()
		const channel = new ext.channel.Channel({
			fetch: extensionFetch,
			storage,
			now: () => Date.now(),
			randomBytes: n => crypto.getRandomValues(new Uint8Array(n)),
		})
		const paired = await channel.pair(await harness.pairingString(), '0.1.0')
		expect(paired).toMatchObject({ ok: true, port: harness.port })

		const relay = await startRelay(harness.port)
		try {
			// hello through the relay: the app's proof names its own port, so it fails here.
			expect(await channel.hello(relay.port)).toEqual({ ok: false, reason: 'unverified' })
			expect(relay.seen).toEqual(['POST /v1/hello'])

			// The squatter's port remembered first (as if the app had once been there):
			// discovery tries it, rejects it, and settles on the pairing port.
			const record = await storage.get<PairingRecord>(ext.storage.KEYS.pairing)
			await storage.set({ [ext.storage.KEYS.pairing]: { ...record!, port: relay.port } })
			channel.reset()
			expect(await channel.connect()).toBe(harness.port)
			expect(relay.seen).toEqual(['POST /v1/hello', 'POST /v1/hello'])
			expect((await storage.get<PairingRecord>(ext.storage.KEYS.pairing))!.port).toBe(harness.port)

			// And a signed request that somehow went to the relay: signed for the relay's
			// port, so the app refuses it unsigned, and the extension takes that as no answer.
			;(channel as unknown as { verifiedPort: number }).verifiedPort = relay.port
			const refused = channel.request('GET', '/v1/status')
			await expect(refused).rejects.toBeInstanceOf(ext.channel.ChannelError)
			await expect(refused).rejects.toMatchObject({ code: 'unverified' })
			expect(relay.seen.at(-1)).toBe('GET /v1/status')
			expect(channel.connectedPort).toBeNull()
		} finally {
			await relay.close()
		}
	})
})
