import { describe, it, expect, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomBytes, randomUUID } from 'crypto'
import { InboxWriter, INBOX_CHANGED_CHANNEL, type InboxHost, type InboxWriterDeps } from './inbox-writer'
import { verifySealedManifest } from './manifest-mac'
import { workspaceIdFor } from '../extension/signing'
import type { BundleContext } from '../extension/server'
import type { Manifest } from '../extension/protocol'

/**
 * The inbox is where page content from the extension first touches a workspace. These
 * pin that only a keyed id reaches a workspace, that a bundle lands whole or not at all,
 * that nothing is written when the answer is no, and that a bundle main did not write is
 * never handed to the renderer.
 */

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osint-inbox-')))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

let n = 0
function freshDir(name: string): string {
	const p = path.join(dir, `${n++}-${name}`)
	fs.mkdirSync(p, { recursive: true })
	return p
}

interface Setup {
	writer: InboxWriter
	host: InboxHost & { known: string[]; open: string[]; notify: ReturnType<typeof vi.fn> }
	keys: { workspaceIdKey(): Buffer; manifestKey(): Buffer }
	docs: string
	idOf(root: string): string
}

function setup(over: Partial<InboxWriterDeps> & { known?: string[]; open?: string[]; licensed?: () => Promise<boolean> } = {}): Setup {
	const workspaceIdKey = randomBytes(32)
	const manifestKey = randomBytes(32)
	const keys = { workspaceIdKey: () => workspaceIdKey, manifestKey: () => manifestKey }
	const docs = freshDir('Documentation')
	const host = {
		known: [...(over.known ?? []), docs],
		open: over.open ?? [],
		knownRoots() { return this.known },
		openRoots() { return this.open },
		documentationPath: () => docs,
		notify: vi.fn(),
	}
	const writer = new InboxWriter({
		host,
		keys,
		licensed: over.licensed ?? (async () => true),
		...over,
	})
	return { writer, host, keys, docs, idOf: root => workspaceIdFor(workspaceIdKey, fs.realpathSync.native(root)) }
}

function entityManifest(workspaceId: string, over: Partial<Manifest> = {}): Manifest {
	return {
		v: 1,
		bundleId: randomUUID(),
		workspaceId,
		kind: 'entity',
		page: { url: 'https://example.com/profile', title: 'Profile' },
		clientTime: '2026-09-18T10:00:00.000Z',
		entity: { kind: 'email', value: 'alice@example.com' },
		...over,
	} as Manifest
}

function ctx(over: Partial<BundleContext> = {}): BundleContext {
	return {
		clientId: 'CCCCCCCCCCCCCCCCCCCCCC',
		origin: 'chrome-extension://' + 'a'.repeat(32),
		extVersion: '1.0.0',
		receivedAt: '2026-09-18T10:00:01.000Z',
		bodySha256: '0'.repeat(64),
		...over,
	}
}

/** Every path under `root`, for "nothing was written" checks. */
function tree(root: string): string[] {
	if (!fs.existsSync(root)) return []
	const out: string[] = []
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name)
			out.push(path.relative(root, p))
			if (e.isDirectory()) walk(p)
		}
	}
	walk(root)
	return out.sort()
}

const inboxOf = (root: string) => path.join(root, '.osint-inbox')

