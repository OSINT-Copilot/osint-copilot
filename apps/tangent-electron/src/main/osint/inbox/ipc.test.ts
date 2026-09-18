import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { InboxWriter } from './inbox-writer'
import { registerExtensionHandlers, registerInboxHandlers, type ExtensionControl, type InboxIpcEvent, type InboxSender } from './ipc'
import { workspaceIdFor } from '../extension/signing'
import type { Manifest } from '../extension/protocol'

/**
 * The renderer's side of the inbox. No channel takes a workspace, so what these pin is
 * that each sender only ever reaches the workspace of its own window, and that only the
 * lease holder may list, journal or settle.
 */

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osint-inbox-ipc-')))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

let nextId = 5000
type FakeSender = InboxSender & { destroy(): void }
function fakeSender(): FakeSender {
	const listeners: Array<() => void> = []
	let destroyed = false
	return {
		id: nextId++,
		isDestroyed: () => destroyed,
		once(_event: 'destroyed', listener: () => void) { listeners.push(listener) },
		destroy() {
			destroyed = true
			for (const l of listeners.splice(0)) l()
		},
	}
}

let n = 0
let ctx: {
	channels: Map<string, (event: InboxIpcEvent, ...args: any[]) => any>
	windows: Map<InboxSender, string>
	writer: InboxWriter
	a: string
	b: string
	idOf(root: string): string
}

beforeEach(() => {
	const a = path.join(dir, `${n}-A`)
	const b = path.join(dir, `${n++}-B`)
	fs.mkdirSync(a)
	fs.mkdirSync(b)
	const workspaceIdKey = randomBytes(32)
	const manifestKey = randomBytes(32)
	const writer = new InboxWriter({
		host: {
			knownRoots: () => [a, b],
			openRoots: () => [...ctx.windows.values()],
			documentationPath: () => null,
			notify: () => undefined,
		},
		keys: { workspaceIdKey: () => workspaceIdKey, manifestKey: () => manifestKey },
		licensed: async () => true,
	})
	const channels = new Map<string, (event: InboxIpcEvent, ...args: any[]) => any>()
	const windows = new Map<InboxSender, string>()
	registerInboxHandlers({
		handle: (channel, listener) => { channels.set(channel, listener) },
		inbox: async () => writer,
		workspacePathOf: sender => windows.get(sender) ?? null,
	})
	ctx = { channels, windows, writer, a, b, idOf: root => workspaceIdFor(workspaceIdKey, root) }
})

function call(sender: InboxSender, channel: string, ...args: unknown[]): Promise<any> {
	const listener = ctx.channels.get(channel)
	if (!listener) throw new Error(`no handler for ${channel}`)
	return Promise.resolve().then(() => listener({ sender }, ...args))
}

function windowOn(root: string): FakeSender {
	const sender = fakeSender()
	ctx.windows.set(sender, root)
	return sender
}

async function bundleIn(root: string): Promise<string> {
	const bundleId = randomUUID()
	const manifest = {
		v: 1, bundleId, workspaceId: ctx.idOf(root), kind: 'note',
		page: { url: 'https://example.com/', title: 'T' },
		clientTime: '2026-09-18T10:00:00.000Z', note: { text: `in ${path.basename(root)}` },
	} as Manifest
	const outcome = await ctx.writer.acceptBundle(manifest, {
		clientId: 'CCCCCCCCCCCCCCCCCCCCCC', origin: 'chrome-extension://' + 'a'.repeat(32),
		extVersion: '1.0.0', receivedAt: new Date().toISOString(), bodySha256: '0'.repeat(64),
	})
	expect(outcome).toMatchObject({ status: 'accepted' })
	return bundleId
}

