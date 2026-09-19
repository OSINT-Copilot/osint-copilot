import { test, expect } from '../tangent'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import {
	CAPTURED, CASE_NAME, CONNECTIONS, ENTITIES, HIGHLIGHTS, HOSTS, PAGES, PIVOT_SCRIPT_V2, SETTINGS, STATIC_FILES, URLS, VALUES,
	manifestPdf,
} from './demo-content'

/**
 * Builds the demo investigation, demo/Operation Northgate, by using the product the way an
 * investigator would: the dev build of the app (npm run build:dev) on the demo workspace,
 * and the real browser extension in a real Chromium, visiting fictional web pages served
 * here. Everything in the workspace is written by the app's own code (entity notes,
 * connections, Sources notes, Evidence, the inbox), except the files an investigator would
 * author by hand (prompts, skills, enrichers, a task agent, custom types), which are
 * written first. It also takes the screenshots in demo/screenshots.
 *
 * Run it with `npm run demo` (under xvfb-run on a machine without a display). It deletes
 * and rebuilds the demo folder.
 *
 * The app runs on the developer's own userData, unlike the tests: the extension's items
 * are sealed with that profile's key, and the app lists them in its activity only when
 * they verify. The pairing it makes is revoked and the channel switched back off at the
 * end, so the profile is left as it was.
 */

const repoRoot = path.resolve(__dirname, '../../../..')
const demoRoot = path.join(repoRoot, 'demo')
const workspace = path.join(demoRoot, CASE_NAME)
const shots = path.join(demoRoot, 'screenshots')
const extensionRoot = path.resolve(__dirname, '../../../osint-copilot-extension')
const scratch = path.join(os.tmpdir(), `oc-demo-${process.pid}`)

test.use({
	workspace,
	resetWorkspace: false,
	launchEnv: { OSINT_SKIP_LICENSE: '1', OC_TEST_AUTO_CONFIRM_PAIR: '1' },
})

/** The Chromium to launch, resolved as the extension's e2e does. */
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

// ------------------------------------------------------------------ the fictional web

type Website = { port: number, close(): Promise<void> }

/**
 * Every fictional host, on one local server; Chromium maps their names here. The PDF's
 * address answers a browser tab with a viewer page and the extension's own fetch with
 * the PDF: headless and virtual-display Chromium download a PDF instead of showing it, and
 * the extension captures a PDF tab by fetching its address again.
 */
function startWebsite(): Promise<Website> {
	const pdf = manifestPdf()
	const server = http.createServer((req, res) => {
		const host = (req.headers.host ?? '').replace(/:\d+$/, '')
		const url = `http://${host}${(req.url ?? '/').split('?')[0]}`
		if (url === URLS.manifestPdf && req.headers['sec-fetch-dest'] !== 'document') {
			res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length })
			res.end(pdf)
			return
		}
		const make = PAGES[url]
		if (!make) {
			res.writeHead(404)
			res.end()
			return
		}
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
		res.end(make())
	})
	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => resolve({
			port: (server.address() as net.AddressInfo).port,
			close: () => new Promise<void>(done => {
				server.closeAllConnections()
				server.close(() => done())
			}),
		}))
	})
}

// ------------------------------------------------------------------ the app's side

type ActivityItem = { bundleId: string, kind: string, removed: boolean, manifest: any, outcome: any }

