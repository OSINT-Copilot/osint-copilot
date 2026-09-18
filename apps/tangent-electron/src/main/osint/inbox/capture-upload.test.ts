import { describe, it, expect, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { Readable } from 'stream'
import { InboxWriter, type InboxWriterDeps } from './inbox-writer'
import { verifySealedManifest } from './manifest-mac'
import { workspaceIdFor } from '../extension/signing'
import type { BundleContext } from '../extension/server'
import type { CaptureFileName, CaptureManifest } from '../extension/protocol'

/**
 * A capture arrives in three steps -- create, one request per file, commit -- and every
 * refusal along the way must leave nothing under a file's real name. These drive the
 * inbox writer directly, with bodies as streams; capture-server.test.ts drives the same
 * steps over HTTP.
 */

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osint-capture-')))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

let n = 0
function freshDir(name: string): string {
	const p = path.join(dir, `${n++}-${name}`)
	fs.mkdirSync(p, { recursive: true })
	return p
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

const MHTML = fs.readFileSync(path.join(__dirname, '..', 'capture', 'fixtures', 'blink-page.mhtml'))
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), randomBytes(2000)])
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(500)])

const keysFor = () => {
	const workspaceIdKey = randomBytes(32)
	const manifestKey = randomBytes(32)
	return { workspaceIdKey: () => workspaceIdKey, manifestKey: () => manifestKey }
}

function setup(over: Partial<InboxWriterDeps> = {}) {
	const root = freshDir('Case')
	const keys = over.keys ?? keysFor()
	const derive = vi.fn()
	const deps: InboxWriterDeps = {
		host: {
			knownRoots: () => [root],
			openRoots: () => [root],
			documentationPath: () => null,
			notify: vi.fn(),
		},
		keys,
		licensed: async () => true,
		derive,
		...over,
	}
	const writer = new InboxWriter(deps)
	return { writer, root, keys, derive, deps, id: workspaceIdFor(keys.workspaceIdKey(), root) }
}

