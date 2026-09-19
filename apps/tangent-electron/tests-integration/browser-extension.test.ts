import { test, expect } from './tangent'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { execFile, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'

/**
 * The browser extension and the app, both real: the dev build of this app (npm run
 * build:dev) on a throwaway workspace, and the built extension loaded into a real
 * Chromium. The extension pairs with the app, is pointed at the investigation, and sends
 * an entity, a note and a page capture from an ordinary web page; the test then reads
 * what the app made of them from the workspace on disk and from the renderer, and takes
 * the note back with Remove.
 *
 * Every other test of this channel replaces one side: the extension's e2e runs the app's
 * server under node (extension-harness.ts), and the app's own tests fake the extension.
 * Only here do the renderer's inbox service, main's derive and placement, the capture
 * worker in its utility process and the real renderArchive all run on bytes a real
 * Chromium produced.
 *
 * And the privacy promise, end to end: the page points at a canary server with a
 * <link rel=preconnect> and a below-the-fold lazy image. The browser that shows the page
 * may contact it; the app, deriving markdown and a full-page screenshot from the archive,
 * must not. The canary counts raw TCP connections, and every one after the browser has
 * loaded the page fails the test. It also names the process behind each connection when
 * `ss` can still see the client end, so a failure says whether it was the app or the
 * browser.
 *
 * Isolation: the app gets its own userData (--user-data-dir), so pairing and the
 * extension switch never touch the developer's own profile, and the workspace is a fresh
 * temporary folder. OSINT_SKIP_LICENSE and OC_TEST_AUTO_CONFIRM_PAIR only take effect in
 * a development build that is not packaged (license.ts, osint/index.ts).
 *
 * Page capture needs pageCapture and <all_urls>, which the real manifest makes optional
 * and requests with a browser prompt Playwright cannot answer; as in the extension's own
 * e2e (apps/osint-copilot-extension/e2e/smoke.spec.ts), the test loads a copy of the
 * build whose manifest grants the two at install. Everything else is the shipped build.
 */

const extensionRoot = path.resolve(__dirname, '../../osint-copilot-extension')

// A path only; the fixture creates the workspace, afterAll removes the whole folder.
// Not created here, because the test runner loads this file to list its tests too.
const scratch = path.join(os.tmpdir(), `oc-ext-app-e2e-${process.pid}-${Date.now()}`)
const WORKSPACE_NAME = 'Case Browser'
const workspace = path.join(scratch, WORKSPACE_NAME)
const userData = path.join(scratch, 'userData')

test.use({
	workspace,
	resetWorkspace: true,
	launchEnv: { OSINT_SKIP_LICENSE: '1', OC_TEST_AUTO_CONFIRM_PAIR: '1' },
	launchArgs: [`--user-data-dir=${userData}`],
})

/**
 * The Chromium to launch: OC_E2E_CHROMIUM, else the one this Playwright was built for,
 * else the newest Chromium in Playwright's cache. The same resolution as the extension's
 * e2e; any recent Chromium can load an unpacked extension.
 */
function chromiumPath(): string | undefined {
	if (process.env.OC_E2E_CHROMIUM) return process.env.OC_E2E_CHROMIUM
	if (fs.existsSync(chromium.executablePath())) return undefined
	const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), '.cache', 'ms-playwright')
	return (fs.existsSync(cache) ? fs.readdirSync(cache) : [])
		.map(name => /^chromium-(\d+)$/.exec(name))
		.filter((m): m is RegExpExecArray => m !== null)
		.sort((a, b) => Number(b[1]) - Number(a[1]))
		.map(m => path.join(cache, m[0], 'chrome-linux64', 'chrome'))
		.find(p => fs.existsSync(p))
}

// ------------------------------------------------------------------ the canary

type Connection = {
	index: number
	clientPort: number
	/** Null until looked up, or when the owner could not be named (see detail). */
	pid: number | null
	command: string | null
	detail: string
}
type Canary = {
	port: number
	connections: Connection[]
	close(): Promise<void>
}

