import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { Readable } from 'stream'
import { InboxWriter, PLACEMENT_STEP } from './inbox-writer'
import { workspaceIdFor } from '../extension/signing'
import type { BundleContext } from '../extension/server'
import type { CaptureFileName, CaptureManifest } from '../extension/protocol'
import { CaptureDeriver, inProcessRunner } from '../capture/deriver'
import { evidenceStem } from '../capture/slug'

/**
 * Placing a derived capture's files into OSINTCopilot/Evidence/: confined to the
 * workspace, copied only when every sealed digest still holds, idempotent, and never
 * writing over or through anything already there.
 */

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osint-place-')))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
let n = 0

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const BLINK = fs.readFileSync(path.join(__dirname, '..', 'capture', 'fixtures', 'blink-page.mhtml'))
const URL_ = 'https://news.example/2026/09/cafe-owner?ref=home'
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(64)])
const VIEWPORT = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(48)])

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
	deriver: CaptureDeriver
	keys: { workspaceIdKey(): Buffer; manifestKey(): Buffer }
}

/** `render` stands in for the off-screen renderer; by default it draws the same PNG every time. */
function env(render: () => Buffer = () => PNG): Env {
	const root = path.join(dir, `${n++}-Case`)
	fs.mkdirSync(root, { recursive: true })
	const w = randomBytes(32), m = randomBytes(32)
	const keys = { workspaceIdKey: () => w, manifestKey: () => m }
	let deriver: CaptureDeriver | null = null
	const writer = new InboxWriter({
		host: { knownRoots: () => [root], openRoots: () => [root], documentationPath: () => null, notify: () => undefined },
		keys,
		licensed: async () => true,
		derive: (r, id) => deriver?.enqueue(r, id),
	})
	deriver = new CaptureDeriver({ store: writer, runParser: inProcessRunner, renderArchive: async () => ({ png: render() }) })
	return { root, writer, deriver, keys }
}

/** Creates, uploads, commits and derives a capture; returns its id. */
async function capture(e: Env, mhtml: Buffer = BLINK, extra: { viewport?: Buffer } = {}): Promise<string> {
	const files: Partial<Record<CaptureFileName, { size: number; sha256: string }>> = { 'page.mhtml': { size: mhtml.length, sha256: sha(mhtml) } }
	if (extra.viewport) files['viewport.png'] = { size: extra.viewport.length, sha256: sha(extra.viewport) }
	const m: CaptureManifest = {
		v: 1,
		bundleId: randomUUID(),
		workspaceId: workspaceIdFor(e.keys.workspaceIdKey(), e.root),
		kind: 'capture',
		page: { url: URL_, title: 'Café owner' },
		clientTime: '2026-09-18T10:00:00.000Z',
		capture: { files: files as CaptureManifest['capture']['files'] },
	}
	expect(await e.writer.acceptBundle(m, ctx())).toMatchObject({ status: 'created' })
	const send = async (name: CaptureFileName, body: Buffer) => expect(await e.writer.receiveFile(
		{ bundleId: m.bundleId, name, size: body.length, sha256: sha(body), body: Readable.from([body]) }, ctx())).toEqual({ received: true })
	await send('page.mhtml', mhtml)
	if (extra.viewport) await send('viewport.png', extra.viewport)
	expect(await e.writer.commitBundle(m.bundleId, ctx())).toMatchObject({ status: 'accepted' })
	await e.deriver.idle()
	return m.bundleId
}

const evidence = (e: Env) => path.join(e.root, 'OSINTCopilot', 'Evidence')
const pendingOf = (e: Env, id: string) => path.join(e.root, '.osint-inbox', 'pending', id)
const stem = (mhtml: Buffer = BLINK) => evidenceStem('Café owner', URL_, sha(mhtml))
const listEvidence = (e: Env) => fs.existsSync(evidence(e)) ? fs.readdirSync(evidence(e)).sort() : []