describe('the inbox lease', () => {
	it('registers every inbox channel', () => {
		expect([...ctx.channels.keys()].sort()).toEqual([
			'osint:inbox.claim', 'osint:inbox.finish', 'osint:inbox.list', 'osint:inbox.listApplied', 'osint:inbox.markRemoved',
			'osint:inbox.release', 'osint:inbox.step',
		])
	})

	it('is exclusive per workspace, and independent across workspaces', async () => {
		const first = windowOn(ctx.a)
		const second = windowOn(ctx.a)
		const other = windowOn(ctx.b)
		expect(await call(first, 'osint:inbox.claim')).toEqual({ ok: true })
		expect(await call(second, 'osint:inbox.claim')).toEqual({ ok: false, reason: 'held' })
		expect(await call(other, 'osint:inbox.claim')).toEqual({ ok: true })
		// Claiming again is harmless for the holder.
		expect(await call(first, 'osint:inbox.claim')).toEqual({ ok: true })
	})

	it('is released when the holder\'s window is destroyed', async () => {
		const first = windowOn(ctx.a)
		const second = windowOn(ctx.a)
		await call(first, 'osint:inbox.claim')
		first.destroy()
		expect(await call(second, 'osint:inbox.claim')).toEqual({ ok: true })
	})

	it('is released on request, and a non-holder cannot release it', async () => {
		const first = windowOn(ctx.a)
		const second = windowOn(ctx.a)
		await call(first, 'osint:inbox.claim')
		await call(second, 'osint:inbox.release')
		expect(await call(second, 'osint:inbox.claim')).toEqual({ ok: false, reason: 'held' })
		await call(first, 'osint:inbox.release')
		expect(await call(second, 'osint:inbox.claim')).toEqual({ ok: true })
	})

	it('is lost when the holder\'s window moves to another workspace', async () => {
		const first = windowOn(ctx.a)
		const second = windowOn(ctx.a)
		await call(first, 'osint:inbox.claim')
		ctx.windows.set(first, ctx.b)
		expect(await call(second, 'osint:inbox.claim')).toEqual({ ok: true })
	})

	it('list, step and finish refuse a window that does not hold the lease', async () => {
		const holder = windowOn(ctx.a)
		const other = windowOn(ctx.a)
		const bundleId = await bundleIn(ctx.a)
		await call(holder, 'osint:inbox.claim')
		await expect(call(other, 'osint:inbox.list')).rejects.toThrow(/Another window/)
		await expect(call(other, 'osint:inbox.step', bundleId, 'entity', {})).rejects.toThrow(/Another window/)
		await expect(call(other, 'osint:inbox.finish', bundleId, 'done')).rejects.toThrow(/Another window/)
		expect((await call(holder, 'osint:inbox.list')).map((b: { bundleId: string }) => b.bundleId)).toEqual([bundleId])
	})

	it('refuses a window with no investigation open', async () => {
		const stray = fakeSender()
		await expect(call(stray, 'osint:inbox.claim')).rejects.toThrow(/no investigation/)
		const elsewhere = windowOn(path.join(dir, 'not-a-workspace'))
		await expect(call(elsewhere, 'osint:inbox.claim')).rejects.toThrow(/no investigation/)
	})
})

describe('a sender only ever reaches its own window\'s workspace', () => {
	it('two windows on two workspaces each see, journal and settle only their own bundles', async () => {
		const onA = windowOn(ctx.a)
		const onB = windowOn(ctx.b)
		const inA = await bundleIn(ctx.a)
		const inB = await bundleIn(ctx.b)
		await call(onA, 'osint:inbox.claim')
		await call(onB, 'osint:inbox.claim')

		expect((await call(onA, 'osint:inbox.list')).map((b: { bundleId: string }) => b.bundleId)).toEqual([inA])
		expect((await call(onB, 'osint:inbox.list')).map((b: { bundleId: string }) => b.bundleId)).toEqual([inB])

		// A names B's bundle: it is looked for in A's inbox only, and is not there.
		await expect(call(onA, 'osint:inbox.step', inB, 'entity', { x: 1 })).rejects.toThrow(/No pending or done bundle/)
		await expect(call(onA, 'osint:inbox.finish', inB, 'done')).rejects.toThrow(/No pending bundle/)
		expect(fs.existsSync(path.join(ctx.b, '.osint-inbox', 'pending', inB, 'state.json'))).toBe(false)
		expect(fs.existsSync(path.join(ctx.b, '.osint-inbox', 'pending', inB))).toBe(true)

		// Extra arguments naming a workspace are ignored: there is no such parameter.
		await call(onA, 'osint:inbox.step', inA, 'entity', { x: 1 }, ctx.b)
		expect(fs.existsSync(path.join(ctx.a, '.osint-inbox', 'pending', inA, 'state.json'))).toBe(true)
		await call(onA, 'osint:inbox.finish', inA, 'done')
		expect(fs.existsSync(path.join(ctx.a, '.osint-inbox', 'done', inA))).toBe(true)
		expect(await call(onB, 'osint:inbox.list')).toHaveLength(1)
	})
})

