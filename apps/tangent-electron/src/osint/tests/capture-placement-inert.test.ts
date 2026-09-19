import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { Readable } from 'stream'
import { InboxWriter } from '../../main/osint/inbox/inbox-writer'
import { workspaceIdFor } from '../../main/osint/extension/signing'
import { CaptureDeriver, inProcessRunner } from '../../main/osint/capture/deriver'
import { blinkArchive } from '../../main/osint/capture/test-archives'
import type { CaptureManifest } from '../../main/osint/extension/protocol'
import { markdownToTextDocument } from '../../common/markdownModel/parser'

/**
 * The whole way from a hostile page to the .md the analyst opens: archived, committed,
 * converted in main, placed into OSINTCopilot/Evidence/, then read with Tangent's own
 * parser as the editor would render it. Here rather than beside the writer because
 * Tangent's parser is not written to src/main's strict checks (see
 * capture-markdown-inert.test.ts).
 */

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'osint-place-inert-')))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(32)])

const HOSTILE = `<!doctype html><html><head><title>![t](https://tracker.example/title.gif)</title></head><body>
	<p>Hello <img src="https://tracker.example/pixel.gif" alt="x"></p>
	<p>https://tracker.example/alone.gif</p>
	<p>see !https://tracker.example/bang.gif</p>
	<p>![md](https://tracker.example/md.png) and ![[OSINTCopilot/Entities/secret]]</p>
	<h2>https://tracker.example/heading.png</h2>
	<ul><li>https://tracker.example/li.png</li></ul>
	<iframe src="https://tracker.example/frame"></iframe>
	<picture><source srcset="https://tracker.example/p.webp"><img src="https://tracker.example/p.jpg"></picture>
	<pre>![c](https://tracker.example/c.png)
!https://tracker.example/pre.gif</pre>
	<a href="https://site.example/ok">a real link</a>
</body></html>`

describe('a placed capture from a hostile page', () => {
	it('is markdown in which Tangent finds nothing to embed', async () => {
		const root = path.join(dir, 'Case')
		fs.mkdirSync(root)
		const w = randomBytes(32), m = randomBytes(32)
		let deriver: CaptureDeriver | null = null
		const writer = new InboxWriter({
			host: { knownRoots: () => [root], openRoots: () => [root], documentationPath: () => null, notify: () => undefined },
			keys: { workspaceIdKey: () => w, manifestKey: () => m },
			licensed: async () => true,
			derive: (r, id) => deriver?.enqueue(r, id),
		})
		deriver = new CaptureDeriver({ store: writer, runParser: inProcessRunner, renderArchive: async () => ({ png: PNG }) })

		const url = 'https://evil.example/p'
		const archive = Buffer.from(blinkArchive({ url, html: HOSTILE }))
		const manifest: CaptureManifest = {
			v: 1, bundleId: randomUUID(), workspaceId: workspaceIdFor(w, root), kind: 'capture',
			page: { url, title: '![t](https://tracker.example/title.gif)' }, clientTime: '2026-09-18T10:00:00.000Z',
			capture: { files: { 'page.mhtml': { size: archive.length, sha256: sha(archive) } } },
		}
		const ctx = {
			clientId: 'CCCCCCCCCCCCCCCCCCCCCC', origin: 'chrome-extension://' + 'a'.repeat(32),
			extVersion: '1.0.0', receivedAt: '2026-09-18T10:00:01.000Z', bodySha256: '0'.repeat(64),
		}
		expect(await writer.acceptBundle(manifest, ctx)).toMatchObject({ status: 'created' })
		expect(await writer.receiveFile({
			bundleId: manifest.bundleId, name: 'page.mhtml', size: archive.length, sha256: sha(archive), body: Readable.from([archive]),
		}, ctx)).toEqual({ received: true })
		expect(await writer.commitBundle(manifest.bundleId, ctx)).toMatchObject({ status: 'accepted' })
		await deriver.idle()

		const placement = await writer.placeFiles(root, manifest.bundleId)
		const md = placement.files.find(f => f.role === 'markdown')!
		// The title is page text too; it never reaches a path as anything but [a-z0-9-].
		expect(md.path).toMatch(/^OSINTCopilot\/Evidence\/t-https-tracker-example-title-gif-[0-9a-f]{8}\.md$/)
		const text = fs.readFileSync(path.join(root, md.path), 'utf8')
		expect(text).toContain('a real link')

		const spans: Array<{ embed: boolean; href: string }> = []
		for (const line of markdownToTextDocument(text).lines) {
			for (const op of line.content.ops) {
				const at = op.attributes as { t_embed?: boolean; t_link?: { href?: string } } | undefined
				if (at?.t_embed || at?.t_link) spans.push({ embed: !!at.t_embed, href: String(at.t_link?.href ?? '') })
			}
		}
		expect(spans.filter(s => s.embed), text).toEqual([])
		// Every link left is one the converter wrote as [text](target), never a raw address.
		for (const span of spans) expect(text).toContain(`](${span.href})`)
		expect(spans.map(s => s.href)).toContain('https://site.example/ok')
	})
})