/** One `ss -p` look at the client end of a loopback connection: its owner, or why not. */
function ssOwner(clientPort: number): Promise<{ pid: number | null, command: string | null, detail: string }> {
	return new Promise(resolve => {
		execFile('ss', ['-tnpH', 'state', 'all', `sport = :${clientPort}`], { timeout: 2000 }, (err, stdout, stderr) => {
			const m = !err && /users:\(\("([^"]*)",pid=(\d+)/.exec(stdout)
			resolve(m
				? { pid: Number(m[2]), command: m[1], detail: '' }
				: { pid: null, command: null, detail: (err ? String(err) : '') + String(stdout).trim() + String(stderr).trim() })
		})
	})
}

/**
 * The process that owns the client end of a loopback connection. Asked a few times: a
 * single look has come back without the owner (the process list is read from /proc,
 * racing whatever the client is doing with its descriptors).
 */
async function ownerOf(clientPort: number): Promise<{ pid: number | null, command: string | null, detail: string }> {
	let last = { pid: null as number | null, command: null as string | null, detail: 'not looked up' }
	for (let attempt = 0; attempt < 10; attempt++) {
		last = await ssOwner(clientPort)
		if (last.pid !== null) return last
		await new Promise(resolve => setTimeout(resolve, 100))
	}
	return last
}

/** Whether `pid` is `root` or one of its descendants. */
function isDescendant(pid: number, root: number): boolean {
	for (let current = pid, hops = 0; current > 1 && hops < 64; hops++) {
		if (current === root) return true
		try {
			const stat = fs.readFileSync(`/proc/${current}/stat`, 'utf8')
			// The command sits in parentheses and may contain spaces; ppid follows the state.
			current = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
		}
		catch {
			return false
		}
	}
	return false
}

/**
 * Counts raw TCP connections, not HTTP requests: a preconnect is a handshake with no
 * request in it. Each socket is held open until its owner has been looked up (the client
 * end must still exist for `ss` to name it), then dropped without a reply.
 */
function startCanary(): Promise<Canary> {
	return new Promise((resolve, reject) => {
		const connections: Connection[] = []
		const sockets = new Set<net.Socket>()
		const server = net.createServer(socket => {
			sockets.add(socket)
			socket.on('close', () => sockets.delete(socket))
			socket.on('error', () => undefined)
			const clientPort = socket.remotePort ?? 0
			const entry: Connection = { index: connections.length, clientPort, pid: null, command: null, detail: 'looking up' }
			connections.push(entry)
			void ownerOf(clientPort).then(owner => {
				Object.assign(entry, owner)
				socket.destroy()
			})
		})
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => resolve({
			port: (server.address() as net.AddressInfo).port,
			connections,
			close: () => new Promise(done => {
				for (const s of sockets) s.destroy()
				server.close(() => done())
			}),
		}))
	})
}

// ------------------------------------------------------------------ the web page

const EMAIL = 'mallory.contact@example.org'

function pageHtml(canaryPort: number): string {
	const canary = `http://127.0.0.1:${canaryPort}`
	// The lazy image sits far below the fold of the browser's 1280x720 viewport, so the
	// browser never asks for it. A full-page render of the archive lays the whole page
	// out at once, which is exactly when an unconfined renderer would.
	return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Contact directory</title>
<link rel="preconnect" href="${canary}">
</head><body>
<h1>Contact directory</h1>
<p>For the leak, write to ${EMAIL} before Friday.</p>
<div style="height: 6000px; background: linear-gradient(#fff, #cde)"></div>
<p>End of the directory.</p>
<img loading="lazy" src="${canary}/lazy.png" width="200" height="200" alt="lazy">
</body></html>`
}

type Website = { url: string, requests: string[], close(): Promise<void> }

function startWebsite(html: string): Promise<Website> {
	const requests: string[] = []
	const server = http.createServer((req, res) => {
		requests.push(req.url ?? '')
		if (req.url === '/directory') {
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			res.end(html)
		}
		else {
			res.writeHead(404)
			res.end()
		}
	})
	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => resolve({
			url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/directory`,
			requests,
			close: () => new Promise<void>(done => {
				server.closeAllConnections()
				server.close(() => done())
			}),
		}))
	})
}

