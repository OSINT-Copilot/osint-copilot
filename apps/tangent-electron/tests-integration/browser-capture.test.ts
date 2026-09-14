import { test, expect } from './tangent'
import http from 'http'
import fs from 'fs'
import path from 'path'

/**
 * Capture: turning a live page into evidence, and evidence into a graph entity.
 *
 * This is the loop the whole feature exists for, and the one Ostium does not have -- its
 * Investigation Board is a standalone JSON whiteboard that does not know its browser
 * exists. Here the page, the archive, the hash and the entity are one chain.
 */

const MARKER = 'CAPTURE-BODY-MARKER'

function unwrapQuotedPrintable(mhtml: string): string {
	return mhtml.replace(/=\r?\n/g, '')
}

async function startServer() {
	let version = 1
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(`<!doctype html>
<html><head><title>Captured Page</title>
<script id="__NEXT_DATA__" type="application/json">{"noise":"should-not-appear"}</script>
</head><body>
<h1>${MARKER}</h1>
<p>Version ${version}. A <a href="/relative/link">relative link</a>.</p>
</body></html>`)
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	return {
		base: `http://127.0.0.1:${(server.address() as any).port}`,
		bump: () => { version += 1 },
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
	await expect.poll(async () => {
		const id = await window.page.locator('[data-testid="browse-guest"]').getAttribute('data-guest-id')
		if (!id) return ''
		return unwrapQuotedPrintable(await window.page.evaluate(
			(i: number) => (globalThis as any).api.osint.browse.snapshot(i), Number(id)))
	}, { timeout: 20_000, message: `never loaded ${url}` }).toContain(MARKER)
}

const evidenceDir = (workspace: string) => path.join(workspace, 'OSINTCopilot', 'Evidence')

test('a captured page becomes an archive, a reading, and a hash that all describe one moment', async ({ tangent, workspace }) => {
	test.setTimeout(180_000)
	const server = await startServer()
	try {
		const window = await tangent.firstWindow()
		await openPane(window, workspace, 'Cap.osintbrowse')
		await visit(window, `${server.base}/page`)

		await window.page.locator('.BrowserPaneView button.capture')
			.evaluate((el: HTMLButtonElement) => el.click())

		const note = window.page.locator('[data-testid="browse-capture-note"]')
		await expect(note).toContainText('Captured', { timeout: 30_000 })

		// --- three files, one moment ---------------------------------------------------
		await expect.poll(() => fs.existsSync(evidenceDir(workspace))
			? fs.readdirSync(evidenceDir(workspace)) : [],
			{ timeout: 15_000, message: 'nothing was written to the Evidence folder' })
			.toEqual(expect.arrayContaining([
				expect.stringMatching(/\.mhtml$/),
				expect.stringMatching(/\.md$/),
			]))

		const files = fs.readdirSync(evidenceDir(workspace))
		// Nothing half-written is left behind: writes go through a .part name and rename.
		expect(files.filter(f => f.endsWith('.part'))).toEqual([])

		const markdownFile = files.find(f => f.endsWith('.md'))!
		const markdown = fs.readFileSync(path.join(evidenceDir(workspace), markdownFile), 'utf8')

		expect(markdown).toContain(MARKER)
		// The archive's hash is recorded with the reading it was derived from.
		expect(markdown).toMatch(/sha256: [0-9a-f]{64}/)
		// Script payloads are not evidence; they are noise that drowns it.
		expect(markdown).not.toContain('should-not-appear')
		expect(markdown).not.toContain('__NEXT_DATA__')
		// A relative link in captured evidence is a dangling reference.
		expect(markdown).toContain(`${server.base}/relative/link`)

		// --- and the index knows about it ----------------------------------------------
		const indexPath = path.join(workspace, 'OSINTCopilot', 'browsing', 'captures.json')
		const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
		expect(index.captures).toHaveLength(1)
		expect(index.captures[0].sha256).toMatch(/^[0-9a-f]{64}$/)
		expect(index.captures[0].url).toBe(`${server.base}/page`)

		// --- capturing an unchanged page writes nothing ---------------------------------
		// Armed browsing settles repeatedly on a long page; without this a morning on one
		// site is gigabytes of near-identical archives.
		await window.page.locator('.BrowserPaneView button.capture')
			.evaluate((el: HTMLButtonElement) => el.click())
		await expect(note).toContainText('Unchanged since the last capture', { timeout: 30_000 })
		expect(JSON.parse(fs.readFileSync(indexPath, 'utf8')).captures).toHaveLength(1)

		// --- promotion is an act, and it reaches the graph -------------------------------
		await window.page.locator('[data-testid="browse-promote"]')
			.evaluate((el: HTMLButtonElement) => el.click())
		await expect(note).toContainText('Added as evidence', { timeout: 30_000 })

		// The Evidence entity is a real note in the vault, carrying both source records:
		// the live URL, so the Wayback service can resolve an independent snapshot, and
		// the vault path, which still works when the page is gone.
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
			return found
				.map(f => fs.readFileSync(f, 'utf8'))
				.filter(text => text.includes('osint_sources') && text.includes('vault://'))
				.length
		}, { timeout: 30_000, message: 'no entity note carrying the capture as a source' })
			.toBeGreaterThan(0)
	}
	finally {
		await server.close()
	}
})

test('an armed identity captures what it is shown, without being asked', async ({ tangent, workspace }) => {
	test.setTimeout(180_000)
	const server = await startServer()
	try {
		const window = await tangent.firstWindow()
		await openPane(window, workspace, 'Armed.osintbrowse')

		// Off by default, and turning it on is a deliberate act: this writes every page
		// the operator looks at, as this identity, to disk.
		const arm = window.page.locator('[data-testid="browse-arm"]')
		await expect(arm).toContainText('○ Record')
		await arm.evaluate((el: HTMLButtonElement) => el.click())
		await expect(arm).toContainText('● Recording')

		await visit(window, `${server.base}/first`)

		// Nothing was pressed. This is the "I forgot to press record" case the whole
		// category exists for, and the trigger is a load-settle rather than a navigation
		// commit -- MHTML serialises the current DOM, so committing too early archives a
		// near-empty document.
		const indexPath = path.join(workspace, 'OSINTCopilot', 'browsing', 'captures.json')
		await expect.poll(
			() => fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')).captures.length : 0,
			{ timeout: 30_000, message: 'an armed profile captured nothing on its own' })
			.toBe(1)

		const captured = JSON.parse(fs.readFileSync(indexPath, 'utf8')).captures[0]
		expect(captured.url).toBe(`${server.base}/first`)
		// The body, not a spinner.
		const markdown = fs.readFileSync(path.join(workspace, captured.files.markdown), 'utf8')
		expect(markdown).toContain(MARKER)

		// Disarming stops it, rather than merely hiding the indicator.
		await arm.evaluate((el: HTMLButtonElement) => el.click())
		await expect(arm).toContainText('○ Record')
		server.bump()
		await visit(window, `${server.base}/second`)
		await window.page.waitForTimeout(3000)
		expect(JSON.parse(fs.readFileSync(indexPath, 'utf8')).captures).toHaveLength(1)
	}
	finally {
		await server.close()
	}
})
