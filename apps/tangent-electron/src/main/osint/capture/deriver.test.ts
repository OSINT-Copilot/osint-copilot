import { describe, it, expect, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { Readable } from 'stream'
import { InboxWriter, type InboxWriterDeps } from '../inbox/inbox-writer'
import { verifySealedDerived } from '../inbox/manifest-mac'
import { workspaceIdFor } from '../extension/signing'
import type { BundleContext } from '../extension/server'
import type { CaptureFileName, CaptureManifest } from '../extension/protocol'
import { CaptureDeriver, type CaptureDeriverDeps, type ParserRunner } from './deriver'
import { inProcessRunner } from './test-runners'
import { deriveFromMhtml, samePage } from './derive'
import { blinkArchive } from './test-archives'

/**
 * Derivation after commit: the parser in a (here, fake) separate process under a hard
 * timeout, the render injected, results sealed into derived.json in the pending folder.
 */

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osint-derive-')))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
let n = 0

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const BLINK = fs.readFileSync(path.join(__dirname, 'fixtures', 'blink-page.mhtml'))
const BLINK_URL = 'https://news.example/2026/09/cafe-owner?ref=home'
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(64)])

const HOSTILE_HTML = `<!doctype html><html><head><title>Hostile &amp; <b>page</b></title></head><body>
	<p>Hi <img src="https://tracker.example/pixel.gif" alt="x"></p>
	<picture><source srcset="https://tracker.example/a.webp"><img src="https://tracker.example/b.jpg"></picture>
	<iframe src="https://tracker.example/frame"></iframe>
	<p>Text: ![y](https://tracker.example/y.png) and ![[z]]</p>
	<pre>![c](https://tracker.example/c.png) &lt;img src=x&gt;</pre>
</body></html>`

function ctx(): BundleContext {
	return {
		clientId: 'CCCCCCCCCCCCCCCCCCCCCC',
		origin: 'chrome-extension://' + 'a'.repeat(32),
		extVersion: '1.0.0',
		receivedAt: '2026-09-18T10:00:01.000Z',
		bodySha256: '0'.repeat(64),
	}
}

interface Env {
	root: string
	writer: InboxWriter
	deriver: CaptureDeriver | null
	keys: { workspaceIdKey(): Buffer; manifestKey(): Buffer }
	notify: ReturnType<typeof vi.fn>
	deps: InboxWriterDeps
}

function env(capture: Partial<CaptureDeriverDeps> | null, reuse?: Env): Env {
	const root = reuse?.root ?? path.join(dir, `${n++}-Case`)
	fs.mkdirSync(root, { recursive: true })
	const keys = reuse?.keys ?? (() => {
		const w = randomBytes(32), m = randomBytes(32)
		return { workspaceIdKey: () => w, manifestKey: () => m }
	})()
	const notify = vi.fn()
	let deriver: CaptureDeriver | null = null
	const deps: InboxWriterDeps = {
		host: { knownRoots: () => [root], openRoots: () => [root], documentationPath: () => null, notify },
		keys,
		licensed: async () => true,
		derive: (r, id) => deriver?.enqueue(r, id),
	}
	const writer = new InboxWriter(deps)
	if (capture) {
		deriver = new CaptureDeriver({
			store: writer,
			runParser: inProcessRunner,
			renderArchive: async () => ({ png: PNG }),
			...capture,
		})
	}
	return { root, writer, deriver, keys, notify, deps }
}

/** Creates, uploads and commits a capture through the writer; returns its id. */
async function commitCapture(e: Env, mhtml: Buffer, pageUrl = BLINK_URL): Promise<string> {
	const files: Partial<Record<CaptureFileName, { size: number; sha256: string }>> = { 'page.mhtml': { size: mhtml.length, sha256: sha(mhtml) } }
	const m: CaptureManifest = {
		v: 1,
		bundleId: randomUUID(),
		workspaceId: workspaceIdFor(e.keys.workspaceIdKey(), e.root),
		kind: 'capture',
		page: { url: pageUrl, title: 'Café owner' },
		clientTime: '2026-09-18T10:00:00.000Z',
		capture: { files: files as CaptureManifest['capture']['files'] },
	}
	expect(await e.writer.acceptBundle(m, ctx())).toMatchObject({ status: 'created' })
	expect(await e.writer.receiveFile({ bundleId: m.bundleId, name: 'page.mhtml', size: mhtml.length, sha256: sha(mhtml), body: Readable.from([mhtml]) }, ctx()))
		.toEqual({ received: true })
	expect(await e.writer.commitBundle(m.bundleId, ctx())).toMatchObject({ status: 'accepted' })
	return m.bundleId
}

const pendingOf = (e: Env, id: string) => path.join(e.root, '.osint-inbox', 'pending', id)
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'))