// ------------------------------------------------------------------ renderer helpers

type ActivityItem = {
	bundleId: string
	kind: 'entity' | 'note' | 'capture' | 'highlight' | 'highlight.update' | 'highlight.delete'
	removed: boolean
	manifest: any
	outcome: any
}

/** listApplied, straight from the renderer's bridge, with each bundle's applied outcome. */
async function activity(page: Page): Promise<ActivityItem[]> {
	return page.evaluate(async () => {
		const bundles: any[] = await (window as any).api.osint.inbox.listApplied()
		return bundles.map(b => ({
			bundleId: b.bundleId,
			kind: b.manifest.kind,
			removed: b.where === 'removed',
			manifest: b.manifest,
			outcome: (b.state?.steps ?? []).find((s: any) => s.step === 'applied')?.data ?? null,
		}))
	})
}

function sha256(file: string): string {
	return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Width and height from a PNG's IHDR, after checking its signature. */
function pngSize(file: string): { width: number, height: number } {
	const bytes = fs.readFileSync(file)
	expect(bytes.subarray(0, 8).toString('hex'), `${file} is not a PNG`).toBe('89504e470d0a1a0a')
	expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

// ------------------------------------------------------------------ setup

let canary: Canary
let website: Website
let unpacked: string

test.beforeAll(async () => {
	fs.mkdirSync(scratch, { recursive: true })
	// Always the current source: a stale dist/ would test yesterday's extension.
	execFileSync(process.execPath, ['build.mjs'], { cwd: extensionRoot, stdio: 'pipe' })
	const dist = path.join(extensionRoot, 'dist')
	if (!fs.existsSync(path.join(dist, 'manifest.json'))) throw new Error(`The extension build left no manifest in ${dist}`)

	// The build, with the two optional capture permissions granted at install (see the top).
	unpacked = path.join(scratch, 'extension')
	fs.cpSync(dist, unpacked, { recursive: true })
	const manifestPath = path.join(unpacked, 'manifest.json')
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
	manifest.permissions.push('pageCapture')
	manifest.host_permissions.push('<all_urls>')
	fs.writeFileSync(manifestPath, JSON.stringify(manifest))

	canary = await startCanary()
	website = await startWebsite(pageHtml(canary.port))
})

test.afterAll(async () => {
	await website?.close()
	await canary?.close()
	fs.rmSync(scratch, { recursive: true, force: true })
})

// ------------------------------------------------------------------ the test

test('the real extension sends an entity, a note and a page capture into the real app', async ({ tangent }) => {
	test.setTimeout(300_000)
	if (process.platform !== 'linux') {
		// Not skipped silently: the Chromium lookup and the canary's owner lookup are Linux's.
		throw new Error('This test resolves Chromium and socket owners the Linux way; port it before running it elsewhere.')
	}

	const window = await tangent.firstWindow()
	const app = window.page
	const appPid = tangent.app.process().pid!

	// Before anything is paired: the app must be on the throwaway profile, not the
	// developer's own.
	const actualUserData = await tangent.app.evaluate(({ app }) => app.getPath('userData'))
	expect(fs.realpathSync(actualUserData)).toBe(fs.realpathSync(userData))

	// The OSINT plugin is up and this window holds the investigation's inbox.
	await expect.poll(() => app.evaluate(() => (globalThis as any).osint?.plugin?.extensionInbox?.active === true),
		{ timeout: 90_000, message: 'the OSINT plugin never started applying the extension inbox' }).toBe(true)

	// The settings page's two calls: switch the channel on, show a pairing string.
	const status = await app.evaluate(() => (window as any).api.osint.extension.setEnabled(true))
	expect(status, JSON.stringify(status)).toMatchObject({ enabled: true, running: true, licensed: true })
	expect(status.port).toEqual(expect.any(Number))
	const pairing: string = (await app.evaluate(() => (window as any).api.osint.extension.pairBegin())).pairingString
	expect(pairing).toMatch(/^ocpair1\./)

	const chromePath = chromiumPath()
	test.info().annotations.push({ type: 'chromium', description: chromePath ?? chromium.executablePath() })
	const profile = path.join(scratch, 'chromium-profile')
	let context: BrowserContext | null = null
	try {
		context = await chromium.launchPersistentContext(profile, {
			executablePath: chromePath,
			headless: process.env.OC_E2E_HEADED !== '1',
			args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
		})
		const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
		const extensionId = new URL(worker.url()).host
		expect(extensionId).toMatch(/^[a-p]{32}$/)

		const site = await context.newPage()
		await site.goto(website.url, { waitUntil: 'load' })
		const panel = await context.newPage()
		await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)

		// Pair. The app's confirm dialog is answered yes by OC_TEST_AUTO_CONFIRM_PAIR.
		await panel.fill('#pair-input', pairing)
		await panel.click('#pair-form button[type=submit]')
		await expect(panel.locator('#connection')).toHaveText('Connected', { timeout: 20_000 })
		const clients = (await app.evaluate(() => (window as any).api.osint.extension.status())).clients
		expect(clients.map((c: any) => c.origin)).toEqual([`chrome-extension://${extensionId}`])

		// Pick the investigation, as a user would.
		const picker = panel.locator('#workspace')
		const option = picker.locator('option', { hasText: WORKSPACE_NAME })
		await expect(option).toHaveCount(1)
		await picker.selectOption((await option.getAttribute('value'))!)
		await expect(panel.locator('#workspace-current')).toHaveText(`To: ${WORKSPACE_NAME}`)

		// Items attach to the active tab of the panel's window.
		await site.bringToFront()
		await expect(panel.locator('#page .page-url')).toHaveText(website.url)

		// 1. The address, as an entity.
		await panel.fill('#entity-value', EMAIL)
		await expect(panel.locator('#entity-kind')).toHaveValue('email')
		await panel.fill('#entity-context', 'Contact line of the directory')
		await panel.click('#entity-form button[type=submit]')
		await expect.poll(async () => (await activity(app)).map(i => i.kind), { timeout: 30_000 }).toEqual(['entity'])

		// 2. A quick note.
		await panel.fill('#note-text', 'Directory lists the leak contact.\nCheck the Friday deadline.')
		await panel.click('#note-form button[type=submit]')
		await expect.poll(async () => (await activity(app)).map(i => i.kind).sort(), { timeout: 30_000 })
			.toEqual(['entity', 'note'])

		// The browser has loaded the page, and been given time to act on its preconnect.
		// From here on the canary must stay silent: the capture is made from what the
		// browser already holds, and the app derives from the archive alone.
		await site.bringToFront()
		await site.waitForLoadState('load')
		// The browser does act on the page's preconnect, which proves the page really
		// points at a live canary: zero below means something.
		await expect.poll(() => canary.connections.length, {
			timeout: 15_000, message: 'the browser never acted on the page\'s preconnect',
		}).toBeGreaterThan(0)
		await new Promise(resolve => setTimeout(resolve, 2000))
		await expect.poll(() => canary.connections.every(c => c.detail !== 'looking up'), { timeout: 10_000 }).toBe(true)
		// Named when ss could still see the client end (Chromium sometimes closes a
		// preconnected socket before it can look): never the app.
		for (const c of canary.connections) {
			if (c.pid !== null) expect(isDescendant(c.pid, appPid), `connection #${c.index} came from the app`).toBe(false)
		}
		const reset = canary.connections.length
		test.info().annotations.push({
			type: 'canary connections while the browser loaded the page',
			description: canary.connections.map(c => c.pid === null ? `unnamed (${c.detail})` : `${c.command} (pid ${c.pid})`).join(', '),
		})

		// 3. The page capture: the panel's button, the three-step upload, then the app
		// derives (utility-process parser, renderArchive) and the renderer places it.
		await panel.click('#capture')
		await expect(panel.locator('#capture-status')).toHaveText('Page capture delivered to OSINT Copilot.', { timeout: 60_000 })
		await expect.poll(async () => (await activity(app)).map(i => i.kind).sort(), { timeout: 90_000 })
			.toEqual(['capture', 'entity', 'note'])

		// Anything the render set off asynchronously has time to arrive.
		await new Promise(resolve => setTimeout(resolve, 3000))
		// Owners are looked up as connections arrive; let the last lookups finish.
		await expect.poll(() => canary.connections.every(c => c.detail !== 'looking up'), { timeout: 10_000 }).toBe(true)
		const after = canary.connections.slice(reset)
		const describe = (c: Connection) =>
			`#${c.index} from ${c.command ?? 'an unknown process'} (pid ${c.pid ?? `?: ${c.detail}`}${c.pid && isDescendant(c.pid, appPid) ? ', the app' : ''})`
		// The window check is the one that does not depend on naming anybody: nothing, from
		// any process, while the page was captured and the app derived and placed it. The
		// owner, where ss could name it, only says who to blame.
		expect(after.map(describe), 'the canary was contacted while the page was captured and derived').toEqual([])
		const fromApp = canary.connections.filter(c => c.pid !== null && isDescendant(c.pid, appPid))
		expect(fromApp.map(describe), 'the app connected to the page\'s canary').toEqual([])

		const items = await activity(app)
		expect(items).toHaveLength(3)
		for (const item of items) {
			expect(item.removed).toBe(false)
			expect(item.outcome, `${item.kind} has an applied outcome`).not.toBeNull()
			expect(item.manifest.page.url).toBe(website.url)
		}
		const entityItem = items.find(i => i.kind === 'entity')!
		const noteItem = items.find(i => i.kind === 'note')!
		const captureItem = items.find(i => i.kind === 'capture')!

		// ---- the entity note, on disk
		expect(entityItem.outcome.created).toBe(true)
		const entity = await app.evaluate((id: string) => {
			const e = (globalThis as any).osint.plugin.entityManager.getEntity(id)
			return e ? { filePath: e.filePath, type: e.type, sources: e.osint_sources ?? [] } : null
		}, entityItem.outcome.entityId)
		expect(entity, 'the entity the email created').not.toBeNull()
		expect(entity!.sources).toEqual([expect.objectContaining({
			id: `ext_${entityItem.bundleId}`, source_url: website.url, via: 'extension',
		})])
		const entityNote = fs.readFileSync(path.join(workspace, entity!.filePath), 'utf8')
		expect(entityNote).toContain(EMAIL)
		expect(entityNote).toMatch(/via:\s*["']?extension/)
		expect(entityNote).toContain(website.url)

		// ---- the page's Sources note, on disk
		const sourcesPaths = new Set(items.map(i => i.outcome.sourcesNotePath))
		expect(sourcesPaths.size, 'all three items share the page\'s Sources note').toBe(1)
		const sourcesPath = path.join(workspace, [...sourcesPaths][0])
		expect(sourcesPath).toContain(`${path.sep}OSINTCopilot${path.sep}Sources${path.sep}`)
		const sources = fs.readFileSync(sourcesPath, 'utf8')
		for (const item of items) {
			expect(sources).toContain(`<!-- oc:bundle ${item.bundleId} -->`)
			expect(sources).toContain(`<!-- /oc:bundle ${item.bundleId} -->`)
		}
		expect(sources).toContain('Directory lists the leak contact.\nCheck the Friday deadline.')
		expect(sources).toMatch(/### Capture: `Contact directory`/)
		expect(sources).toMatch(/- Archive \(MHTML\): \[\[OSINTCopilot\/Evidence\/[a-z0-9-]+\.mhtml\|/)

		// ---- OSINTCopilot/Evidence/, on disk
		const placed: { role: string, path: string, sha256: string, created: boolean }[] = captureItem.outcome.placedFiles
		const byRole = (role: string) => placed.find(f => f.role === role)
		const archive = byRole('archive')
		const fullpage = byRole('fullpage')
		const markdown = byRole('markdown')
		expect(placed.map(f => f.role).sort(), JSON.stringify(placed)).toEqual(expect.arrayContaining(['archive', 'fullpage', 'markdown']))
		for (const f of placed) {
			expect(f.path).toMatch(/^OSINTCopilot\/Evidence\//)
			expect(f.created).toBe(true)
			const onDisk = path.join(workspace, f.path)
			expect(fs.existsSync(onDisk), `${f.path} exists`).toBe(true)
			expect(sha256(onDisk), `${f.path} is the bytes placement reported`).toBe(f.sha256)
		}
		const evidenceDir = path.join(workspace, 'OSINTCopilot', 'Evidence')
		const evidenceFiles = fs.readdirSync(evidenceDir)
		expect(evidenceFiles.filter(n => n.endsWith('.mhtml'))).toHaveLength(1)
		expect(evidenceFiles.filter(n => n.endsWith('.md'))).toHaveLength(1)

		// The archive is the one the extension uploaded: its declared digest, which the
		// server checked the upload against, and the page it came from.
		const declared = captureItem.manifest.capture.files['page.mhtml']
		const archivePath = path.join(workspace, archive!.path)
		expect(sha256(archivePath)).toBe(declared.sha256)
		expect(fs.statSync(archivePath).size).toBe(declared.size)
		const archiveText = fs.readFileSync(archivePath, 'latin1')
		expect(archiveText).toMatch(/Content-Type: multipart\/related/)
		expect(archiveText).toContain('Contact directory')

		// The page text, inert: the address is there, and nothing in it would load.
		const md = fs.readFileSync(path.join(workspace, markdown!.path), 'utf8')
		expect(md).toContain(EMAIL)
		expect(md).not.toMatch(/!\[/)

		// The full-page screenshot: the real renderArchive, laid out to the whole page,
		// not the browser's 720px viewport.
		const png = path.join(workspace, fullpage!.path)
		const { width, height } = pngSize(png)
		expect(width).toBeGreaterThanOrEqual(800)
		expect(height, 'the full page, well past one screen').toBeGreaterThan(3000)
		expect(fs.statSync(png).size).toBeGreaterThan(5_000)
		test.info().annotations.push({ type: 'full-page png', description: `${width}x${height}, ${fs.statSync(png).size} bytes` })

		// ---- the Evidence entity, with both its sources
		expect(captureItem.outcome.created).toBe(true)
		const evidence = await app.evaluate((id: string) => {
			const e = (globalThis as any).osint.plugin.entityManager.getEntity(id)
			return e ? { type: e.type, properties: e.properties, sources: e.osint_sources ?? [], filePath: e.filePath } : null
		}, captureItem.outcome.entityId)
		expect(evidence, 'the Evidence entity').not.toBeNull()
		expect(evidence!.type).toBe('Evidence')
		// The readable markdown is its file; the archive is its second source.
		expect(evidence!.properties.filePath).toBe(markdown!.path)
		expect(evidence!.properties.sha256).toBe(declared.sha256)
		const sourceUrls = evidence!.sources.map((s: any) => s.source_url).sort()
		expect(sourceUrls).toEqual([website.url, `vault://${archive!.path}`].sort())
		for (const s of evidence!.sources) expect(s.via).toBe('extension')
		expect(fs.existsSync(path.join(workspace, evidence!.filePath))).toBe(true)

		// ---- Remove the note: only its section goes
		const removed = await app.evaluate((bundleId: string) =>
			(globalThis as any).osint.plugin.extensionInbox.remove(bundleId), noteItem.bundleId)
		expect(removed).toBe(true)
		await expect.poll(() => fs.readFileSync(sourcesPath, 'utf8'), { timeout: 15_000 })
			.not.toContain(`<!-- oc:bundle ${noteItem.bundleId} -->`)
		const cut = fs.readFileSync(sourcesPath, 'utf8')
		expect(cut).not.toContain('Directory lists the leak contact.')
		expect(cut).toContain(`<!-- oc:bundle ${entityItem.bundleId} -->`)
		expect(cut).toContain(`<!-- oc:bundle ${captureItem.bundleId} -->`)
		expect(cut).toMatch(/### Capture: `Contact directory`/)
		// Exactly the section: what remains is the note as it was, less those lines.
		const noteSection = sources.slice(
			sources.indexOf(`<!-- oc:bundle ${noteItem.bundleId} -->`),
			sources.indexOf(`<!-- /oc:bundle ${noteItem.bundleId} -->`) + `<!-- /oc:bundle ${noteItem.bundleId} -->`.length)
		expect(cut.replace(/\s+/g, ' ')).toBe(sources.replace(noteSection, '').replace(/\s+/g, ' '))

		const afterRemove = await activity(app)
		expect(afterRemove.map(i => [i.kind, i.removed]).sort()).toEqual([['capture', false], ['entity', false], ['note', true]])
		// The entity and the evidence are untouched.
		for (const f of placed) expect(fs.existsSync(path.join(workspace, f.path))).toBe(true)
		expect(fs.existsSync(path.join(workspace, entity!.filePath))).toBe(true)

		// ---- 4. A highlight: the selection, filed in the page's Sources note, with its
		// selectors kept beside it in <note>.annotations.json; Remove takes it back out.
		const phrase = 'before Friday'
		await site.bringToFront()
		await site.evaluate((text: string) => {
			const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const at = (node as Text).data.indexOf(text)
				if (at < 0) continue
				const range = document.createRange()
				range.setStart(node, at)
				range.setEnd(node, at + text.length)
				document.getSelection()!.removeAllRanges()
				document.getSelection()!.addRange(range)
				return
			}
			throw new Error(`"${text}" is not on the page`)
		}, phrase)
		await panel.click('#highlight-create')
		await expect.poll(async () => (await activity(app)).filter(i => i.kind === 'highlight').length, { timeout: 30_000 }).toBe(1)
		const highlightItem = (await activity(app)).find(i => i.kind === 'highlight')!
		const annotation = highlightItem.manifest.highlight.annotation
		expect(annotation.target.selector[0].exact).toBe(phrase)
		expect(highlightItem.outcome.sourcesNotePath).toBe([...sourcesPaths][0])

		const withHighlight = fs.readFileSync(sourcesPath, 'utf8')
		const hlSection = withHighlight.slice(withHighlight.indexOf(`<!-- oc:bundle ${highlightItem.bundleId} -->`))
		expect(hlSection).toMatch(/^<!-- oc:bundle [^\n]+ -->\n### Highlight\n/)
		expect(hlSection).toContain('```\nbefore Friday\n```')
		const sidecarPath = sourcesPath.replace(/\.md$/, '.annotations.json')
		const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))
		const record = sidecar.highlights[annotation.id]
		expect(record).toMatchObject({ deleted: false, section: highlightItem.bundleId, annotation: { id: annotation.id } })
		// The record keeps every selector the extension sent, the quote first.
		expect(record.annotation.target.selector).toEqual(annotation.target.selector)
		expect(record.annotation.target.selector[0]).toMatchObject({ type: 'TextQuoteSelector', exact: phrase })

		expect(await app.evaluate((bundleId: string) =>
			(globalThis as any).osint.plugin.extensionInbox.remove(bundleId), highlightItem.bundleId)).toBe(true)
		await expect.poll(() => fs.readFileSync(sourcesPath, 'utf8'), { timeout: 15_000 })
			.not.toContain(`<!-- oc:bundle ${highlightItem.bundleId} -->`)
		expect(JSON.parse(fs.readFileSync(sidecarPath, 'utf8')).highlights[annotation.id]).toMatchObject({ deleted: true })
		expect(fs.readFileSync(sourcesPath, 'utf8')).toContain(`<!-- oc:bundle ${captureItem.bundleId} -->`)

		// And still nothing reached the canary.
		expect(canary.connections.slice(reset).map(describe)).toEqual([])
	}
	finally {
		await context?.close()
		// The pairing lives in the throwaway userData, removed with the scratch folder.
	}
})