async function activity(app: Page): Promise<ActivityItem[]> {
	return app.evaluate(async () => {
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

/** A picture drawn in the renderer (initials on a colour) and written into the vault. */
async function drawPicture(app: Page, vaultPath: string, spec: { initials: string, color: string, shape: 'person' | 'logo' }) {
	await app.evaluate(async ({ vaultPath, spec }) => {
		const canvas = new OffscreenCanvas(256, 256)
		const g = canvas.getContext('2d')!
		g.fillStyle = spec.color
		if (spec.shape === 'person') {
			g.fillRect(0, 0, 256, 256)
			g.fillStyle = 'rgba(255,255,255,0.18)'
			g.beginPath(); g.arc(128, 104, 56, 0, Math.PI * 2); g.fill()
			g.beginPath(); g.ellipse(128, 250, 96, 78, 0, Math.PI, 0); g.fill()
		}
		else {
			g.fillRect(0, 0, canvas.width, canvas.height)
			g.strokeStyle = 'rgba(255,255,255,0.5)'
			g.lineWidth = 10
			g.strokeRect(18, 18, canvas.width - 36, canvas.height - 36)
		}
		g.fillStyle = '#fff'
		g.textAlign = 'center'
		g.textBaseline = 'middle'
		g.font = 'bold 88px sans-serif'
		g.fillText(spec.initials, canvas.width / 2, spec.shape === 'person' ? 112 : 128)
		const blob = await canvas.convertToBlob({ type: 'image/png' })
		const osint = (globalThis as any).osint
		const dir = vaultPath.split('/').slice(0, -1)
		for (let i = 1; i <= dir.length; i++) {
			const folder = dir.slice(0, i).join('/')
			if (!(await osint.app.vault.adapter.exists(folder))) await osint.app.vault.adapter.mkdir(folder)
		}
		await osint.app.vault.adapter.writeBinary(vaultPath, await blob.arrayBuffer())
	}, { vaultPath, spec })
}

/** Waits until Tangent's own index has a file, so it can be opened. */
async function indexed(app: Page, relative: string) {
	const absolute = path.join(workspace, relative)
	await expect.poll(() => app.evaluate(p => !!(document as any).workspace.directoryStore.get(p), absolute),
		{ timeout: 30_000, message: `Tangent never indexed ${relative}` }).toBe(true)
}

async function openNote(app: Page, relative: string) {
	await indexed(app, relative)
	await app.evaluate(p => {
		const ws = (document as any).workspace
		const node = ws.directoryStore.get(p)
		ws.viewState.tangent.updateThread({ thread: [node], currentNode: node })
	}, path.join(workspace, relative))
}

async function shot(app: Page, name: string) {
	await app.waitForTimeout(1200)
	// The "items added from the extension" notices would cover the top of every picture.
	await app.evaluate(() => document.querySelectorAll('.notice').forEach(n => n.remove()))
	await app.screenshot({ path: path.join(shots, `${name}.png`) })
}

// ------------------------------------------------------------------ setup

let website: Website
let unpacked: string
/** The profile's extension metadata as the demo found it, put back once the app has quit. */
let profileMetadata: { file: string, text: string } | null = null

test.beforeAll(async () => {
	// Only ever the demo folder: it is rebuilt from scratch.
	if (path.dirname(workspace) !== demoRoot) throw new Error(`Refusing to delete ${workspace}`)
	fs.rmSync(workspace, { recursive: true, force: true })
	fs.rmSync(shots, { recursive: true, force: true })
	fs.mkdirSync(shots, { recursive: true })
	fs.mkdirSync(scratch, { recursive: true })

	// What an investigator writes by hand, before the app first opens the folder.
	for (const [relative, text] of Object.entries(STATIC_FILES)) {
		const file = path.join(workspace, relative)
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, text)
	}
	fs.mkdirSync(path.join(workspace, '.osint-copilot'), { recursive: true })
	fs.writeFileSync(path.join(workspace, '.osint-copilot', 'data.json'), JSON.stringify(SETTINGS, null, 2))

	execFileSync(process.execPath, ['build.mjs'], { cwd: extensionRoot, stdio: 'pipe' })
	unpacked = path.join(scratch, 'extension')
	fs.cpSync(path.join(extensionRoot, 'dist'), unpacked, { recursive: true })
	// Capture's two optional permissions, granted at install: Playwright cannot answer
	// Chrome's prompt (as in the extension's e2e).
	const manifestPath = path.join(unpacked, 'manifest.json')
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
	manifest.permissions.push('pageCapture')
	manifest.host_permissions.push('<all_urls>')
	fs.writeFileSync(manifestPath, JSON.stringify(manifest))

	website = await startWebsite()
})

test.afterAll(async () => {
	// The channel is off and the pairing revoked by the test itself; this puts back the
	// last port too, so the file reads exactly as it did.
	if (profileMetadata) fs.writeFileSync(profileMetadata.file, profileMetadata.text)
	await website?.close()
	fs.rmSync(scratch, { recursive: true, force: true })
})

// ------------------------------------------------------------------ the demo

test('build the demo investigation', async ({ tangent }) => {
	test.setTimeout(45 * 60_000)

	const window = await tangent.firstWindow()
	const app = window.page
	await window.setSize({ width: 1600, height: 1000 })

	await expect.poll(() => app.evaluate(() => (globalThis as any).osint?.plugin?.extensionInbox?.active === true),
		{ timeout: 90_000, message: 'the OSINT plugin never started' }).toBe(true)

	// ---- 1. Pictures, then the entities made in the app, with their sources.
	const pictures: Record<string, string> = {}
	for (const e of ENTITIES) {
		if (!e.picture) continue
		const file = `OSINTCopilot/Evidence/${e.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-picture.png`
		await drawPicture(app, file, e.picture)
		pictures[e.key] = file
	}
	const made: Record<string, { id: string, filePath: string, label: string, type: string }> = await app.evaluate(async ({ entities, pictures, captured }) => {
		const em = (globalThis as any).osint.plugin.entityManager
		const out: Record<string, any> = {}
		for (const e of entities) {
			const properties = { ...e.properties, ...(pictures[e.key] ? { image: pictures[e.key] } : {}) }
			const options = { id: e.id, manualLabel: e.label, skipAutoGeocode: true, osint_sources: e.sources ?? [], osint_captured_at: captured }
			const entity = e.api === 'ftm'
				? await em.createFTMEntity(e.schema, properties, options)
				: await em.createEntity(e.schema, properties, options)
			out[e.key] = { id: entity.id, filePath: entity.filePath, label: entity.label, type: entity.type }
		}
		return out
	}, { entities: ENTITIES, pictures, captured: CAPTURED })
	for (const e of ENTITIES) expect(made[e.key]?.id, e.key).toBe(e.id)

	// Catalog entities: STIX 2, MITRE ATT&CK and the case's own user-defined type.
	Object.assign(made, await app.evaluate(async ({ captured, forum, shop, manifest }) => {
		const osint = (globalThis as any).osint
		const em = osint.plugin.entityManager
		await osint.plugin.schemaCatalogService.rebuild()
		const make = async (family: string, type: string, props: Record<string, unknown>, sourceUrl: string) => {
			const e = await em.createCatalogEntity(osint.plugin.schemaCatalogService.getEntityType(family, type), props)
			await em.appendOsintSources(e.id, [{ source_url: sourceUrl, inferred: false, rationale: 'Case analysis', captured_at: captured, archive_status: 'skipped' }], { captured_at: captured })
			return { id: e.id, filePath: e.filePath, label: e.label, type: e.type }
		}
		return {
			campaign: await make('stix2', 'campaign', { name: 'Counterfeit oncology shop', description: 'Sells counterfeit cancer medicines through a forum and a clearnet shop, shipped from Rotterdam.' }, forum),
			indicator: await make('stix2', 'indicator', { name: 'Checkout error page leaks its upstream', pattern: "[url:value MATCHES '/checkout' AND network-traffic:dst_ref.value = '203.0.113.47']", description: 'The shop\'s checkout error names its upstream host.' }, forum),
			technique: await make('mitre', 'attack-pattern', { name: 'Acquire Infrastructure: Domains', external_id: 'T1583.001', description: 'Registering a lookalike shop domain.' }, shop),
			batch: await make('user', 'parcel-batch', { name: 'Pallet NGF-2260 (38 parcels)', parcels: 38, declared_as: 'food supplements', seized_at: '2024-06-20' }, manifest),
		}
	}, { captured: CAPTURED, forum: URLS.forumThread, shop: URLS.shop, manifest: URLS.manifestPdf }))

	// ---- 2. The browser extension: pair it, and collect from the fictional web.
	const userData: string = await tangent.app.evaluate(({ app }) => app.getPath('userData'))
	const metadataFile = path.join(userData, 'osint-extension.json')
	if (fs.existsSync(metadataFile)) profileMetadata = { file: metadataFile, text: fs.readFileSync(metadataFile, 'utf8') }
	const enabled = await app.evaluate(() => (window as any).api.osint.extension.setEnabled(true))
	expect(enabled, JSON.stringify(enabled)).toMatchObject({ enabled: true, running: true })
	const pairing: string = (await app.evaluate(() => (window as any).api.osint.extension.pairBegin())).pairingString

	let context: BrowserContext | null = null
	let clientId: string | null = null
	try {
		try {
			context = await chromium.launchPersistentContext(path.join(scratch, 'chromium-profile'), {
				executablePath: chromiumPath(),
				// Headless, where every tab is drawn: a background tab can be pictured without being
				// brought forward, and the panel keeps following the page beside it.
				headless: process.env.OC_DEMO_HEADED !== '1',
				viewport: { width: 1280, height: 860 },
				args: [
					`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`,
					// The fictional hosts all resolve to the local server, on its port.
					`--host-resolver-rules=MAP *.example 127.0.0.1:${website.port}`,
					// Plain http, as served: no attempt at https first.
					'--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
				],
			})
			const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
			const extensionId = new URL(worker.url()).host

			const site = await context.newPage()
			await site.goto(URLS.forumThread)
			const panel = await context.newPage()
			await panel.setViewportSize({ width: 440, height: 1000 })
			panel.on('dialog', d => void d.accept())
			await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)
			await panel.fill('#pair-input', pairing)
			await panel.click('#pair-form button[type=submit]')
			await expect(panel.locator('#connection')).toHaveText('Connected', { timeout: 20_000 })
			clientId = (await app.evaluate(() => (window as any).api.osint.extension.status())).clients[0].clientId

			const picker = panel.locator('#workspace')
			const option = picker.locator('option', { hasText: CASE_NAME })
			await expect(option).toHaveCount(1)
			await picker.selectOption((await option.getAttribute('value'))!)
			await expect(panel.locator('#workspace-current')).toHaveText(`To: ${CASE_NAME}`)

			// Each item waits until the app has applied it, and items are spaced out: the app
			// accepts at most 20 bundles a minute from one extension.
			let sent = 0
			let lastSend = 0
			const delivered = async (count = 1, timeout = 60_000) => {
				sent += count
				// Every bundle the app has applied is listed, highlight edits and deletes included.
				await expect.poll(async () => (await activity(app)).length, { timeout }).toBe(sent)
			}
			const pace = async () => {
				const wait = lastSend + 3500 - Date.now()
				if (wait > 0) await site.waitForTimeout(wait)
				lastSend = Date.now()
			}
			const onPage = async (url: string) => {
				await site.goto(url, { waitUntil: 'load' })
				await site.bringToFront()
				await expect(panel.locator('#page .page-url')).toHaveText(url)
			}
			const entity = async (value: string, kind: string, extra: { chain?: string, context?: string } = {}) => {
				await pace()
				await panel.fill('#entity-value', value)
				await expect(panel.locator('#entity-kind')).toHaveValue(kind)
				if (extra.chain) await panel.selectOption('#entity-chain', extra.chain)
				await panel.fill('#entity-context', extra.context ?? '')
				await panel.click('#entity-form button[type=submit]')
				await delivered()
			}
			const note = async (text: string) => {
				await pace()
				await panel.fill('#note-text', text)
				await panel.click('#note-form button[type=submit]')
				await delivered()
			}
			const capture = async () => {
				await pace()
				await site.bringToFront()
				await panel.click('#capture')
				await expect(panel.locator('#capture-status')).toHaveText('Page capture delivered to OSINT Copilot.', { timeout: 90_000 })
				await delivered(1, 120_000)
			}
			const highlight = async (phrase: string, withNote?: string) => {
				await pace()
				await site.bringToFront()
				await site.evaluate(text => {
					const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
					for (let n = walker.nextNode(); n; n = walker.nextNode()) {
						const at = (n as Text).data.indexOf(text)
						if (at < 0) continue
						const range = document.createRange()
						range.setStart(n, at)
						range.setEnd(n, at + text.length)
						getSelection()!.removeAllRanges()
						getSelection()!.addRange(range)
						return
					}
					throw new Error(`"${text}" is not on the page`)
				}, phrase)
				await panel.click('#highlight-create')
				await delivered()
				if (withNote) {
					await pace()
					const item = panel.locator('#highlights li', { hasText: phrase })
					await item.locator('textarea').fill(withNote)
					await item.locator('button', { hasText: 'Save note' }).click()
					await delivered()
				}
			}

			// The seller's forum thread.
			await onPage(URLS.forumThread)
			await note('harbor_pharma sells "oncology generics" without prescription, ships from a Rotterdam partner, and takes BTC or ETH only.\nThe clearnet shop is medsupply-direct.example.')
			await entity(VALUES.sellerUsername, 'username', { context: 'Vendor account of the thread' })
			await entity(VALUES.btc, 'wallet', { chain: 'btc', context: 'BTC payment address in post #1' })
			await entity(VALUES.eth, 'wallet', { chain: 'eth', context: 'ETH payment address in post #1' })
			await entity(VALUES.ipv4, 'ip', { context: 'Upstream named by the shop\'s checkout error (post #2)' })
			await highlight(HIGHLIGHTS.rotterdam, 'Rotterdam partner: the shop names Northgate Freight BV. Check the Waalhaven warehouse.')
			// The painted highlight, not the selection that made it; and the panel beside it.
			await site.evaluate(() => getSelection()!.removeAllRanges())
			await site.screenshot({ path: path.join(shots, 'browser-forum-highlight.png') })
			await panel.evaluate(() => window.scrollTo(0, 0))
			await panel.screenshot({ path: path.join(shots, 'extension-side-panel.png') })
			await capture()

			// The shop.
			await onPage(URLS.shop)
			await entity(VALUES.shopEmail, 'email', { context: 'Orders and support' })
			await entity(VALUES.shopDomain, 'domain')
			await entity(VALUES.checkoutUrl, 'url', { context: 'Checkout page' })
			await entity(VALUES.ipv6, 'ip', { context: 'Status line in the footer' })
			await highlight(HIGHLIGHTS.dispatch)
			await capture()

			// The company registry.
			await onPage(URLS.registry)
			await entity(VALUES.kovalEmail, 'email', { context: 'Contact e-mail on file' })
			await highlight(HIGHLIGHTS.incorporated, 'Six weeks before the first BTC payment reached the seller. Check the director.')
			// A highlight made and then deleted: the investigation keeps a tombstone.
			await highlight(HIGHLIGHTS.secretary)
			await pace()
			await panel.locator('#highlights li', { hasText: HIGHLIGHTS.secretary }).locator('button', { hasText: 'Delete' }).click()
			await delivered()
			await capture()

			// The forwarder's own website.
			await onPage(URLS.northgateContact)
			await entity(VALUES.phone, 'phone', { context: 'UK sales line' })
			// The same address as on the registry: the investigation merges it, one entity with two sources.
			await entity(VALUES.kovalEmail, 'email', { context: 'Board contact' })
			await note('Wrong page: this belongs to the shop, not to Northgate.')
			await capture()

			// The quarterly report, a PDF.
			await onPage(URLS.manifestPdf)
			await capture()
		}
		finally {
			await context?.close()
		}

		// The note sent from the wrong page, taken back out as an investigator would.
		const items = await activity(app)
		const wrong = items.find(i => i.kind === 'note' && i.manifest.note.text.startsWith('Wrong page'))!
		expect(await app.evaluate(id => (globalThis as any).osint.plugin.extensionInbox.remove(id), wrong.bundleId)).toBe(true)

		// What the extension's items became, by the value that was sent.
		const byValue = new Map<string, string>()
		for (const i of items) if (i.kind === 'entity') byValue.set(i.manifest.entity.value, i.outcome.entityId)
		for (const [key, value] of Object.entries(VALUES)) {
			const id = [...byValue.entries()].find(([v]) => v.toLowerCase() === value.toLowerCase() || v.replace(/^@/, '') === value.replace(/^@/, ''))?.[1]
			if (id) made[`x:${key}`] = { id, filePath: '', label: value, type: '' }
		}
		const captures = items.filter(i => i.kind === 'capture')
		const captureOf = (url: string) => captures.find(i => i.manifest.page.url === url)!.outcome
		const sourcesNoteOf = (url: string) => items.find(i => i.manifest.page.url === url && i.outcome?.sourcesNotePath)!.outcome.sourcesNotePath as string

		// ---- 3. Connections, now that both ends of each exist.
		const connections = [
			...CONNECTIONS,
			{ from: 'indicator', to: 'campaign', relationship: 'indicates', family: 'stix2' as const },
			{ from: 'campaign', to: 'technique', relationship: 'uses', family: 'stix2' as const },
			{ from: 'campaign', to: 'x:shopDomain', relationship: 'related-to', family: 'stix2' as const },
			{ from: 'batch', to: 'northgate', relationship: 'shipped-via', family: 'user' as const, properties: { description: 'Held by customs on arrival at the warehouse' } },
		]
		const missing = connections.filter(c => !made[c.from] || !made[c.to]).map(c => `${c.from} → ${c.to}`)
		expect(missing, 'connections whose ends were not made').toEqual([])
		await app.evaluate(async ({ connections, ids, captured }) => {
			const em = (globalThis as any).osint.plugin.entityManager
			for (const c of connections) {
				const made = await em.createConnection(ids[c.from], ids[c.to], c.relationship, c.properties ?? {},
					{ schemaFamily: c.family ?? 'ftm', osint_sources: c.sources ?? [], osint_captured_at: captured })
				if (!made) throw new Error(`Could not connect ${c.from} → ${c.to}`)
			}
		}, { connections, ids: Object.fromEntries(Object.entries(made).map(([k, v]) => [k, v.id])), captured: CAPTURED })

		// Everything the app now holds, with the note paths the extension's items got.
		const all: { id: string, label: string, type: string, filePath: string }[] = await app.evaluate(() =>
			(globalThis as any).osint.plugin.entityManager.getAllEntities().map((e: any) => ({ id: e.id, label: e.label, type: e.type, filePath: e.filePath })))
		const pathOf = (key: string) => all.find(e => e.id === made[key].id)!.filePath
		const labelOf = (key: string) => all.find(e => e.id === made[key].id)!.label

		// ---- 4. The graph's layout, and a second graph workspace for the money trail.
		// Placed by role: events along the top, the ownership chain in the middle with its
		// people above and its places below, the seller's side to the right, evidence below.
		const at: Record<string, [number, number]> = {
			ferris: [-560, -300], koval: [0, -300], arendt: [560, -300], 'x:kovalEmail': [-280, -470],
			aurelia: [-560, 0], brightwater: [0, 0], northgate: [560, 0],
			victoria: [-560, 300], limassol: [0, 300], waalhaven: [560, 300],
			northgateDomain: [840, -170], 'x:phone': [840, 130], van: [840, 430], antwerp: [280, 560], batch: [560, 560],
			'x:sellerUsername': [1180, -300], harbour: [1480, -300], 'x:btc': [1180, -560], 'x:eth': [1480, -560],
			'x:shopDomain': [1180, 0], 'x:shopEmail': [1480, 0], 'x:checkoutUrl': [1480, 150],
			'x:ipv4': [1180, 300], 'x:ipv6': [1480, 300], tallinn: [1180, 560],
			campaign: [1800, 0], indicator: [1800, -300], technique: [1800, 300],
		}
		const positions: Record<string, { x: number, y: number }> = {}
		for (const [key, [x, y]] of Object.entries(at)) if (made[key]) positions[made[key].id] = { x, y }
		all.filter(e => e.type === 'Event').forEach((e, i) => { positions[e.id] = { x: i * 280 - 980, y: -820 } })
		all.filter(e => !positions[e.id]).forEach((e, i) => { positions[e.id] = { x: i * 300 - 560, y: 860 } })
		const money: Record<string, [number, number]> = {
			ferris: [-520, -280], koval: [0, -280], aurelia: [-520, 0], brightwater: [0, 0], northgate: [520, 0],
			event34: [520, -280], 'x:btc': [1040, -280], 'x:eth': [1040, 0], 'x:sellerUsername': [1040, 280], 'x:shopDomain': [520, 280],
		}
		const moneyIds = Object.keys(money).map(k => made[k].id)
		const moneyPositions = Object.fromEntries(Object.entries(money).map(([k, [x, y]]) => [made[k].id, { x, y }]))
		await app.evaluate(async layout => {
			await (globalThis as any).osint.app.vault.adapter.write('OSINTCopilot/graph-positions.json', JSON.stringify(layout, null, 2))
		}, {
			version: 3,
			byGraph: { default: positions, 'money-trail': moneyPositions },
			membersByGraph: { default: Object.keys(positions), 'money-trail': moneyIds },
		})

		// ---- 5. A canvas board: people, companies and evidence, with the case's hypotheses.
		const forumCapture = captureOf(URLS.forumThread)
		const pdfCapture = captureOf(URLS.manifestPdf)
		const fileOf = (outcome: any, role: string) => outcome.placedFiles.find((f: any) => f.role === role)?.path as string
		const card = (id: string, key: string, x: number, y: number) =>
			({ id, type: 'file', file: pathOf(key), osintEntityId: made[key].id, x, y, width: 320, height: 210 })
		const manifestEvidence = all.find(e => e.id === pdfCapture.entityId)!
		const board = {
			nodes: [
				{ id: 'g-people', type: 'group', label: 'People', x: -40, y: -60, width: 1280, height: 310 },
				card('ferris', 'ferris', 0, 0), card('koval', 'koval', 440, 0), card('arendt', 'arendt', 880, 0),
				{ id: 'g-companies', type: 'group', label: 'Companies', x: -40, y: 360, width: 1280, height: 310 },
				card('aurelia', 'aurelia', 0, 420), card('brightwater', 'brightwater', 440, 420), card('northgate', 'northgate', 880, 420),
				{ id: 'g-evidence', type: 'group', label: 'Evidence', x: 1320, y: -60, width: 860, height: 730 },
				{ id: 'forum-capture', type: 'file', file: fileOf(forumCapture, 'viewport') ?? fileOf(forumCapture, 'fullpage'), x: 1360, y: 0, width: 380, height: 300 },
				{ id: 'registry-link', type: 'link', url: URLS.registry, x: 1800, y: 0, width: 340, height: 180,
					osintLinkTitle: 'BRIGHTWATER HOLDINGS LTD · HE 412345', osintLinkDescription: 'Registry extract: director, shareholder, registered office',
					osintLinkSite: HOSTS.registry, osintLinkFetchedAt: CAPTURED },
				{ id: 'news-link', type: 'link', url: URLS.news, x: 1800, y: 220, width: 340, height: 180,
					osintLinkTitle: 'Rotterdam customs seize counterfeit cancer drugs', osintLinkDescription: '38 parcels declared as food supplements, forwarded by Northgate Freight BV',
					osintLinkSite: HOSTS.news, osintLinkFetchedAt: CAPTURED },
				{ id: 'manifest', type: 'file', file: manifestEvidence.filePath, osintEntityId: manifestEvidence.id, x: 1360, y: 400, width: 380, height: 230 },
				{ id: 'hypothesis', type: 'text', x: 0, y: 760, width: 560, height: 140,
					text: 'Hypothesis: Brightwater bought into Northgate in April 2024 to control how the counterfeit stock is shipped.' },
				{ id: 'question', type: 'text', x: 640, y: 760, width: 560, height: 140,
					text: 'Open question: who stands behind Aurelia Trade LP? Its only director, Jonah Ferris, is a nominee.' },
			],
			edges: [
				{ id: 'e1', fromNode: 'koval', fromSide: 'bottom', toNode: 'brightwater', toSide: 'top', label: 'director', color: '1' },
				{ id: 'e2', fromNode: 'arendt', fromSide: 'bottom', toNode: 'northgate', toSide: 'top', label: 'managing director', color: '1' },
				{ id: 'e3', fromNode: 'ferris', fromSide: 'bottom', toNode: 'aurelia', toSide: 'top', label: 'nominee director', color: '6' },
				{ id: 'e4', fromNode: 'aurelia', fromSide: 'right', toNode: 'brightwater', toSide: 'left', label: 'owns 100%', color: '4' },
				{ id: 'e5', fromNode: 'brightwater', fromSide: 'right', toNode: 'northgate', toSide: 'left', label: 'owns 60%', color: '4' },
				{ id: 'e6', fromNode: 'manifest', fromSide: 'left', toNode: 'northgate', toSide: 'right', label: 'its manifest', color: '2' },
				{ id: 'e7', fromNode: 'hypothesis', fromSide: 'top', toNode: 'brightwater', toSide: 'bottom', toEnd: 'arrow', color: '5' },
			],
		}
		await app.evaluate(async text => {
			await (globalThis as any).osint.app.vault.adapter.write('OSINTCopilot/boards/Case board.canvas', text)
		}, `${JSON.stringify(board, null, 2)}\n`)

		// ---- 6. The assistant's conversations, through the app's conversation service.
		const link = (key: string) => `[[${pathOf(key).replace(/\.md$/, '')}|${labelOf(key)}]]`
		const chip = (key: string) => ({ id: made[key].id, label: labelOf(key), type: all.find(e => e.id === made[key].id)!.type })
		const memoPath = 'OSINTCopilot/custom/outputs/memos/2026-09-18-case-memo.md'
		const archive = { archive_status: 'skipped' }
		const conversations = [
			{
				title: 'Draft today\'s case memo', taskAgentId: 'case-memo',
				messages: [
					{ role: 'user', content: 'Draft today\'s case memo for the team lead.' },
					{ role: 'assistant', content: `Applied **1** file(s).\n\n**Paths:**\n- \`${memoPath}\`` },
				],
			},
			{
				title: 'Add a breach lookup for the seller\'s e-mail',
				messages: [
					{ role: 'user', content: 'Can we check whether sales@medsupply-direct.example shows up in known breaches? Set up what we need, and extend the pivot script to use certificates.' },
					{
						role: 'assistant',
						content: 'I can\'t reach a breach service from here, so I have prepared what the vault needs for one. Review each change below; nothing is written until you apply it.\n\n- a **skill** telling the assistant how to report breach results without exposing passwords;\n- an **enricher** for a breach directory API, keyed from the credentials folder;\n- a **credentials file** for its key (a placeholder: replace it with your own);\n- a new version of **pivot_domains.py** that also reads Certificate Transparency.',
						proposedCustomVaultOps: [
							{ action: 'upsert_skill', id: 'breach_lookup_triage', name: 'Breach lookup triage', description: 'Report breach hits for an e-mail without exposing secrets', body: '- Report the breach names and dates only; never paste passwords or hashes.\n- Link the e-mail entity to each breach as a source, not as a claim about its owner.\n- Note when a hit predates the address\'s first appearance in the case.' },
							{ action: 'upsert_enricher', id: 'breach-directory', spec: { id: 'breach-directory', name: 'Breach directory', description: 'Known breaches that contain an e-mail address', status: 'active', enabled: true, allowedDomains: ['api.breach-directory.example'], auth: { type: 'header_vault', headerName: 'X-API-Key', vaultRelativePath: 'breach-directory/api-key.txt' }, request: { method: 'GET', urlTemplate: 'https://api.breach-directory.example/v1/email/{{query}}', headers: {} }, inputHints: ['email'], skillInstructions: 'Use for an e-mail address.', limits: { timeoutMs: 15000, retries: 1, maxResponseChars: 6000 } } },
							{ action: 'put_credentials', relativePath: 'breach-directory/api-key.txt', content: 'DEMO-NOT-A-REAL-KEY' },
							{ action: 'upsert_script', relativePath: 'tools/pivot_domains.py', content: PIVOT_SCRIPT_V2 },
						],
					},
				],
			},
			{
				title: 'Who is behind medsupply-direct.example?',
				messages: [
					{ role: 'user', content: 'Who is behind medsupply-direct.example, and how do they ship?' },
					{
						role: 'assistant',
						content: `### Retrieval\n- ${link('x:shopDomain')} — _the shop's domain, sent from its own page_\n- ${link('northgate')} — _named on the shop page as its dispatcher_\n- ${link('brightwater')} — _60% owner of Northgate since April 2024_\n- ${link('koval')} — _Brightwater's sole director_\n\n`
							+ `**In short:** the shop names ${link('northgate')} as its shipper. Northgate is 60% owned by ${link('brightwater')}, whose sole director is ${link('koval')}, and Brightwater is owned by ${link('aurelia')} in the Seychelles, whose only director is a nominee.\n\n`
							+ '**How solid it is**\n- Shop → Northgate: one source, the shop\'s own page. A lead: sellers name shippers to look legitimate.\n- Brightwater → Northgate (60%): one leaked invoice. A lead until the Dutch register shows the transfer.\n- Koval → Brightwater: the registry extract. A finding once a second record agrees.\n- Brightwater\'s country is **conflicted**: the registry says Cyprus, the leaked invoice Malta.\n\n'
							+ '**Open questions**\n- Who stands behind Aurelia Trade LP?\n- Is 203.0.113.47 still the shop\'s upstream? The crt.sh enricher could list its other names.\n- Does the Tallinn consolidator on the forum work for Northgate?',
						usedEntities: [chip('x:shopDomain'), chip('northgate'), chip('brightwater'), chip('koval'), chip('aurelia')],
					},
				],
			},
			{
				title: 'Map the parcel route',
				messages: [
					{ role: 'user', content: 'Where do the parcels go after the Waalhaven warehouse? Add what the forum tells us to the graph.' },
					{
						role: 'assistant',
						content: `One buyer on the forum collected from a Tallinn parcel locker labelled **Baltic Parcel Consolidation OU**. That fits ${link('tallinn')}. No registry names the company yet, so it is a single, unconfirmed source.\n\nI propose adding the consolidator and linking it to the drop point and to ${link('northgate')}. Review the changes below.`,
						proposedModifications: [
							`@@create_entity ${JSON.stringify({ type: 'Company', label: 'Baltic Parcel Consolidation OU', properties: { name: 'Baltic Parcel Consolidation OU', notes: 'Named once on the forum, on a parcel label; not yet in any registry.' }, sources: [{ source_url: URLS.forumThread, inferred: false, rationale: 'A buyer\'s post quotes the parcel label', ...archive }] })}`,
							`@@create_link ${JSON.stringify({ from: 'Baltic Parcel Consolidation OU', to: labelOf('tallinn'), relationship: 'OPERATES' })}`,
							`@@create_link ${JSON.stringify({ from: labelOf('northgate'), to: 'Baltic Parcel Consolidation OU', relationship: 'SHIPS_TO' })}`,
						],
						savedQuery: 'Where do the parcels go after the Waalhaven warehouse? Add what the forum tells us to the graph.',
					},
				],
			},
		]
		await app.evaluate(async ({ conversations, memoPath, memo }) => {
			const osint = (globalThis as any).osint
			const cs = osint.plugin.conversationService
			let at = Date.now() - conversations.length * 3_600_000
			// Saved oldest first: the list shows the newest on top, and the chat opens it.
			for (const c of conversations) {
				const conversation = await cs.createConversation(c.messages[0].content, 'general', c.taskAgentId ?? '')
				conversation.title = c.title
				conversation.messages = c.messages.map((m: any, i: number) => ({ ...m, timestamp: at + i * 60_000 }))
				await cs.saveConversation(conversation)
				at += 3_600_000
			}
			const folder = memoPath.split('/').slice(0, -1)
			for (let i = 1; i <= folder.length; i++) {
				const f = folder.slice(0, i).join('/')
				if (!(await osint.app.vault.adapter.exists(f))) await osint.app.vault.adapter.mkdir(f)
			}
			await osint.app.vault.adapter.write(memoPath, memo)
		}, {
			conversations, memoPath,
			memo: `---\ntitle: Case memo, 18 September 2026\ndate: 2026-09-18\n---\n\n# ${CASE_NAME}: case memo\n\n## Summary\n`
				+ `A forum seller, harbor_pharma, sells counterfeit cancer medicines through ${HOSTS.shop}. The shop names ${link('northgate')} as its shipper; customs seized 38 of Northgate's parcels on 20 June 2024. Northgate is 60% owned by ${link('brightwater')} (director ${link('koval')}), itself owned from the Seychelles through a nominee.\n\n`
				+ `## Chain of ownership\n${link('aurelia')} → 100% → ${link('brightwater')} → 60% → ${link('northgate')}. Aurelia's director, ${link('ferris')}, is a professional nominee (unverified).\n\n`
				+ `## Money\nThe seller takes BTC and ETH only. A ${'€'}48,000 payment from Brightwater to Northgate appears on a leaked invoice (one source).\n\n`
				+ '## Shipping\nConsolidated at the Waalhaven warehouse and declared as food supplements (Q2 2024 manifest). Buyers collect in Tallinn.\n\n'
				+ '## Open questions\n- Who is behind Aurelia Trade LP?\n- Brightwater\'s country: Cyprus or Malta?\n- Who runs the Tallinn consolidator?\n',
		})

		// ---- 7. A case overview, the note an investigator opens first.
		const registrySources = sourcesNoteOf(URLS.registry)
		const overview = `# ${CASE_NAME}\n\n`
			+ 'A fictional investigation, made to show what OSINT Copilot does. Everything in it is invented, including every name, company, address, domain and wallet.\n\n'
			+ `**The case.** A forum seller, harbor_pharma, sells counterfeit cancer medicines through ${HOSTS.shop}. The shop names ${link('northgate')} as its shipper. Customs in Rotterdam seized 38 of its parcels in June 2024. Northgate is 60% owned by ${link('brightwater')}, whose director is ${link('koval')}; Brightwater is owned by ${link('aurelia')} in the Seychelles, through a nominee, ${link('ferris')}.\n\n`
			+ '## Where to look\n'
			+ '- **Entities** (the graph): people, companies, places, events, and the e-mails, wallets, domains and IP addresses collected with the browser extension. Switch to the *Money trail* graph workspace for the payment side only.\n'
			+ '- **Timeline**: from Northgate\'s incorporation in 2019 to the seizure, and one undated rumour.\n'
			+ '- **Locations**: Limassol, Rotterdam, Tallinn and the Seychelles; the Antwerp stash has no coordinates yet ("Geolocate missing").\n'
			+ '- **Chat**: four saved conversations. *Map the parcel route* ends with proposed graph changes to apply; *Add a breach lookup* with proposed vault changes (a skill, an enricher, a credentials file and a script diff).\n'
			+ '- **Tools & Skills**: three case skills, four enrichers (runnable, keyed, draft) and the *Case memo* task agent, whose output is in OSINTCopilot/custom/outputs/memos.\n'
			+ '- **Canvas**: OSINTCopilot/boards/Case board.canvas.\n'
			+ `- **Sources**: one note per page the extension sent from, with its highlights and notes. The registry page: [[${registrySources.replace(/\.md$/, '')}]].\n`
			+ '- **Evidence**: page captures (archive, screenshots, page text) and the forwarder\'s PDF manifest, each with its SHA-256.\n'
			+ '- **Browser extension activity** (command palette): everything the extension sent, including one note taken back out with Remove.\n\n'
			+ '## Confidence\nEach entity grades itself by its sources: Jonah Ferris is *unverified* (an inference), Marta Koval *low* (one record), Daniel Arendt *medium*, Northgate Freight *high*, and Brightwater *conflicted* (two sources disagree on its country). See `osint_confidence` in each note.\n'
		await app.evaluate(async text => {
			await (globalThis as any).osint.app.vault.adapter.write('Case overview.md', text)
		}, overview)

		// ---- 8. Screenshots of each view.
		await app.evaluate(() => (globalThis as any).osint.plugin.refreshOpenInsightViews())
		const openView = async (command: string, ready: string, name: string, settle = 0) => {
			await app.evaluate(c => (document as any).workspace.commands[c].execute(), command)
			await app.locator(ready).first().waitFor({ timeout: 30_000 })
			if (settle) await app.waitForTimeout(settle)
			await shot(app, name)
		}
		// A string, not a function: evaluate runs it as plain JavaScript in the page.
		const graphView = 'globalThis.osint.app.workspace.getLeavesOfType("graph_copilot-graph-view")[0].view'
		await app.evaluate(() => (document as any).workspace.commands.osintOpenGraph.execute())
		await expect.poll(() => app.evaluate(`${graphView}.cy?.nodes().length ?? 0`), { timeout: 30_000 }).toBeGreaterThan(20)
		await app.waitForTimeout(1500)
		await app.evaluate(`${graphView}.cy.fit(undefined, 30)`)
		await shot(app, 'graph')
		await app.evaluate(`${graphView}.switchGraphWorkspace('money-trail')`)
		await app.waitForTimeout(1500)
		await app.evaluate(`${graphView}.cy.fit(undefined, 60)`)
		await shot(app, 'graph-money-trail')
		await app.evaluate(`${graphView}.switchGraphWorkspace('default')`)
		await app.evaluate(() => (globalThis as any).osint.plugin.setActiveGraphId('default'))
		await openView('osintOpenTimeline', '.graph_copilot-timeline-event', 'timeline')
		await openView('osintOpenMap', '.graph_copilot-map-marker', 'map', 6000)
		await openView('osintOpenRegistry', '.osint-copilot-registry-row', 'tools-and-skills')
		await openView('osintOpenChat', '.vault-ai-chat-view', 'chat', 2000)
		await openNote(app, 'OSINTCopilot/boards/Case board.canvas')
		await app.locator('.canvas-card').first().waitFor({ timeout: 30_000 })
		await shot(app, 'canvas')
		await openNote(app, registrySources)
		await shot(app, 'sources-note')
		await openNote(app, 'Case overview.md')
		await shot(app, 'case-overview')
		await app.evaluate(() => (globalThis as any).osint.plugin.openExtensionActivity())
		await app.locator('.osint-extension-activity-item').first().waitFor({ timeout: 30_000 })
		await shot(app, 'extension-activity')
		await app.keyboard.press('Escape')

		// What was built, for the log.
		const summary = await activity(app)
		test.info().annotations.push({
			type: 'demo',
			description: `${all.length} entities; ${summary.length} extension items (${summary.filter(i => i.removed).length} removed)`,
		})
	}
	finally {
		// ---- 9. Leave the profile as it was, whatever happened: the demo's pairing revoked,
		// the channel off.
		if (clientId) await app.evaluate(id => (window as any).api.osint.extension.revoke(id), clientId)
		const after = await app.evaluate(() => (window as any).api.osint.extension.setEnabled(false))
		expect(after.clients).toEqual([])
	}
})