describe('deriving a committed capture', () => {
	it('a Blink-shaped archive yields page.markdown, fullpage.png and a sealed derived.json, and is then listed', async () => {
		const e = env({})
		const id = await commitCapture(e, BLINK)
		await e.deriver!.idle()

		const pending = pendingOf(e, id)
		const markdown = fs.readFileSync(path.join(pending, 'page.markdown'))
		expect(markdown.toString()).toContain('# Café owner profile')
		expect(markdown.toString()).toContain('[J. Doe](https://news.example/authors/jdoe)')
		expect(markdown.toString()).toContain('[image: The café front](https://cdn.news.example/img/cafe.jpg)')
		expect(fs.existsSync(path.join(pending, 'page.md'))).toBe(false)
		expect(fs.readFileSync(path.join(pending, 'fullpage.png')).equals(PNG)).toBe(true)

		const derived = readJson(path.join(pending, 'derived.json'))
		expect(verifySealedDerived(e.keys.manifestKey(), derived, id)).toBe(true)
		expect(derived).toMatchObject({
			v: 1,
			bundleId: id,
			status: 'done',
			archiveSha256: sha(BLINK),
			markdown: { file: 'page.markdown', sha256: sha(markdown) },
			fullpage: { file: 'fullpage.png', sha256: sha(PNG) },
			contentLocation: BLINK_URL,
			urlMismatch: false,
			title: 'Café owner profile — Example News',
			errors: [],
		})
		// Bound to its bundle, and tamper-evident.
		expect(verifySealedDerived(e.keys.manifestKey(), derived, randomUUID())).toBe(false)
		expect(verifySealedDerived(e.keys.manifestKey(), { ...derived, urlMismatch: true }, id)).toBe(false)

		expect(e.notify).toHaveBeenCalled()
		const listed = await e.writer.listPending(e.root)
		expect(listed).toHaveLength(1)
		expect(listed[0].derived).toEqual((({ mac: _m, ...rest }) => rest)(derived))
		expect(listed[0].server.files?.['page.mhtml']).toEqual({ size: BLINK.length, sha256: sha(BLINK) })
	})

	it('a hostile page\'s markdown has no embed syntax and no tags', async () => {
		const e = env({})
		const id = await commitCapture(e, Buffer.from(blinkArchive({ url: 'https://evil.example/p', html: HOSTILE_HTML })), 'https://evil.example/p')
		await e.deriver!.idle()
		const markdown = fs.readFileSync(path.join(pendingOf(e, id), 'page.markdown'), 'utf8')
		expect(markdown).toContain('[image: x](https://tracker.example/pixel.gif)')
		expect(markdown).not.toContain('![')
		expect(markdown).not.toMatch(/<[A-Za-z/!?]/)
		expect(markdown).not.toContain('tracker.example/frame')
		expect(readJson(path.join(pendingOf(e, id), 'derived.json')).title).toBe('Hostile & <b>page</b>')
	})

	it('flags an archive whose address is not the page the extension named, or that names none', async () => {
		const e = env({})
		const other = await commitCapture(e, BLINK, 'https://news.example/some-other-page')
		const fragment = await commitCapture(e, BLINK, BLINK_URL + '#comments')
		const none = await commitCapture(e, Buffer.from(blinkArchive({ url: null, html: '<p>x</p>' })), 'https://x.example/')
		await e.deriver!.idle()
		expect(readJson(path.join(pendingOf(e, other), 'derived.json'))).toMatchObject({ urlMismatch: true, contentLocation: BLINK_URL })
		expect(readJson(path.join(pendingOf(e, fragment), 'derived.json'))).toMatchObject({ urlMismatch: false })
		expect(readJson(path.join(pendingOf(e, none), 'derived.json'))).toMatchObject({
			urlMismatch: true,
			contentLocation: null,
			errors: ['the archive does not record its address'],
		})
	})

	it('kills a parser that hangs at the timeout, records the failure, and moves on to the next capture', async () => {
		const killed: string[] = []
		let calls = 0
		const hanging: ParserRunner = job => {
			calls++
			if (calls === 1) return { result: new Promise(() => undefined), kill: () => { killed.push(job.archivePath) } }
			return inProcessRunner(job)
		}
		const e = env({ runParser: hanging, parseTimeoutMs: 50 })
		const stuck = await commitCapture(e, BLINK)
		const next = await commitCapture(e, BLINK)
		await e.deriver!.idle()

		expect(killed).toEqual([path.join(pendingOf(e, stuck), 'page.mhtml')])
		const derived = readJson(path.join(pendingOf(e, stuck), 'derived.json'))
		expect(verifySealedDerived(e.keys.manifestKey(), derived, stuck)).toBe(true)
		expect(derived.status).toBe('failed')
		expect(derived.markdown).toBeUndefined()
		expect(derived.errors).toEqual(['markdown: the parser did not finish within 0s and was stopped'])
		// The render still ran: the archive is fine even if our parser was not.
		expect(derived.fullpage).toEqual({ file: 'fullpage.png', sha256: sha(PNG) })
		expect(fs.existsSync(path.join(pendingOf(e, stuck), 'page.markdown'))).toBe(false)
		expect(readJson(path.join(pendingOf(e, next), 'derived.json')).status).toBe('done')
		// A failed derivation is still listed; the capture itself is good.
		expect((await e.writer.listPending(e.root)).map(b => b.bundleId).sort()).toEqual([stuck, next].sort())
	})

	it('records a render that failed, or one that never returns', async () => {
		const e = env({ renderArchive: async () => ({ reason: 'could not load the archive (-3: ABORTED)' }) })
		const id = await commitCapture(e, BLINK)
		await e.deriver!.idle()
		expect(readJson(path.join(pendingOf(e, id), 'derived.json')).fullpage).toEqual({ error: 'could not load the archive (-3: ABORTED)' })
		expect(fs.existsSync(path.join(pendingOf(e, id), 'fullpage.png'))).toBe(false)

		const e2 = env({ renderArchive: () => new Promise(() => undefined), renderTimeoutMs: 30 })
		const id2 = await commitCapture(e2, BLINK)
		await e2.deriver!.idle()
		expect(readJson(path.join(pendingOf(e2, id2), 'derived.json'))).toMatchObject({
			status: 'done',
			fullpage: { error: 'the render did not finish in time' },
		})
	})

	it('derives on start-up a capture that committed but was never derived', async () => {
		// The app stopped between commit and derivation: no deriver to hear the commit.
		const before = env(null)
		const id = await commitCapture(before, BLINK)
		expect(fs.existsSync(path.join(pendingOf(before, id), 'derived.json'))).toBe(false)

		const after = env({}, before)
		await after.writer.sweepAll()
		await after.deriver!.idle()
		expect(verifySealedDerived(after.keys.manifestKey(), readJson(path.join(pendingOf(after, id), 'derived.json')), id)).toBe(true)
		expect(await after.writer.listPending(after.root)).toHaveLength(1)
	})

	it('derives again when derived.json does not verify, and not when it does', async () => {
		let runs = 0
		const counting: ParserRunner = job => {
			runs++
			return inProcessRunner(job)
		}
		const e = env({ runParser: counting })
		const id = await commitCapture(e, BLINK)
		await e.deriver!.idle()
		expect(runs).toBe(1)
		await e.writer.listPending(e.root)
		await e.deriver!.idle()
		expect(runs).toBe(1)

		const file = path.join(pendingOf(e, id), 'derived.json')
		fs.writeFileSync(file, JSON.stringify({ ...readJson(file), urlMismatch: true }))
		expect(await e.writer.listPending(e.root)).toEqual([])
		await e.deriver!.idle()
		expect(runs).toBe(2)
		expect(readJson(file).urlMismatch).toBe(false)
	})

	it('does not derive an archive swapped for another of the same size after commit', async () => {
		// listPending checks sizes only; results sealed as this capture's must come from
		// the archive whose digest was sealed at commit.
		let runs = 0
		const e = env({ runParser: job => { runs++; return inProcessRunner(job) } })
		e.deps.derive = () => undefined
		const id = await commitCapture(e, BLINK)
		const swapped = Buffer.from(BLINK)
		swapped[swapped.length - 3] ^= 1
		fs.writeFileSync(path.join(pendingOf(e, id), 'page.mhtml'), swapped)

		e.deps.derive = (r, bundleId) => e.deriver?.enqueue(r, bundleId)
		expect(await e.writer.listPending(e.root)).toEqual([])
		await e.deriver!.idle()
		expect(runs).toBe(0)
		expect(fs.existsSync(pendingOf(e, id))).toBe(false)
		expect(fs.existsSync(path.join(e.root, '.osint-inbox', 'rejected', id))).toBe(true)
	})
})

describe('the pure derivation', () => {
	it('prefers Snapshot-Content-Location, falls back to the part\'s, and compares ignoring fragment and credentials', () => {
		const archive = blinkArchive({ url: 'https://a.example/x', html: '<title>T</title><p>x</p>' })
		const withoutSnapshot = archive.replace(/^Snapshot-Content-Location:.*\r\n/m, '')
		expect(deriveFromMhtml(withoutSnapshot, 'https://a.example/x').contentLocation).toBe('https://a.example/x')
		expect(samePage('https://u:p@a.example/x#f', 'https://a.example/x')).toBe(true)
		expect(samePage('https://a.example/x?y=1', 'https://a.example/x')).toBe(false)
		expect(samePage('not a url', 'not a url')).toBe(false)
	})

	it('cleans a hostile address and title', () => {
		const archive = blinkArchive({ url: 'https://a.example/x\u202e', html: '<title>\u0007Bell\u2028line</title>' })
		const result = deriveFromMhtml(archive, 'https://a.example/x')
		expect(result.contentLocation).toBe('https://a.example/x')
		expect(result.title).toBe('Bell line')
	})
})