describe('which investigations exist', () => {
	it('lists known workspaces by keyed id and basename, marks the open ones, and never the documentation', async () => {
		const a = freshDir('Case A')
		const b = freshDir('Case B')
		const s = setup({ known: [a, b], open: [b] })
		const list = await s.writer.listWorkspaces()
		expect(list).toEqual([
			{ id: s.idOf(a), name: path.basename(a), open: false },
			{ id: s.idOf(b), name: path.basename(b), open: true },
		])
		expect(list.map(w => w.id)).not.toContain(s.idOf(s.docs))
		expect(JSON.stringify(list)).not.toContain(dir)
	})

	it('the documentation workspace is never resolvable, even by its correct id', async () => {
		const s = setup()
		expect(await s.writer.resolveInboxTarget(s.idOf(s.docs))).toBeNull()
		const outcome = await s.writer.acceptBundle(entityManifest(s.idOf(s.docs)), ctx())
		expect(outcome).toEqual({ error: 'unknown_workspace' })
		expect(fs.existsSync(inboxOf(s.docs))).toBe(false)
	})

	it('answers unknown_workspace for an id nobody has, writing nothing', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a] })
		const outcome = await s.writer.acceptBundle(entityManifest('AAAAAAAAAAAAAAAAAAAAAA'), ctx())
		expect(outcome).toEqual({ error: 'unknown_workspace' })
		expect(tree(a)).toEqual([])
	})

	it('resolves a workspace registered through a symlink to its real path', async () => {
		const real = freshDir('Real case')
		const link = path.join(dir, `${n++}-link`)
		fs.symlinkSync(real, link)
		const s = setup({ known: [link], open: [link] })
		const [only] = await s.writer.listWorkspaces()
		expect(only).toEqual({ id: workspaceIdFor(s.keys.workspaceIdKey(), real), name: path.basename(real), open: true })
		expect(await s.writer.resolveInboxTarget(only.id)).toBe(real)
		// The same folder registered twice is one investigation.
		s.host.known.push(real)
		expect(await s.writer.listWorkspaces()).toHaveLength(1)
	})

	it('refuses a raw path where an id belongs', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a] })
		expect(await s.writer.resolveInboxTarget(a)).toBeNull()
		expect(await s.writer.resolveInboxTarget('../../etc')).toBeNull()
		const outcome = await s.writer.acceptBundle(entityManifest(a), ctx())
		expect(outcome).toMatchObject({ error: 'invalid' })
		expect(tree(a)).toEqual([])
	})

	it('does not treat a sibling that shares a prefix as the same workspace', async () => {
		const a = freshDir('case')
		const ab = `${a}b`
		fs.mkdirSync(ab)
		const s = setup({ known: [a] })
		expect(await s.writer.investigationRootFor(ab)).toBeNull()
		expect(await s.writer.investigationRootFor(a)).toBe(a)
	})
})

