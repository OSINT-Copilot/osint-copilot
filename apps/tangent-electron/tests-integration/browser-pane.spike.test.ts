import { test, expect } from './tangent'
import http from 'http'
import fs from 'fs'
import path from 'path'

/**
 * SPIKE: does a <webview> guest survive the thread's pane machinery?
 *
 * This is the question the browsing feature is gated on, and it is asked before any file
 * format or IPC shape is settled, because the answer decides the vehicle. Panes are
 * `position: sticky` columns in a horizontal scroller; they enter with `in:fly` and
 * reorder with `animate:flip`; they clip with `overflow: hidden`. A native
 * `WebContentsView` cannot follow any of that -- but a `<webview>` is an out-of-process
 * frame, and OOPIF rendering detaching under transforms is a real failure mode,
 * especially on Linux.
 *
 * "Alive" is asserted by taking an MHTML snapshot through CDP and looking for the page's
 * own marker. That is stronger than checking the element is still in the DOM, and it
 * exercises the capture path the whole feature depends on at the same time.
 */

const MARKER = 'SPIKE-PAGE-MARKER'
const PAGE = `<!doctype html><html><head><title>Spike</title></head>
<body style="font:16px sans-serif"><h1 id="marker">${MARKER}</h1>
<p>A page served locally so the spike does not depend on the network.</p></body></html>`

async function startServer(): Promise<{ url: string, close: () => Promise<void> }> {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(PAGE)
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const port = (server.address() as any).port
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
	}
}

/** The watcher is asynchronous; wait for the node to reach the renderer's store. */
async function waitForNode(window: any, relativePath: string, workspacePath: string) {
	const absolute = path.join(workspacePath, relativePath)
	await expect.poll(
		() => window.page.evaluate(
			(p: string) => !!(document as any).workspace?.directoryStore?.get(p), absolute),
		{ timeout: 10_000, message: `${relativePath} never reached the directory store` },
	).toBe(true)
}

test('a live web page renders in a thread pane, and survives scrolling and reordering', async ({ tangent, workspace }) => {
	const server = await startServer()
	try {
		const window = await tangent.firstWindow()

		// Three notes so the browsing pane has sticky neighbours on both sides.
		for (const name of ['Alpha', 'Beta', 'Gamma']) {
			fs.writeFileSync(path.join(workspace, `${name}.md`), `# ${name}\n\nfiller\n`)
		}
		fs.writeFileSync(path.join(workspace, 'Browse.osintbrowse'), JSON.stringify({}))

		for (const f of ['Alpha.md', 'Beta.md', 'Gamma.md', 'Browse.osintbrowse']) {
			await waitForNode(window, f, workspace)
		}

		await window.setThread({ paths: ['Alpha.md', 'Beta.md', 'Browse.osintbrowse', 'Gamma.md'] })

		// --- the guest attaches at all -------------------------------------------------
		// Reaching "Ready" means main's will-attach-webview accepted the session token and
		// the guest got a webContents. A refused attach never produces one.
		const status = window.page.locator('[data-testid="browse-status"]')
		await expect(status).toContainText('Ready · guest', { timeout: 15_000 })

		// Read fresh each time rather than caching: a guest that navigates, crashes or is
		// remounted gets a new id, and asking main about a stale one looks like a crash.
		const guestId = async () => {
			const raw = await window.page.locator('[data-testid="browse-guest"]')
				.getAttribute('data-guest-id')
			return raw ? Number(raw) : null
		}
		expect(await guestId()).toBeGreaterThan(0)

		// --- it loads a real page ------------------------------------------------------
		await window.page.locator('.BrowserPaneView .address').fill(server.url)
		await window.page.locator('.BrowserPaneView .address').press('Enter')
		await expect(status).toContainText('Ready · guest', { timeout: 15_000 })

		const snapshot = async () => {
			const id = await guestId()
			if (id == null) return ''
			return window.page.evaluate(
				(i: number) => (globalThis as any).api.osint.browse.snapshot(i), id)
		}

		await expect.poll(async () => (await snapshot()).includes(MARKER),
			{ timeout: 15_000, message: 'the guest never rendered the served page' }).toBe(true)

		// --- kill criterion: horizontal scroll against sticky neighbours ---------------
		await window.setSize({ width: 900, height: 700 })
		const strip = window.page.locator('.ThreadView')
		await strip.evaluate((el: HTMLElement) => { el.scrollLeft = el.scrollWidth })
		await window.page.waitForTimeout(400)
		await strip.evaluate((el: HTMLElement) => { el.scrollLeft = 0 })
		await window.page.waitForTimeout(400)

		expect(await snapshot(), 'the guest died during horizontal scroll').toContain(MARKER)

		// --- kill criterion: animate:flip reorder, and in:fly on a new neighbour --------
		await window.setThread({ paths: ['Gamma.md', 'Browse.osintbrowse', 'Alpha.md'] })
		await window.page.waitForTimeout(600)
		await window.setThread({ paths: ['Alpha.md', 'Beta.md', 'Browse.osintbrowse', 'Gamma.md'] })
		await window.page.waitForTimeout(600)

		expect(await snapshot(), 'the guest died during a pane reorder').toContain(MARKER)

		// --- the element is still laid out, not collapsed to nothing -------------------
		const box = await window.page.locator('[data-testid="browse-guest"]').boundingBox()
		expect(box, 'the guest element has no box').not.toBeNull()
		expect(box!.width).toBeGreaterThan(50)
		expect(box!.height).toBeGreaterThan(50)
	}
	finally {
		await server.close()
	}
})

test('main refuses a <webview> the renderer conjures on its own', async ({ tangent }) => {
	const window = await tangent.firstWindow()

	// The renderer can create the element -- webviewTag is on -- but it cannot produce a
	// session token, and an attach without a recognised one is vetoed in main. This is
	// what makes enabling the tag safe: the flag alone would let anything running in this
	// renderer attach a guest with a preload of its choosing.
	const result = await window.page.evaluate(async () => {
		const el = document.createElement('webview') as any
		el.setAttribute('src', 'https://example.com/')
		el.setAttribute('partition', 'persist:not-a-real-token')
		el.style.width = '200px'
		el.style.height = '200px'
		document.body.appendChild(el)

		await new Promise(r => setTimeout(r, 2000))

		let id: number | null = null
		try { id = el.getWebContentsId() }
		catch { id = null }
		el.remove()
		return id
	})

	expect(result, 'an unsanctioned <webview> was allowed to attach').toBeNull()
})
