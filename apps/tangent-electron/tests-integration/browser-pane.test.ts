import { test, expect } from './tangent'
import http from 'http'
import fs from 'fs'
import path from 'path'

/**
 * Browsing pane behaviour: what it remembers, and what it refuses to do with it.
 */

const MARKER = 'RESTORE-PAGE-MARKER'

async function startServer() {
	// Counting here rather than with a second server: the question is whether a RESTORED
	// pane reaches for the address it remembered, and that address is this one.
	let hits = 0
	const server = http.createServer((_req, res) => {
		hits += 1
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(`<!doctype html><title>Restore probe</title><h1>${MARKER}</h1>`)
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	return {
		url: `http://127.0.0.1:${(server.address() as any).port}/`,
		get hits() { return hits },
		close: () => new Promise<void>(r => { server.close(() => r()) }),
	}
}

/**
 * MHTML bodies are quoted-printable, which wraps at 76 columns with a trailing `=`. A
 * marker can therefore be split across two lines, and a naive substring check fails on a
 * snapshot that is perfectly correct.
 */
function unwrapQuotedPrintable(mhtml: string): string {
	return mhtml.replace(/=\r?\n/g, '')
}

async function waitForNode(window: any, relativePath: string, workspacePath: string) {
	const absolute = path.join(workspacePath, relativePath)
	await expect.poll(
		() => window.page.evaluate(
			(p: string) => !!(document as any).workspace?.directoryStore?.get(p), absolute),
		{ timeout: 10_000, message: `${relativePath} never reached the directory store` },
	).toBe(true)
}

test('a pane remembers where it was, and does not go back there on its own', async ({ tangent, workspace }) => {
	// Several deliberate waits: a debounced write, an unmount/remount, and a quiet period
	// to let a misbehaving pane actually misbehave. Comfortably past the 30s default.
	test.setTimeout(120_000)
	const server = await startServer()
	try {
		const window = await tangent.firstWindow()

		const paneFile = path.join(workspace, 'Remembers.osintbrowse')
		fs.writeFileSync(paneFile, JSON.stringify({}))
		fs.writeFileSync(path.join(workspace, 'Elsewhere.md'), '# Elsewhere\n')
		await waitForNode(window, 'Remembers.osintbrowse', workspace)
		await waitForNode(window, 'Elsewhere.md', workspace)
		await window.setThread({ paths: ['Remembers.osintbrowse'] })

		const status = window.page.locator('[data-testid="browse-status"]')
		await expect(status).toContainText('Ready · guest', { timeout: 15_000 })

		// --- it records where it went -------------------------------------------------
		await window.page.locator('.BrowserPaneView .address').fill(server.url)
		await window.page.locator('.BrowserPaneView .address').press('Enter')

		await expect.poll(
			() => { try { return JSON.parse(fs.readFileSync(paneFile, 'utf8')).url } catch { return undefined } },
			{ timeout: 10_000, message: 'the pane never wrote the address it navigated to' },
		).toBe(server.url)

		// --- and comes back parked ----------------------------------------------------
		// Reopening is the restore path. A thread of panes must not fire a live request
		// each on restore: the operator may not have meant to be online, may not have the
		// profile they intend loaded, and a request cannot be taken back.
		// Navigate the thread away and back: that unmounts and remounts the pane, which is
		// the same path a restored session takes.
		await window.setThread({ paths: ['Elsewhere.md'] })
		await window.page.waitForTimeout(500)

		const hitsBeforeRestore = server.hits
		await window.setThread({ paths: ['Remembers.osintbrowse'] })

		const parked = window.page.locator('[data-testid="browse-parked"]')
		await expect(parked).toBeVisible({ timeout: 15_000 })
		await expect(parked).toContainText(server.url)

		// Give it room to misbehave before declaring that it did not.
		await window.page.waitForTimeout(1500)
		expect(server.hits - hitsBeforeRestore,
			'a restored pane fetched the page it remembered without being asked').toBe(0)

		// --- until the operator says so -----------------------------------------------
		// Invoked directly rather than with a synthetic mouse click. The window is larger
		// than the test display, so page coordinates do not reliably map to the screen,
		// and Playwright's hit test is unreliable through an out-of-process <webview>
		// anyway. What is under test is the behaviour -- parked until explicitly asked --
		// and the assertions above already establish the control is visible and labelled.
		await parked.locator('button').evaluate((el: HTMLButtonElement) => el.click())
		await expect(parked).toBeHidden({ timeout: 15_000 })

		// Polled, not sampled once: loading is asynchronous, and a snapshot taken mid-load
		// is a real snapshot of a page that has not arrived yet.
		await expect.poll(async () => {
			const id = await window.page.locator('[data-testid="browse-guest"]')
				.getAttribute('data-guest-id')
			if (!id) return ''
			const mhtml = await window.page.evaluate(
				(i: number) => (globalThis as any).api.osint.browse.snapshot(i), Number(id))
			return unwrapQuotedPrintable(mhtml)
		}, { timeout: 15_000, message: 'the pane never loaded the address it had parked' })
			.toContain(MARKER)
	}
	finally {
		await server.close()
	}
})