describe('accepting a bundle', () => {
	it('stores the validated manifest with the server stamp and a MAC that verifies, and tells the windows', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a] })
		const m = entityManifest(s.idOf(a))
		const outcome = await s.writer.acceptBundle(m, ctx())
		expect(outcome).toEqual({ status: 'accepted', bundleId: m.bundleId, receivedAt: '2026-09-18T10:00:01.000Z' })

		const file = path.join(inboxOf(a), 'pending', m.bundleId, 'manifest.json')
		const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
		expect(stored).toMatchObject({ ...m, server: {
			receivedAt: '2026-09-18T10:00:01.000Z',
			clientId: 'CCCCCCCCCCCCCCCCCCCCCC',
			origin: 'chrome-extension://' + 'a'.repeat(32),
			extVersion: '1.0.0',
		} })
		expect(Object.keys(stored.server).sort()).toEqual(['clientId', 'extVersion', 'origin', 'receivedAt'])
		expect(verifySealedManifest(s.keys.manifestKey(), stored)).toBe(true)
		expect(fs.readdirSync(path.join(inboxOf(a), '.staging'))).toEqual([])
		expect(s.host.notify).toHaveBeenCalledWith(a, INBOX_CHANGED_CHANNEL)
	})

	for (const settled of ['pending', 'done', 'rejected', 'removed'] as const) {
		it(`answers duplicate for a bundleId already in ${settled}/, writing nothing`, async () => {
			const a = freshDir('Case')
			const s = setup({ known: [a] })
			const m = entityManifest(s.idOf(a))
			await s.writer.acceptBundle(m, ctx())
			if (settled === 'removed') {
				await s.writer.finish(a, m.bundleId, 'done')
				await s.writer.markRemoved(a, m.bundleId)
			} else if (settled !== 'pending') {
				await s.writer.finish(a, m.bundleId, settled)
			}
			const before = tree(inboxOf(a))
			s.host.notify.mockClear()

			const again = await s.writer.acceptBundle(m, ctx({ receivedAt: '2026-09-18T11:00:00.000Z' }))
			expect(again).toEqual({ status: 'duplicate', bundleId: m.bundleId, receivedAt: '2026-09-18T10:00:01.000Z' })
			expect(tree(inboxOf(a))).toEqual(before)
			expect(s.host.notify).not.toHaveBeenCalled()
		})
	}

	it('refuses with unlicensed and writes nothing, not even the inbox folder', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a], licensed: async () => false })
		expect(await s.writer.acceptBundle(entityManifest(s.idOf(a)), ctx())).toEqual({ error: 'unlicensed' })
		expect(tree(a)).toEqual([])
	})

	it('refuses with budget_exceeded once the inbox is full, and writes no bundle', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a], budgetBytes: 2_000 })
		expect(await s.writer.acceptBundle(entityManifest(s.idOf(a)), ctx())).toMatchObject({ status: 'accepted' })
		const before = tree(inboxOf(a))
		const big = entityManifest(s.idOf(a), { kind: 'note', note: { text: 'x'.repeat(5_000) } } as Partial<Manifest>)
		delete (big as { entity?: unknown }).entity
		expect(await s.writer.acceptBundle(big, ctx())).toEqual({ error: 'budget_exceeded' })
		expect(tree(inboxOf(a))).toEqual(before)
	})

	it('sees room freed outside the app before refusing, rather than trusting its running total', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a], budgetBytes: 4_000 })
		fs.mkdirSync(path.join(inboxOf(a), 'done'), { recursive: true })
		const filler = path.join(inboxOf(a), 'done', 'filler')
		fs.writeFileSync(filler, 'x'.repeat(3_800))
		expect(await s.writer.acceptBundle(entityManifest(s.idOf(a)), ctx())).toEqual({ error: 'budget_exceeded' })
		// The user clears done/ by hand; the total cached at the refusal is now too high.
		fs.rmSync(filler)
		expect(await s.writer.acceptBundle(entityManifest(s.idOf(a)), ctx())).toMatchObject({ status: 'accepted' })
	})

	it('refuses to write through a symlink planted at .osint-inbox', async () => {
		const a = freshDir('Case')
		const elsewhere = freshDir('elsewhere')
		fs.symlinkSync(elsewhere, inboxOf(a))
		const s = setup({ known: [a] })
		await expect(s.writer.acceptBundle(entityManifest(s.idOf(a)), ctx())).rejects.toThrow(/not a folder inside the workspace/)
		expect(tree(elsewhere).filter(p => p.includes(path.sep))).toEqual([])
	})
})

describe('staging', () => {
	it('a crash between the staging write and the rename leaves nothing pending, and the sweep clears it', async () => {
		const a = freshDir('Case')
		let renameCalled!: () => void
		const reachedRename = new Promise<void>(r => { renameCalled = r })
		// The "crash": the rename never happens.
		const crashed = setup({ known: [a], rename: () => { renameCalled(); return new Promise<void>(() => undefined) } })
		const m = entityManifest(crashed.idOf(a))
		void crashed.writer.acceptBundle(m, ctx())
		await reachedRename

		const staged = path.join(inboxOf(a), '.staging', m.bundleId)
		expect(fs.existsSync(path.join(staged, 'manifest.json'))).toBe(true)
		expect(fs.readdirSync(path.join(inboxOf(a), 'pending'))).toEqual([])

		// The next run: an hour is not up yet, so a live write would be left alone...
		const soon = new InboxWriter({ host: crashed.host, keys: crashed.keys, licensed: async () => true })
		expect(await soon.sweepStaging(a)).toBe(0)
		expect(fs.existsSync(staged)).toBe(true)
		// ...and once it is, the leftover goes.
		const later = new InboxWriter({ host: crashed.host, keys: crashed.keys, licensed: async () => true, now: () => Date.now() + 2 * 3600_000 })
		expect(await later.sweepStaging(a)).toBe(1)
		expect(fs.readdirSync(path.join(inboxOf(a), '.staging'))).toEqual([])
		expect(await later.listPending(a)).toEqual([])
	})

	it('sweeps on every server start, not once per writer', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a], now: () => Date.now() + 2 * 3600_000 })
		await s.writer.sweepAll()
		// A write that dies while the server runs, found by the next start.
		const staged = path.join(inboxOf(a), '.staging', randomUUID())
		fs.mkdirSync(staged, { recursive: true })
		await s.writer.sweepAll()
		expect(fs.existsSync(staged)).toBe(false)
	})

	it('retries a rename that Windows refuses with EPERM, then commits', async () => {
		const a = freshDir('Case')
		let failures = 2
		const s = setup({ known: [a], rename: async (from, to) => {
			if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' })
			await fs.promises.rename(from, to)
		} })
		const m = entityManifest(s.idOf(a))
		expect(await s.writer.acceptBundle(m, ctx())).toMatchObject({ status: 'accepted' })
		expect(fs.existsSync(path.join(inboxOf(a), 'pending', m.bundleId, 'manifest.json'))).toBe(true)
	})
})