describe('osint:inbox.markRemoved', () => {
	const inbox = (root: string, state: string, id: string) => path.join(root, '.osint-inbox', state, id)

	it('moves an applied bundle from done to removed, from any window on that investigation', async () => {
		const holder = windowOn(ctx.a)
		const viewer = windowOn(ctx.a)
		const bundleId = await bundleIn(ctx.a)
		await call(holder, 'osint:inbox.claim')
		await call(holder, 'osint:inbox.finish', bundleId, 'done')

		// Remove is not lease-bound: the window showing the item may not be the one applying.
		await call(viewer, 'osint:inbox.markRemoved', bundleId)
		expect(fs.existsSync(inbox(ctx.a, 'done', bundleId))).toBe(false)
		expect(fs.existsSync(inbox(ctx.a, 'removed', bundleId))).toBe(true)
		await expect(call(viewer, 'osint:inbox.markRemoved', bundleId)).rejects.toThrow(/No done bundle/)
	})

	it('never drops a bundle that is still pending', async () => {
		const holder = windowOn(ctx.a)
		const bundleId = await bundleIn(ctx.a)
		await call(holder, 'osint:inbox.claim')
		await expect(call(holder, 'osint:inbox.markRemoved', bundleId)).rejects.toThrow(/No done bundle/)
		expect(fs.existsSync(inbox(ctx.a, 'pending', bundleId))).toBe(true)
	})

	it('reaches only the sender\'s own investigation, and checks its argument', async () => {
		const onA = windowOn(ctx.a)
		const onB = windowOn(ctx.b)
		const inB = await bundleIn(ctx.b)
		await call(onB, 'osint:inbox.claim')
		await call(onB, 'osint:inbox.finish', inB, 'done')

		await expect(call(onA, 'osint:inbox.markRemoved', inB)).rejects.toThrow(/No done bundle/)
		expect(fs.existsSync(inbox(ctx.b, 'done', inB))).toBe(true)
		await expect(call(onA, 'osint:inbox.markRemoved', { bundleId: inB })).rejects.toThrow(/bundle id/)
		await expect(call(onA, 'osint:inbox.markRemoved', '../done/x')).rejects.toThrow(/Not a bundle id/)
		await expect(call(fakeSender(), 'osint:inbox.markRemoved', inB)).rejects.toThrow(/no investigation/)
	})
})

