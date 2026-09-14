import { test, expect } from './tangent'
import http from 'http'
import fs from 'fs'
import path from 'path'

/**
 * Profiles: separate identities to browse as.
 *
 * The claim being tested is the narrow, honest one -- COMPARTMENTALISATION. One profile's
 * cookies and logins cannot reach another profile's sites. It is deliberately not a test
 * of anonymity, because the feature does not provide anonymity: across every profile a
 * site still sees one machine's fingerprint, timezone and GPU. That is what the Reality
 * Check exists to tell the operator, and it is asserted separately below.
 */

function unwrapQuotedPrintable(mhtml: string): string {
	return mhtml.replace(/=\r?\n/g, '')
}

/** Sets a cookie on /set, and reports whether it came back on /read. */
async function startCookieServer() {
	const server = http.createServer((req, res) => {
		if (req.url?.startsWith('/set')) {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'set-cookie': 'who=alpha; Path=/; Max-Age=600',
			})
			res.end('<!doctype html><title>set</title>\n<p>COOKIE-WAS-SET</p>\n')
			return
		}
		const seen = /who=alpha/.test(req.headers.cookie ?? '')
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end(`<!doctype html><title>read</title>\n<p>${seen ? 'COOKIE-PRESENT' : 'COOKIE-ABSENT'}</p>\n`)
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const base = `http://127.0.0.1:${(server.address() as any).port}`
	return { base, close: () => new Promise<void>(r => { server.close(() => r()) }) }
}

async function waitForNode(window: any, relativePath: string, workspacePath: string) {
	const absolute = path.join(workspacePath, relativePath)
	await expect.poll(
		() => window.page.evaluate(
			(p: string) => !!(document as any).workspace?.directoryStore?.get(p), absolute),
		{ timeout: 10_000, message: `${relativePath} never reached the directory store` },
	).toBe(true)
}

function writeProfiles(workspace: string, profiles: unknown[]) {
	const dir = path.join(workspace, 'OSINTCopilot', 'browsing')
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ profiles }, null, '\t'))
}

/** Navigate the open pane and wait for the page to actually be there. */
async function visit(window: any, url: string, expected: string) {
	await window.page.locator('.BrowserPaneView .address').fill(url)
	await window.page.locator('.BrowserPaneView .address').press('Enter')
	await expect.poll(async () => {
		const id = await window.page.locator('[data-testid="browse-guest"]').getAttribute('data-guest-id')
		if (!id) return ''
		const mhtml = await window.page.evaluate(
			(i: number) => (globalThis as any).api.osint.browse.snapshot(i), Number(id))
		return unwrapQuotedPrintable(mhtml)
	}, { timeout: 20_000, message: `never saw ${expected} at ${url}` }).toContain(expected)
}

test('one profile\'s cookies never reach another profile\'s browsing', async ({ tangent, workspace }) => {
	test.setTimeout(180_000)
	const server = await startCookieServer()
	try {
		const window = await tangent.firstWindow()

		writeProfiles(workspace, [
			{ id: 'alpha', name: 'Alpha', colour: '#aa3355' },
			{ id: 'beta', name: 'Beta', colour: '#3355aa' },
		])
		fs.writeFileSync(path.join(workspace, 'A.osintbrowse'), JSON.stringify({ profileId: 'alpha' }))
		fs.writeFileSync(path.join(workspace, 'B.osintbrowse'), JSON.stringify({ profileId: 'beta' }))
		await waitForNode(window, 'A.osintbrowse', workspace)
		await waitForNode(window, 'B.osintbrowse', workspace)

		// --- Alpha logs in ------------------------------------------------------------
		await window.setThread({ paths: ['A.osintbrowse'] })
		await expect(window.page.locator('[data-testid="browse-status"]'))
			.toContainText('Ready · guest', { timeout: 20_000 })
		await visit(window, `${server.base}/set`, 'COOKIE-WAS-SET')
		await visit(window, `${server.base}/read`, 'COOKIE-PRESENT')

		// --- Beta is a different person ------------------------------------------------
		await window.setThread({ paths: ['B.osintbrowse'] })
		await expect(window.page.locator('[data-testid="browse-status"]'))
			.toContainText('Ready · guest', { timeout: 20_000 })
		await visit(window, `${server.base}/read`, 'COOKIE-ABSENT')

		// --- the jar is the PROFILE's, not the pane's ---------------------------------
		// Asked of main, not of the page. The first version of this feature passed every
		// page-level check while quietly giving each pane mount its own empty jar: the
		// renderer's opaque session token was being used as the partition name, because
		// Electron resolves a guest's partition from the element attribute and ignores a
		// rewrite in will-attach-webview. Isolation looked perfect and nothing persisted.
		// Only the named partition's own cookie store tells you which of those you have.
		const jars = await tangent.app.evaluate(async ({ session }) => ({
			alpha: (await session.fromPartition('persist:osint-browse-alpha').cookies.get({})).length,
			beta: (await session.fromPartition('persist:osint-browse-beta').cookies.get({})).length,
		}))
		expect(jars.alpha, 'Alpha\'s cookie is not in Alpha\'s jar').toBeGreaterThan(0)
		expect(jars.beta, 'Beta somehow acquired a cookie').toBe(0)

		// --- and Alpha still is, so this is isolation and not amnesia ------------------
		await window.setThread({ paths: ['A.osintbrowse'] })
		await expect(window.page.locator('[data-testid="browse-parked"]')).toBeVisible({ timeout: 20_000 })
		await window.page.locator('[data-testid="browse-parked"] button')
			.evaluate((el: HTMLButtonElement) => el.click())
		await expect.poll(async () => {
			const id = await window.page.locator('[data-testid="browse-guest"]').getAttribute('data-guest-id')
			if (!id) return ''
			return unwrapQuotedPrintable(await window.page.evaluate(
				(i: number) => (globalThis as any).api.osint.browse.snapshot(i), Number(id)))
		}, { timeout: 20_000, message: 'Alpha lost its own session across a remount' })
			.toContain('COOKIE-PRESENT')
	}
	finally {
		await server.close()
	}
})

