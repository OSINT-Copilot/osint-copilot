import { test, expect } from './tangent'
import http from 'http'
import fs from 'fs'
import path from 'path'

/**
 * The watchlist: what an investigation is looking for, checked against every page.
 *
 * Hunchly's defining feature, and the cheapest entity extraction that actually works --
 * the analyst says what matters once, and every page is checked against it.
 */

const PHONE = '+44 7700 900123'
const NAME = 'Ada Lovelace'

async function startServer() {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		if (req.url?.startsWith('/other')) {
			res.end(`<!doctype html><title>Other</title><body><p>Nothing of interest here.</p></body>`)
			return
		}
		res.end(`<!doctype html><title>Profile</title><body>
			<h1>${NAME}</h1>
			<p>Reach the office on ${PHONE} during business hours.</p>
			<p style="display:none">hidden-stuffing-should-not-match</p>
		</body>`)
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	return {
		base: `http://127.0.0.1:${(server.address() as any).port}`,
		close: () => new Promise<void>(r => { server.close(() => r()) }),
	}
}

async function waitForNode(window: any, relativePath: string, workspacePath: string) {
	await expect.poll(
		() => window.page.evaluate(
			(p: string) => !!(document as any).workspace?.directoryStore?.get(p),
			path.join(workspacePath, relativePath)),
		{ timeout: 10_000, message: `${relativePath} never reached the directory store` },
	).toBe(true)
}

function writeSelectors(workspace: string, selectors: unknown[]) {
	const dir = path.join(workspace, 'OSINTCopilot', 'browsing')
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, 'selectors.json'), JSON.stringify({ selectors }, null, '\t'))
}

async function openPane(window: any, workspace: string, name: string) {
	fs.writeFileSync(path.join(workspace, name), JSON.stringify({}))
	await waitForNode(window, name, workspace)
	await window.setThread({ paths: [name] })
	await expect(window.page.locator('[data-testid="browse-status"]'))
		.toContainText('Ready · guest', { timeout: 20_000 })
}

async function visit(window: any, url: string) {
	await window.page.locator('.BrowserPaneView .address').fill(url)
	await window.page.locator('.BrowserPaneView .address').press('Enter')
}

test('a watchlist flags what it is looking for, without anything being captured', async ({ tangent, workspace }) => {
	test.setTimeout(180_000)
	const server = await startServer()
	try {
		const window = await tangent.firstWindow()

		writeSelectors(workspace, [
			{ id: 'target', label: 'Target name', kind: 'text', pattern: NAME, entityType: 'Person' },
			{ id: 'phone', label: 'Phone', kind: 'regex', pattern: '\\+44 7\\d{3} \\d{6}', entityType: 'Phone' },
			{ id: 'off', label: 'Disabled', kind: 'text', pattern: 'business', enabled: false },
		])
		await openPane(window, workspace, 'Watch.osintbrowse')

		// Watching is turned on; capture is NOT. That combination is the whole reason the
		// two toggles are independent: capture is off by default, so a matcher fed only
		// from captured text would find nothing during almost all real browsing.
		const watch = window.page.locator('[data-testid="browse-watch"]')
		await expect(watch).toContainText('◎ Watch')
		await watch.evaluate((el: HTMLButtonElement) => el.click())
		await expect(watch).toContainText('◉ Watching')
		await expect(window.page.locator('[data-testid="browse-arm"]')).toContainText('○ Record')

		await visit(window, `${server.base}/profile`)

		const hits = window.page.locator('[data-testid="browse-hits"]')
		await expect(hits).toBeVisible({ timeout: 30_000 })
		await expect(hits).toContainText(NAME)
		await expect(hits).toContainText(PHONE)
		// A disabled selector does not run.
		await expect(hits).not.toContainText('Disabled')
		// innerText, not textContent: hidden SEO stuffing is not something an analyst
		// should have to explain away in a case file.
		await expect(hits).not.toContainText('hidden-stuffing')

		// Nothing was written down -- watching and recording are different decisions.
		expect(fs.existsSync(path.join(workspace, 'OSINTCopilot', 'browsing', 'captures.json')))
			.toBe(false)

		// --- a hit is a proposal until someone accepts it -------------------------------
		await hits.locator('.hit button').first().evaluate((el: HTMLButtonElement) => el.click())
		await expect(hits.locator('.promoted').first()).toBeVisible({ timeout: 30_000 })

		// It reaches the graph marked inferred and unverified: the page said this, which
		// is not the same as it being true.
		await expect.poll(() => {
			const found: string[] = []
			const walk = (dir: string) => {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name)
					if (entry.isDirectory()) walk(full)
					else if (entry.name.endsWith('.md')) found.push(full)
				}
			}
			const root = path.join(workspace, 'OSINTCopilot')
			if (fs.existsSync(root)) walk(root)
			return found.map(f => fs.readFileSync(f, 'utf8'))
				.filter(t => t.includes('inferred: true') && t.includes('Watchlist'))
				.length
		}, { timeout: 30_000, message: 'no entity note was written for the accepted hit' })
			.toBeGreaterThan(0)

		// --- and a page with nothing on it produces nothing ------------------------------
		await visit(window, `${server.base}/other`)

		// Asserted against the whole pane rather than the hits panel, because the panel is
		// expected to DISAPPEAR -- and `not.toContainText` on a locator matching nothing
		// waits for it to appear and then fails, which would pass for the wrong reason
		// only by accident. What matters is that the previous page's findings are not on
		// screen under this address.
		await expect(window.page.locator('.BrowserPaneView'))
			.not.toContainText(PHONE, { timeout: 30_000 })
		await expect(hits).toHaveCount(0)
	}
	finally {
		await server.close()
	}
})