describe('listing for the renderer', () => {
	async function acceptOne(s: Setup, root: string, over: Partial<Manifest> = {}) {
		const m = entityManifest(s.idOf(root), over)
		await s.writer.acceptBundle(m, ctx())
		return { m, file: path.join(inboxOf(root), 'pending', m.bundleId, 'manifest.json') }
	}

	const tamperings: Array<[string, (stored: any) => void]> = [
		['the page title', stored => { stored.page.title = 'Something else' }],
		['the entity value', stored => { stored.entity.value = 'mallory@example.com' }],
		['the server stamp', stored => { stored.server.clientId = 'DDDDDDDDDDDDDDDDDDDDDD' }],
		['an added field', stored => { stored.extra = true }],
		['the MAC itself', stored => { stored.mac = stored.mac.slice(0, -2) + (stored.mac.endsWith('AA') ? 'AB' : 'AA') }],
	]

	for (const [what, tamper] of tamperings) {
		it(`quarantines a bundle whose ${what} was changed, and does not return it`, async () => {
			const a = freshDir('Case')
			const s = setup({ known: [a] })
			const good = await acceptOne(s, a)
			const bad = await acceptOne(s, a)
			const stored = JSON.parse(fs.readFileSync(bad.file, 'utf8'))
			tamper(stored)
			fs.writeFileSync(bad.file, JSON.stringify(stored))

			const listed = await s.writer.listPending(a)
			expect(listed.map(b => b.bundleId)).toEqual([good.m.bundleId])
			expect(listed[0].manifest).toEqual(good.m)
			expect(listed[0].server.receivedAt).toBe('2026-09-18T10:00:01.000Z')
			expect(fs.existsSync(path.dirname(bad.file))).toBe(false)
			const reason = JSON.parse(fs.readFileSync(path.join(inboxOf(a), 'rejected', bad.m.bundleId, 'reason.json'), 'utf8'))
			expect(typeof reason.reason).toBe('string')
		})
	}

	it('quarantines a bundle written with another install\'s key, and one that is not a bundle at all', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a] })
		const other = setup({ known: [a] })
		// Same folder, a different manifestKey: to this writer, a forgery.
		const forged = entityManifest(other.idOf(a))
		await other.writer.acceptBundle({ ...forged, workspaceId: other.idOf(a) }, ctx())
		fs.mkdirSync(path.join(inboxOf(a), 'pending', 'not-a-bundle'))

		expect(await s.writer.listPending(a)).toEqual([])
		const rejected = fs.readdirSync(path.join(inboxOf(a), 'rejected'))
		expect(rejected).toContain(forged.bundleId)
		expect(rejected.some(name => name.startsWith('invalid-'))).toBe(true)
		expect(fs.readdirSync(path.join(inboxOf(a), 'pending'))).toEqual([])
	})

	it('skips a bundle it cannot read just now, and lists it once it can, never quarantining it', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a] })
		const good = await acceptOne(s, a)
		const locked = await acceptOne(s, a)
		// As antivirus or a sync client can: EACCES for a moment, then fine.
		fs.chmodSync(locked.file, 0o000)
		try {
			expect((await s.writer.listPending(a)).map(b => b.bundleId)).toEqual([good.m.bundleId])
			expect(fs.existsSync(locked.file)).toBe(true)
			expect(fs.readdirSync(path.join(inboxOf(a), 'rejected'))).toEqual([])
		}
		finally {
			fs.chmodSync(locked.file, 0o600)
		}
		expect((await s.writer.listPending(a)).map(b => b.bundleId).sort())
			.toEqual([good.m.bundleId, locked.m.bundleId].sort())
	})

	it('a bundle that cannot be moved to rejected/ does not hide the good ones', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a], rename: async (from, to) => {
			if (to.includes(`${path.sep}rejected${path.sep}`)) throw Object.assign(new Error('denied'), { code: 'EACCES' })
			await fs.promises.rename(from, to)
		} })
		const good = await acceptOne(s, a)
		fs.mkdirSync(path.join(inboxOf(a), 'pending', 'not-a-bundle'))
		expect((await s.writer.listPending(a)).map(b => b.bundleId)).toEqual([good.m.bundleId])
		expect(fs.existsSync(path.join(inboxOf(a), 'pending', 'not-a-bundle'))).toBe(true)
	})

	it('does not follow a symlink planted as manifest.json', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a] })
		const { file } = await acceptOne(s, a)
		const outside = path.join(freshDir('outside'), 'secret.json')
		fs.writeFileSync(outside, fs.readFileSync(file))
		fs.rmSync(file)
		fs.symlinkSync(outside, file)
		expect(await s.writer.listPending(a)).toEqual([])
	})

	it('journals steps in state.json, merging a repeated step, and returns them with the bundle', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a] })
		const { m } = await acceptOne(s, a)
		await s.writer.recordStep(a, m.bundleId, 'entity', { created: 'OSINTCopilot/Email/alice.md' })
		await s.writer.recordStep(a, m.bundleId, 'source', { sourceId: 's1' })
		const state = await s.writer.recordStep(a, m.bundleId, 'entity', { merged: false })
		expect(state.steps.map(step => step.step)).toEqual(['entity', 'source'])
		expect(state.steps[0].data).toEqual({ created: 'OSINTCopilot/Email/alice.md', merged: false })

		const [listed] = await s.writer.listPending(a)
		expect(listed.state).toEqual(state)
	})

	it('refuses a step or finish for a bundle id that is not one, or not there', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a] })
		await expect(s.writer.recordStep(a, '../../x', 'entity', {})).rejects.toThrow(/Not a bundle id/)
		await expect(s.writer.recordStep(a, randomUUID(), 'entity', {})).rejects.toThrow(/No pending or done bundle/)
		const { m } = await acceptOne(s, a)
		await expect(s.writer.recordStep(a, m.bundleId, '../state', {})).rejects.toThrow(/Not a step name/)
		await expect(s.writer.finish(a, m.bundleId, 'elsewhere' as never)).rejects.toThrow(/Not an outcome/)
		await expect(s.writer.finish(a, m.bundleId, 'removed' as never)).rejects.toThrow(/Not an outcome/)
	})

	it('finish moves a bundle out of pending and tells the windows', async () => {
		const a = freshDir('Case')
		const s = setup({ known: [a] })
		const { m } = await acceptOne(s, a)
		s.host.notify.mockClear()
		await s.writer.finish(a, m.bundleId, 'done')
		expect(await s.writer.listPending(a)).toEqual([])
		expect(fs.existsSync(path.join(inboxOf(a), 'done', m.bundleId, 'manifest.json'))).toBe(true)
		expect(s.host.notify).toHaveBeenCalledWith(a, INBOX_CHANGED_CHANNEL)
		await expect(s.writer.finish(a, m.bundleId, 'done')).rejects.toThrow()
	})

	it('counts pending bundles across investigations for /v1/status', async () => {
		const a = freshDir('A')
		const b = freshDir('B')
		const s = setup({ known: [a, b] })
		await acceptOne(s, a)
		await acceptOne(s, b)
		await acceptOne(s, b)
		expect(await s.writer.status()).toEqual({ licensed: true, pendingCount: 3 })
	})
})