describe('osint:inbox.listApplied', () => {
	it('is the activity log: done and removed bundles with their journals, the same for every window', async () => {
		const holder = windowOn(ctx.a)
		const viewer = windowOn(ctx.a)
		const kept = await bundleIn(ctx.a)
		const taken = await bundleIn(ctx.a)
		const waiting = await bundleIn(ctx.a)
		await call(holder, 'osint:inbox.claim')
		for (const id of [kept, taken]) {
			await call(holder, 'osint:inbox.step', id, 'applied', { entityId: null, created: false })
			await call(holder, 'osint:inbox.finish', id, 'done')
		}
		await call(viewer, 'osint:inbox.markRemoved', taken)

		// Not lease-bound: the viewer reads it too, and both read the same thing.
		const seen = await call(viewer, 'osint:inbox.listApplied')
		expect(await call(holder, 'osint:inbox.listApplied')).toEqual(seen)
		expect(seen.map((b: any) => [b.bundleId, b.where]).sort()).toEqual([[kept, 'done'], [taken, 'removed']].sort())
		expect(seen.map((b: any) => b.bundleId)).not.toContain(waiting)
		const removed = seen.find((b: any) => b.bundleId === taken)
		expect(removed.state.steps.map((s: any) => s.step)).toEqual(['applied', 'removed'])
		expect(removed.state.steps[0].data).toEqual({ entityId: null, created: false })
		expect(removed.manifest.note.text).toBe(`in ${path.basename(ctx.a)}`)
	})

	it('reaches only the sender\'s own investigation, and leaves out a tampered bundle', async () => {
		const onA = windowOn(ctx.a)
		const onB = windowOn(ctx.b)
		const inB = await bundleIn(ctx.b)
		const forged = await bundleIn(ctx.b)
		await call(onB, 'osint:inbox.claim')
		await call(onB, 'osint:inbox.finish', inB, 'done')
		await call(onB, 'osint:inbox.finish', forged, 'done')
		const file = path.join(ctx.b, '.osint-inbox', 'done', forged, 'manifest.json')
		const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
		stored.note.text = 'something else'
		fs.writeFileSync(file, JSON.stringify(stored))

		expect(await call(onA, 'osint:inbox.listApplied')).toEqual([])
		expect((await call(onB, 'osint:inbox.listApplied')).map((b: any) => b.bundleId)).toEqual([inB])
		// Left where it is: it was applied, and moving it would hide nothing.
		expect(fs.existsSync(file)).toBe(true)
		await expect(call(fakeSender(), 'osint:inbox.listApplied')).rejects.toThrow(/no investigation/)
	})
})

describe('extension settings channels', () => {
	function register(control: () => Promise<ExtensionControl>) {
		const channels = new Map<string, (event: InboxIpcEvent, ...args: any[]) => any>()
		registerExtensionHandlers({ handle: (c, l) => { channels.set(c, l) }, control })
		return (channel: string, ...args: unknown[]) => Promise.resolve().then(() => channels.get(channel)!({ sender: fakeSender() }, ...args))
	}

	const status = { enabled: true, running: true, port: 23760, licensed: true, secretsEncrypted: true, clients: [] }

	it('forwards to the controller and checks argument types', async () => {
		const calls: unknown[][] = []
		const control: ExtensionControl = {
			status: async () => status,
			setEnabled: async (enabled: boolean) => { calls.push(['setEnabled', enabled]); return status },
			pairBegin: async () => ({ pairingString: 'ocpair1.x', expiresAt: 1 }),
			pairCancel: () => { calls.push(['pairCancel']) },
			revoke: async (id: string) => { calls.push(['revoke', id]); return true },
		}
		const invoke = register(async () => control)
		expect(await invoke('osint:extension.status')).toEqual(status)
		await invoke('osint:extension.setEnabled', false)
		await expect(invoke('osint:extension.setEnabled', 'yes')).rejects.toThrow(/boolean/)
		expect(await invoke('osint:extension.pairBegin')).toEqual({ pairingString: 'ocpair1.x', expiresAt: 1 })
		await invoke('osint:extension.pairCancel')
		await invoke('osint:extension.revoke', 'CCCCCCCCCCCCCCCCCCCCCC')
		await expect(invoke('osint:extension.revoke', { clientId: 1 })).rejects.toThrow(/client id/)
		expect(calls).toEqual([['setEnabled', false], ['pairCancel'], ['revoke', 'CCCCCCCCCCCCCCCCCCCCCC']])
	})

	it('status still answers, naming the problem, when the channel could not be set up', async () => {
		const invoke = register(() => Promise.reject(new Error('osint-extension.secrets could not be decrypted')))
		expect(await invoke('osint:extension.status')).toMatchObject({
			enabled: false, running: false, problem: 'osint-extension.secrets could not be decrypted',
		})
	})
})