test('a profile whose proxy this build will not use refuses to browse at all', async ({ tangent, workspace }) => {
	test.setTimeout(120_000)
	const window = await tangent.firstWindow()

	// socks4 resolves hostnames on this machine, leaking every site visited to the
	// operator's own resolver. Silently ignoring the setting and browsing direct would
	// hand the investigated site exactly what the proxy was chosen to withhold, so the
	// pane refuses instead.
	writeProfiles(workspace, [{ id: 'leaky', name: 'Leaky', colour: '#aa3355', proxy: 'socks4://127.0.0.1:9050' }])
	fs.writeFileSync(path.join(workspace, 'Leaky.osintbrowse'), JSON.stringify({ profileId: 'leaky' }))
	await waitForNode(window, 'Leaky.osintbrowse', workspace)
	await window.setThread({ paths: ['Leaky.osintbrowse'] })

	const error = window.page.locator('[data-testid="browse-claim-error"]')
	await expect(error).toBeVisible({ timeout: 20_000 })
	await expect(error).toContainText('socks4')
	// And no guest exists to browse with.
	await expect(window.page.locator('[data-testid="browse-guest"]')).toHaveCount(0)
})

test('the reality check reports what the profile is actually exposing', async ({ tangent, workspace }) => {
	test.setTimeout(120_000)
	const window = await tangent.firstWindow()

	writeProfiles(workspace, [{ id: 'alpha', name: 'Alpha', colour: '#aa3355' }])
	fs.writeFileSync(path.join(workspace, 'Check.osintbrowse'), JSON.stringify({ profileId: 'alpha' }))
	await waitForNode(window, 'Check.osintbrowse', workspace)
	await window.setThread({ paths: ['Check.osintbrowse'] })
	await expect(window.page.locator('[data-testid="browse-status"]'))
		.toContainText('Ready · guest', { timeout: 20_000 })

	await window.page.locator('.BrowserPaneView button.check')
		.evaluate((el: HTMLButtonElement) => el.click())

	const panel = window.page.locator('[data-testid="browse-reality-check"]')
	await expect(panel).toBeVisible({ timeout: 20_000 })

	// The findings that matter are the honest ones: the machine-level signals that are the
	// same in every profile, and whether the WebRTC mitigation actually held.
	await expect(panel).toContainText('Time zone', { timeout: 20_000 })
	await expect(panel).toContainText('Hardware')
	await expect(panel).toContainText('WebRTC addresses')
	await expect(panel).toContainText('none offered')
	// No proxy on this profile, so it must say so rather than implying protection.
	await expect(panel).toContainText('direct')
})

test('a pane will not change identity once it has been somewhere', async ({ tangent, workspace }) => {
	test.setTimeout(120_000)
	const window = await tangent.firstWindow()

	writeProfiles(workspace, [
		{ id: 'alpha', name: 'Alpha', colour: '#aa3355' },
		{ id: 'beta', name: 'Beta', colour: '#3355aa' },
	])
	// A pane with remembered history comes back with the picker locked: the cookies and
	// referrer that got here belong to the identity that walked the path.
	fs.writeFileSync(path.join(workspace, 'Used.osintbrowse'),
		JSON.stringify({ profileId: 'alpha', url: 'https://example.com/' }))
	await waitForNode(window, 'Used.osintbrowse', workspace)
	await window.setThread({ paths: ['Used.osintbrowse'] })

	const picker = window.page.locator('.BrowserPaneView select.profile')
	await expect(picker).toBeVisible({ timeout: 20_000 })
	await expect(picker).toBeDisabled()
	await expect(picker).toHaveValue('alpha')
})