describe('placing a capture', () => {
	it('copies the archive, both screenshots and the markdown under app-made names, keeping the bundle\'s own', async () => {
		const e = env()
		const id = await capture(e, BLINK, { viewport: VIEWPORT })
		const placement = await e.writer.placeFiles(e.root, id)
		const s = stem()
		expect(s).toMatch(/^caf-owner-[0-9a-f]{8}$/)
		const markdown = fs.readFileSync(path.join(pendingOf(e, id), 'page.markdown'))
		expect(placement).toEqual({
			bundleId: id,
			files: [
				{ role: 'archive', path: `OSINTCopilot/Evidence/${s}.mhtml`, sha256: sha(BLINK), created: true },
				{ role: 'fullpage', path: `OSINTCopilot/Evidence/${s}.png`, sha256: sha(PNG), created: true },
				{ role: 'viewport', path: `OSINTCopilot/Evidence/${s}.viewport.png`, sha256: sha(VIEWPORT), created: true },
				{ role: 'markdown', path: `OSINTCopilot/Evidence/${s}.md`, sha256: sha(markdown), created: true },
			],
		})
		for (const f of placement.files) expect(sha(fs.readFileSync(path.join(e.root, f.path)))).toBe(f.sha256)
		// Copied, not moved: the signed bundle is whole until it is finished.
		expect(fs.existsSync(path.join(pendingOf(e, id), 'page.mhtml'))).toBe(true)
		expect(fs.existsSync(path.join(pendingOf(e, id), 'page.markdown'))).toBe(true)
		expect((await e.writer.listPending(e.root)).map(b => b.bundleId)).toEqual([id])
		// No temporary file left anywhere.
		expect(fs.readdirSync(pendingOf(e, id)).filter(f => f.endsWith('.tmp'))).toEqual([])
		expect(listEvidence(e)).toEqual([`${s}.md`, `${s}.mhtml`, `${s}.png`, `${s}.viewport.png`])
	})

	it('placed again, answers the same and places nothing new', async () => {
		const e = env()
		const id = await capture(e)
		const first = await e.writer.placeFiles(e.root, id)
		const files = listEvidence(e)
		const mtimes = files.map(f => fs.statSync(path.join(evidence(e), f)).mtimeMs)
		// As after a crash between placing and journalling it: still this capture's files.
		expect(await e.writer.placeFiles(e.root, id)).toEqual(first)
		expect(listEvidence(e)).toEqual(files)
		expect(files.map(f => fs.statSync(path.join(evidence(e), f)).mtimeMs)).toEqual(mtimes)
		const state = JSON.parse(fs.readFileSync(path.join(pendingOf(e, id), 'state.json'), 'utf8'))
		expect(Object.keys(state.steps.find((s: { step: string }) => s.step === PLACEMENT_STEP).data).sort()).toEqual(files)
	})

	it('a second capture of the identical page reuses the files, and does not call them its own', async () => {
		const e = env()
		const a = await capture(e)
		const b = await capture(e)
		const first = await e.writer.placeFiles(e.root, a)
		const files = listEvidence(e)
		const second = await e.writer.placeFiles(e.root, b)
		expect(second.files.map(f => f.path)).toEqual(first.files.map(f => f.path))
		expect(second.files.every(f => !f.created)).toBe(true)
		expect(listEvidence(e)).toEqual(files)
	})

	it('chooses a suffixed name when the name holds other bytes, and leaves those alone', async () => {
		const e = env()
		const id = await capture(e)
		fs.mkdirSync(evidence(e), { recursive: true })
		const theirs = path.join(evidence(e), `${stem()}.mhtml`)
		fs.writeFileSync(theirs, 'something else entirely')
		// A symlink at a name is never written through, even to a file in the vault.
		const decoy = path.join(e.root, 'decoy.png')
		fs.writeFileSync(decoy, 'decoy')
		fs.symlinkSync(decoy, path.join(evidence(e), `${stem()}.png`))

		const placement = await e.writer.placeFiles(e.root, id)
		expect(placement.files[0]).toMatchObject({ role: 'archive', path: `OSINTCopilot/Evidence/${stem()}-2.mhtml`, created: true })
		expect(placement.files[1]).toMatchObject({ role: 'fullpage', path: `OSINTCopilot/Evidence/${stem()}-2.png`, created: true })
		expect(fs.readFileSync(theirs, 'utf8')).toBe('something else entirely')
		expect(fs.readFileSync(decoy, 'utf8')).toBe('decoy')
		expect(fs.readFileSync(path.join(e.root, placement.files[0].path)).equals(BLINK)).toBe(true)
		// And again: the suffixed files are found as its own.
		expect(await e.writer.placeFiles(e.root, id)).toEqual(placement)
	})

	for (const planted of ['OSINTCopilot', 'OSINTCopilot/Evidence'] as const) {
		it(`refuses a symlink at ${planted} that leads out of the investigation, writing nothing there`, async () => {
			const e = env()
			const id = await capture(e)
			const outside = path.join(dir, `outside-${n++}`)
			fs.mkdirSync(outside)
			fs.mkdirSync(path.dirname(path.join(e.root, planted)), { recursive: true })
			fs.symlinkSync(outside, path.join(e.root, planted))
			await expect(e.writer.placeFiles(e.root, id)).rejects.toThrow(/not a folder inside the investigation/)
			expect(fs.readdirSync(outside)).toEqual([])
			// Left pending, whole, for when the folder is fixed.
			expect((await e.writer.listPending(e.root)).map(b => b.bundleId)).toEqual([id])
		})
	}

	it('follows a symlinked Evidence folder that stays inside the investigation', async () => {
		const e = env()
		const id = await capture(e)
		fs.mkdirSync(path.join(e.root, 'Elsewhere'))
		fs.mkdirSync(path.join(e.root, 'OSINTCopilot'))
		fs.symlinkSync(path.join(e.root, 'Elsewhere'), evidence(e))
		const placement = await e.writer.placeFiles(e.root, id)
		expect(fs.readdirSync(path.join(e.root, 'Elsewhere'))).toContain(`${stem()}.mhtml`)
		expect(placement.files[0].path).toBe(`OSINTCopilot/Evidence/${stem()}.mhtml`)
	})

	it('refuses an Evidence folder that is really the inbox', async () => {
		const e = env()
		const id = await capture(e)
		fs.mkdirSync(path.join(e.root, 'OSINTCopilot'))
		fs.symlinkSync(path.join(e.root, '.osint-inbox', 'done'), evidence(e))
		await expect(e.writer.placeFiles(e.root, id)).rejects.toThrow(/points into the inbox/)
	})

	it('refuses a derived.json whose MAC does not verify, placing nothing', async () => {
		const e = env()
		const id = await capture(e)
		const file = path.join(pendingOf(e, id), 'derived.json')
		const derived = JSON.parse(fs.readFileSync(file, 'utf8'))
		fs.writeFileSync(file, JSON.stringify({ ...derived, urlMismatch: !derived.urlMismatch }))
		await expect(e.writer.placeFiles(e.root, id)).rejects.toThrow(/derived\.json/)
		expect(listEvidence(e)).toEqual([])
	})

	it('refuses, and sets aside, an archive swapped after commit for one of the same size', async () => {
		const e = env()
		const id = await capture(e)
		const swapped = Buffer.from(BLINK)
		swapped[swapped.length - 3] ^= 1
		fs.writeFileSync(path.join(pendingOf(e, id), 'page.mhtml'), swapped)
		await expect(e.writer.placeFiles(e.root, id)).rejects.toThrow(/no longer matches its sealed digest/)
		expect(listEvidence(e)).toEqual([])
		expect(fs.existsSync(path.join(e.root, '.osint-inbox', 'rejected', id))).toBe(true)
	})

	it('re-derives, rather than places, a markdown file changed after derivation', async () => {
		const e = env()
		const id = await capture(e)
		const md = path.join(pendingOf(e, id), 'page.markdown')
		fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(/.$/s, '!'))
		await expect(e.writer.placeFiles(e.root, id)).rejects.toThrow(/page\.markdown no longer matches/)
		await e.deriver.idle()
		const placement = await e.writer.placeFiles(e.root, id)
		expect(placement.files.map(f => f.role)).toEqual(['archive', 'fullpage', 'markdown'])
		// The archive it had already placed is still its own.
		expect(placement.files.every(f => f.created)).toBe(true)
	})

	it('places nothing when a later file fails its digest, and sets the capture aside', async () => {
		const e = env()
		const id = await capture(e, BLINK, { viewport: VIEWPORT })
		// Same size, other bytes: passes the size check, not the digest. The archive and
		// full-page screenshot before it in the placing order must not be left behind.
		const swapped = Buffer.from(VIEWPORT)
		swapped[swapped.length - 1] ^= 1
		fs.writeFileSync(path.join(pendingOf(e, id), 'viewport.png'), swapped)
		await expect(e.writer.placeFiles(e.root, id)).rejects.toThrow(/viewport\.png no longer matches/)
		expect(listEvidence(e)).toEqual([])
		expect(fs.existsSync(path.join(e.root, '.osint-inbox', 'rejected', id))).toBe(true)
	})

	it('a re-derivation that draws the page differently still places one screenshot, under the plain name', async () => {
		let draws = 0
		const e = env(() => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(`draw ${++draws}`)]))
		const id = await capture(e)
		const md = path.join(pendingOf(e, id), 'page.markdown')
		fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(/.$/s, '!'))
		await expect(e.writer.placeFiles(e.root, id)).rejects.toThrow(/page\.markdown no longer matches/)
		await e.deriver.idle()
		expect(draws).toBe(2)
		const placement = await e.writer.placeFiles(e.root, id)
		const s = stem()
		expect(listEvidence(e)).toEqual([`${s}.md`, `${s}.mhtml`, `${s}.png`])
		expect(placement.files.find(f => f.role === 'fullpage')).toMatchObject({ path: `OSINTCopilot/Evidence/${s}.png`, created: true })
		expect(sha(fs.readFileSync(path.join(evidence(e), `${s}.png`)))).toBe(placement.files[1].sha256)
		// Only what is there is recorded as its own.
		const state = JSON.parse(fs.readFileSync(path.join(pendingOf(e, id), 'state.json'), 'utf8'))
		expect(Object.keys(state.steps.find((st: { step: string }) => st.step === PLACEMENT_STEP).data).sort()).toEqual(listEvidence(e))
	})

	it('takes back what it placed when a later file cannot be placed', async () => {
		const e = env()
		const id = await capture(e)
		// Every name the markdown could take is a folder: no free name, after the archive
		// and screenshot were already linked.
		fs.mkdirSync(evidence(e), { recursive: true })
		const s = stem()
		fs.mkdirSync(path.join(evidence(e), `${s}.md`))
		for (let i = 2; i <= 50; i++) fs.mkdirSync(path.join(evidence(e), `${s}-${i}.md`))
		await expect(e.writer.placeFiles(e.root, id)).rejects.toThrow(/no free name/)
		expect(listEvidence(e).filter(f => !f.endsWith('.md'))).toEqual([])
		const state = JSON.parse(fs.readFileSync(path.join(pendingOf(e, id), 'state.json'), 'utf8'))
		expect(state.steps.find((st: { step: string }) => st.step === PLACEMENT_STEP)?.data ?? {}).toEqual({})
		expect(fs.readdirSync(pendingOf(e, id)).filter(f => f.endsWith('.tmp'))).toEqual([])
	})

	it('does not let the renderer write the placement record', async () => {
		const e = env()
		const id = await capture(e)
		await expect(e.writer.recordStep(e.root, id, PLACEMENT_STEP, { [`${stem()}.mhtml`]: sha(BLINK) })).rejects.toThrow(/Not a step name/)
	})

	it('only for a pending capture', async () => {
		const e = env()
		const id = await capture(e)
		await e.writer.finish(e.root, id, 'done')
		await expect(e.writer.placeFiles(e.root, id)).rejects.toThrow(/No pending bundle/)
		await expect(e.writer.placeFiles(e.root, '../x')).rejects.toThrow(/Not a bundle id/)
	})
})