test('a selector added later still finds what was already captured', async ({ tangent, workspace }) => {
	test.setTimeout(180_000)
	const server = await startServer()
	try {
		const window = await tangent.firstWindow()

		// Nothing is being watched for yet -- the analyst does not know what matters.
		writeSelectors(workspace, [])
		await openPane(window, workspace, 'Later.osintbrowse')

		await window.page.locator('[data-testid="browse-arm"]')
			.evaluate((el: HTMLButtonElement) => el.click())
		await visit(window, `${server.base}/profile`)

		const indexPath = path.join(workspace, 'OSINTCopilot', 'browsing', 'captures.json')
		await expect.poll(
			() => fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')).captures.length : 0,
			{ timeout: 30_000, message: 'the armed pane captured nothing' }).toBe(1)

		// The capture kept the text the matcher sees, so a re-scan is the SAME scan rather
		// than a different operation over a different reading of the page.
		const captured = JSON.parse(fs.readFileSync(indexPath, 'utf8')).captures[0]
		expect(captured.files.text).toBeTruthy()
		expect(fs.readFileSync(path.join(workspace, captured.files.text), 'utf8')).toContain(PHONE)

		// Now the analyst learns what they were looking for. A watchlist that only looked
		// forward would be the less useful half of the feature.
		writeSelectors(workspace, [
			{ id: 'phone', label: 'Phone', kind: 'regex', pattern: '\\+44 7\\d{3} \\d{6}' },
		])
		const watch = window.page.locator('[data-testid="browse-watch"]')
		await watch.evaluate((el: HTMLButtonElement) => el.click())

		await window.page.locator('[data-testid="browse-hits"] .hit-foot button')
			.evaluate((el: HTMLButtonElement) => el.click())
			.catch(async () => {
				// The hits panel only renders once there is something to show; re-scan from
				// the API directly if the pane has not been given a live hit yet.
				await window.page.evaluate(() => (globalThis as any).api.osint.browse.rescan())
			})

		await expect.poll(
			() => window.page.evaluate(async () => {
				const results = await (globalThis as any).api.osint.browse.rescan()
				return results.reduce((sum: number, r: any) => sum + r.hits.length, 0)
			}),
			{ timeout: 30_000, message: 're-scanning found nothing in the captured page' })
			.toBeGreaterThan(0)
	}
	finally {
		await server.close()
	}
})