function captureManifest(workspaceId: string, files: Partial<Record<CaptureFileName, Buffer>>, over: Partial<CaptureManifest> = {}): CaptureManifest {
	const declared: Record<string, { size: number; sha256: string }> = {}
	for (const [name, bytes] of Object.entries(files)) declared[name] = { size: bytes!.length, sha256: sha(bytes!) }
	return {
		v: 1,
		bundleId: randomUUID(),
		workspaceId,
		kind: 'capture',
		page: { url: 'https://news.example/2026/09/cafe-owner?ref=home', title: 'Café owner' },
		clientTime: '2026-09-18T10:00:00.000Z',
		capture: { files: declared as CaptureManifest['capture']['files'] },
		...over,
	}
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

/** A body as the server hands it on: an async iterable of chunks. */
function body(bytes: Buffer, chunk = 777): Readable {
	const chunks: Buffer[] = []
	for (let i = 0; i < bytes.length; i += chunk) chunks.push(bytes.subarray(i, i + chunk))
	return Readable.from(chunks)
}

function send(writer: InboxWriter, bundleId: string, name: CaptureFileName, bytes: Buffer, over: { size?: number; sha256?: string; body?: AsyncIterable<Buffer> } = {}, c = ctx()) {
	return writer.receiveFile({
		bundleId,
		name,
		size: over.size ?? bytes.length,
		sha256: over.sha256 ?? sha(bytes),
		body: over.body ?? body(bytes),
	}, c)
}

const inboxOf = (root: string) => path.join(root, '.osint-inbox')
const stagingOf = (root: string, id: string) => path.join(inboxOf(root), '.staging', id)
const pendingOf = (root: string, id: string) => path.join(inboxOf(root), 'pending', id)

describe('capture upload', () => {
	it('create, two files, commit: pending holds the files and a manifest whose MAC covers their hashes', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'page.mhtml': MHTML, 'viewport.png': PNG })
		expect(await s.writer.acceptBundle(m, ctx())).toEqual({ status: 'created', bundleId: m.bundleId, missing: ['page.mhtml', 'viewport.png'] })
		expect(fs.existsSync(path.join(stagingOf(s.root, m.bundleId), 'upload.json'))).toBe(true)

		expect(await send(s.writer, m.bundleId, 'page.mhtml', MHTML)).toEqual({ received: true })
		expect(await s.writer.acceptBundle(m, ctx())).toEqual({ status: 'created', bundleId: m.bundleId, missing: ['viewport.png'] })
		expect(await send(s.writer, m.bundleId, 'viewport.png', PNG)).toEqual({ received: true })

		expect(await s.writer.commitBundle(m.bundleId, ctx({ receivedAt: '2026-09-18T10:05:00.000Z' })))
			.toEqual({ status: 'accepted', bundleId: m.bundleId, receivedAt: '2026-09-18T10:00:01.000Z' })
		expect(fs.existsSync(stagingOf(s.root, m.bundleId))).toBe(false)
		const pending = pendingOf(s.root, m.bundleId)
		expect(fs.readdirSync(pending).sort()).toEqual(['manifest.json', 'page.mhtml', 'upload.json', 'viewport.png'])
		expect(fs.readFileSync(path.join(pending, 'page.mhtml')).equals(MHTML)).toBe(true)

		const stored = JSON.parse(fs.readFileSync(path.join(pending, 'manifest.json'), 'utf8'))
		expect(verifySealedManifest(s.keys.manifestKey(), stored)).toBe(true)
		expect(stored.server.files).toEqual({
			'page.mhtml': { size: MHTML.length, sha256: sha(MHTML) },
			'viewport.png': { size: PNG.length, sha256: sha(PNG) },
		})
		// The hashes are under the MAC: change one and it no longer verifies.
		stored.server.files['viewport.png'].sha256 = sha(Buffer.from('other'))
		expect(verifySealedManifest(s.keys.manifestKey(), stored)).toBe(false)

		expect(s.derive).toHaveBeenCalledWith(s.root, m.bundleId)
	})

	it('a pending capture is not listed until it is derived, and listing asks for it', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'page.mhtml': MHTML })
		await s.writer.acceptBundle(m, ctx())
		await send(s.writer, m.bundleId, 'page.mhtml', MHTML)
		await s.writer.commitBundle(m.bundleId, ctx())
		s.derive.mockClear()
		expect(await s.writer.listPending(s.root)).toEqual([])
		expect(s.derive).toHaveBeenCalledWith(s.root, m.bundleId)
		// Not quarantined for it.
		expect(fs.existsSync(pendingOf(s.root, m.bundleId))).toBe(true)
	})

	it('refuses a file the manifest did not declare', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'page.mhtml': MHTML })
		await s.writer.acceptBundle(m, ctx())
		const res = await send(s.writer, m.bundleId, 'page.pdf', PDF)
		expect(res).toEqual({ error: 'invalid', detail: 'page.pdf: not declared in the manifest' })
		expect(fs.readdirSync(stagingOf(s.root, m.bundleId))).toEqual(['upload.json'])
	})

	it('refuses a length or digest other than the declared one before reading, and a body that differs after, leaving nothing', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'page.mhtml': MHTML, 'viewport.png': PNG })
		await s.writer.acceptBundle(m, ctx())
		const untouched = { [Symbol.asyncIterator]: () => { throw new Error('the body must not be read') } }

		expect(await send(s.writer, m.bundleId, 'viewport.png', PNG, { size: PNG.length + 1, body: untouched }))
			.toEqual({ error: 'invalid', detail: 'viewport.png: Content-Length is not the declared size' })
		expect(await send(s.writer, m.bundleId, 'viewport.png', PNG, { sha256: sha(Buffer.from('x')), body: untouched }))
			.toEqual({ error: 'invalid', detail: 'viewport.png: X-OC-Body-Sha256 is not the declared sha256' })

		// Headers that match the manifest, and a body that does not match either.
		const forged = Buffer.from(PNG)
		forged[100] ^= 0xff
		expect(await send(s.writer, m.bundleId, 'viewport.png', PNG, { body: body(forged) })).toEqual({ error: 'hash_mismatch' })
		// Ends short.
		const short = await send(s.writer, m.bundleId, 'viewport.png', PNG, { body: body(PNG.subarray(0, 100)) })
		expect(short).toMatchObject({ error: 'invalid' })
		expect(fs.readdirSync(stagingOf(s.root, m.bundleId))).toEqual(['upload.json'])
	})

	it('stops reading at the declared length and answers 413 for an overrun, leaving nothing', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'viewport.png': PNG, 'page.mhtml': MHTML })
		await s.writer.acceptBundle(m, ctx())
		let pulled = 0
		async function* endless() {
			for (;;) {
				pulled++
				yield PNG
			}
		}
		expect(await send(s.writer, m.bundleId, 'viewport.png', PNG, { body: endless() })).toEqual({ error: 'too_large' })
		expect(pulled).toBe(2)
		expect(fs.readdirSync(stagingOf(s.root, m.bundleId))).toEqual(['upload.json'])
	})

	it('answers a second, identical upload of a file with received, without reading it', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'page.mhtml': MHTML })
		await s.writer.acceptBundle(m, ctx())
		expect(await send(s.writer, m.bundleId, 'page.mhtml', MHTML)).toEqual({ received: true })
		const untouched = { [Symbol.asyncIterator]: () => { throw new Error('the body must not be read') } }
		expect(await send(s.writer, m.bundleId, 'page.mhtml', MHTML, { body: untouched })).toEqual({ received: true })
	})

	it('refuses content that is not what its name says: a PNG sent as page.mhtml', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'page.mhtml': PNG })
		await s.writer.acceptBundle(m, ctx())
		expect(await send(s.writer, m.bundleId, 'page.mhtml', PNG))
			.toEqual({ error: 'invalid', detail: 'page.mhtml: the content is not what the name says' })
		expect(fs.readdirSync(stagingOf(s.root, m.bundleId))).toEqual(['upload.json'])
		// And an MHTML sent as the viewport image.
		const m2 = captureManifest(s.id, { 'page.mhtml': MHTML, 'viewport.png': MHTML })
		await s.writer.acceptBundle(m2, ctx())
		expect(await send(s.writer, m2.bundleId, 'viewport.png', MHTML)).toMatchObject({ error: 'invalid' })
	})

	it('a commit with a file missing is 409 incomplete, naming it; one changed on disk counts as missing and is removed', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'page.mhtml': MHTML, 'viewport.png': PNG, 'page.pdf': PDF })
		await s.writer.acceptBundle(m, ctx())
		await send(s.writer, m.bundleId, 'page.mhtml', MHTML)
		await send(s.writer, m.bundleId, 'viewport.png', PNG)
		expect(await s.writer.commitBundle(m.bundleId, ctx())).toEqual({ error: 'incomplete', detail: ['page.pdf'] })

		const png = path.join(stagingOf(s.root, m.bundleId), 'viewport.png')
		const changed = Buffer.from(PNG)
		changed[50] ^= 1
		fs.writeFileSync(png, changed)
		await send(s.writer, m.bundleId, 'page.pdf', PDF)
		expect(await s.writer.commitBundle(m.bundleId, ctx())).toEqual({ error: 'incomplete', detail: ['viewport.png'] })
		expect(fs.existsSync(png)).toBe(false)
		expect(await send(s.writer, m.bundleId, 'viewport.png', PNG)).toEqual({ received: true })
		expect(await s.writer.commitBundle(m.bundleId, ctx())).toMatchObject({ status: 'accepted' })
	})

	it('resumes after a restart: creating again answers what is still missing', async () => {
		const first = setup()
		const m = captureManifest(first.id, { 'page.mhtml': MHTML, 'viewport.png': PNG })
		await first.writer.acceptBundle(m, ctx())
		await send(first.writer, m.bundleId, 'page.mhtml', MHTML)

		// A new writer over the same folder and keys, as after the app restarts.
		const writer = new InboxWriter({ ...first.deps })
		await writer.sweepAll()
		expect(await writer.acceptBundle({ ...m, clientTime: '2026-09-18T11:00:00.000Z' }, ctx({ receivedAt: '2026-09-18T11:00:00.000Z' })))
			.toEqual({ status: 'created', bundleId: m.bundleId, missing: ['viewport.png'] })
		await send(writer, m.bundleId, 'viewport.png', PNG)
		// The first arrival's time stands.
		expect(await writer.commitBundle(m.bundleId, ctx())).toEqual({ status: 'accepted', bundleId: m.bundleId, receivedAt: '2026-09-18T10:00:01.000Z' })
	})

	it('keeps what it has received when upload.json cannot be read just now, and resumes once it can', async () => {
		const { writer, root, id } = setup()
		const m = captureManifest(id, { 'page.mhtml': MHTML, 'viewport.png': PNG })
		await writer.acceptBundle(m, ctx())
		await send(writer, m.bundleId, 'page.mhtml', MHTML)
		const staged = stagingOf(root, m.bundleId)
		const upload = path.join(staged, 'upload.json')
		// Unreadable, as under an antivirus lock: not a reason to start the capture over.
		fs.chmodSync(upload, 0o000)
		try {
			await expect(writer.acceptBundle(m, ctx())).rejects.toThrow()
		} finally {
			fs.chmodSync(upload, 0o600)
		}
		expect(fs.readFileSync(path.join(staged, 'page.mhtml')).equals(MHTML)).toBe(true)
		expect(await writer.acceptBundle(m, ctx())).toEqual({ status: 'created', bundleId: m.bundleId, missing: ['viewport.png'] })
	})

	it('refuses to reuse a staged capture\'s id for different files, or from another client', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'page.mhtml': MHTML })
		await s.writer.acceptBundle(m, ctx())
		const other = captureManifest(s.id, { 'page.mhtml': MHTML, 'viewport.png': PNG }, { bundleId: m.bundleId })
		expect(await s.writer.acceptBundle(other, ctx())).toEqual({ error: 'invalid', detail: 'bundleId: already used for a different capture' })
		const stranger = ctx({ clientId: 'DDDDDDDDDDDDDDDDDDDDDD' })
		expect(await s.writer.acceptBundle(m, stranger)).toMatchObject({ error: 'invalid' })
		expect(await send(s.writer, m.bundleId, 'page.mhtml', MHTML, {}, stranger)).toEqual({ error: 'unknown_bundle' })
		expect(await s.writer.commitBundle(m.bundleId, stranger)).toEqual({ error: 'unknown_bundle' })
		expect(await send(s.writer, randomUUID(), 'page.mhtml', MHTML)).toEqual({ error: 'unknown_bundle' })
	})

	it('reserves the declared bytes at create: a second capture that would not fit is 507 before either sends a byte', async () => {
		const s = setup({ budgetBytes: 200_000 })
		const big = randomBytes(120_000)
		const a = captureManifest(s.id, { 'page.mhtml': MHTML, 'page.pdf': big })
		expect(await s.writer.acceptBundle(a, ctx())).toMatchObject({ status: 'created' })
		const b = captureManifest(s.id, { 'page.mhtml': MHTML, 'page.pdf': big })
		expect(await s.writer.acceptBundle(b, ctx())).toEqual({ error: 'budget_exceeded' })
		expect(fs.existsSync(stagingOf(s.root, b.bundleId))).toBe(false)
		// A small one still fits beside the reservation.
		expect(await s.writer.acceptBundle(captureManifest(s.id, { 'page.mhtml': MHTML }), ctx())).toMatchObject({ status: 'created' })
	})

	it('after commit: creating again is a duplicate, committing again is a duplicate, a file is a conflict', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'page.mhtml': MHTML })
		await s.writer.acceptBundle(m, ctx())
		await send(s.writer, m.bundleId, 'page.mhtml', MHTML)
		await s.writer.commitBundle(m.bundleId, ctx())
		expect(await s.writer.acceptBundle(m, ctx())).toEqual({ status: 'duplicate', bundleId: m.bundleId, receivedAt: '2026-09-18T10:00:01.000Z' })
		expect(await s.writer.commitBundle(m.bundleId, ctx())).toEqual({ status: 'duplicate', bundleId: m.bundleId, receivedAt: '2026-09-18T10:00:01.000Z' })
		expect(await send(s.writer, m.bundleId, 'page.mhtml', MHTML)).toEqual({ error: 'conflict', detail: 'the capture is already committed' })
	})

	it('refuses everything while unlicensed, writing nothing', async () => {
		const s = setup({ licensed: async () => false })
		const m = captureManifest(s.id, { 'page.mhtml': MHTML })
		expect(await s.writer.acceptBundle(m, ctx())).toEqual({ error: 'unlicensed' })
		expect(await send(s.writer, m.bundleId, 'page.mhtml', MHTML)).toEqual({ error: 'unlicensed' })
		expect(await s.writer.commitBundle(m.bundleId, ctx())).toEqual({ error: 'unlicensed' })
		expect(fs.existsSync(inboxOf(s.root))).toBe(false)
	})

	it('quarantines a pending capture whose file went missing, rather than listing it', async () => {
		const s = setup()
		const m = captureManifest(s.id, { 'page.mhtml': MHTML })
		await s.writer.acceptBundle(m, ctx())
		await send(s.writer, m.bundleId, 'page.mhtml', MHTML)
		await s.writer.commitBundle(m.bundleId, ctx())
		fs.rmSync(path.join(pendingOf(s.root, m.bundleId), 'page.mhtml'))
		expect(await s.writer.listPending(s.root)).toEqual([])
		expect(fs.existsSync(path.join(inboxOf(s.root), 'rejected', m.bundleId, 'reason.json'))).toBe(true)
	})
})
