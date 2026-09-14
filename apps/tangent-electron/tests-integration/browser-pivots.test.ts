import { test, expect } from './tangent'
import fs from 'fs'
import path from 'path'

/**
 * Pivots: taking a value off a page and asking other places about it.
 *
 * The native context menu itself is not automatable -- it is an OS menu drawn by the
 * platform, outside the page Playwright drives. What is tested is everything either side
 * of it: what the menu WOULD offer for a given selection, and what a pane created by a
 * pivot looks like when it opens.
 */

async function waitForNode(window: any, relativePath: string, workspacePath: string) {
	await expect.poll(
		() => window.page.evaluate(
			(p: string) => !!(document as any).workspace?.directoryStore?.get(p),
			path.join(workspacePath, relativePath)),
		{ timeout: 10_000, message: `${relativePath} never reached the directory store` },
	).toBe(true)
}

const targetsFor = (window: any, selection: string) => window.page.evaluate(
	(s: string) => (globalThis as any).api.osint.browse.pivotTargets(s), selection)

test('what the menu offers depends on what was selected', async ({ tangent }) => {
	test.setTimeout(120_000)
	const window = await tangent.firstWindow()

	const username = await targetsFor(window, '@ada_lovelace')
	expect(username.kind).toBe('username')
	// The @ people paste around a handle is not part of the handle.
	expect(username.value).toBe('ada_lovelace')
	expect(username.targets.map((t: any) => t.pivotId)).toContain('github-user')
	expect(username.targets.find((t: any) => t.pivotId === 'github-user').url)
		.toBe('https://github.com/ada_lovelace')

	const domain = await targetsFor(window, 'example.co.uk')
	expect(domain.kind).toBe('domain')
	expect(domain.targets.map((t: any) => t.pivotId)).toContain('crtsh')
	// A domain is not a username, so account lookups are not offered for it.
	expect(domain.targets.map((t: any) => t.pivotId)).not.toContain('github-user')

	const wallet = await targetsFor(window, '0x' + 'a'.repeat(40))
	expect(wallet.kind).toBe('eth')
	expect(wallet.targets.map((t: any) => t.pivotId)).toContain('etherscan')

	// Anything unclassifiable still gets search, rather than nothing.
	const prose = await targetsFor(window, 'a person with a name')
	expect(prose.kind).toBe('text')
	expect(prose.targets.length).toBeGreaterThan(0)

	// Values are encoded into the template, not concatenated.
	const awkward = await targetsFor(window, 'a b&c=d')
	const search = awkward.targets.find((t: any) => t.pivotId === 'google-exact')
	expect(search.url).toContain('a%20b%26c%3Dd')
	expect(search.url).not.toContain('&c=d')
})

test('the operator can override a bundled pivot without maintaining the list', async ({ tangent, workspace }) => {
	test.setTimeout(120_000)
	const window = await tangent.firstWindow()

	const dir = path.join(workspace, 'OSINTCopilot', 'browsing')
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(path.join(dir, 'pivots.json'), JSON.stringify({
		pivots: [
			// Same id as a bundled entry: replaces it, so a rotted link can be fixed.
			{ id: 'github-user', label: 'Our GitHub mirror', url: 'https://mirror.example/{value}', appliesTo: ['username'] },
			{ id: 'house-tool', label: 'House tool', url: 'https://tools.example/?q={value}', appliesTo: ['username'] },
		],
	}))

	await expect.poll(async () => {
		const result = await targetsFor(window, 'ada')
		return result.targets.find((t: any) => t.pivotId === 'github-user')?.label
	}, { timeout: 15_000, message: 'the override never took effect' }).toBe('Our GitHub mirror')

	const result = await targetsFor(window, 'ada')
	expect(result.targets.find((t: any) => t.pivotId === 'github-user').url)
		.toBe('https://mirror.example/ada')
	expect(result.targets.map((t: any) => t.pivotId)).toContain('house-tool')
	// Overriding one entry does not discard the rest of the bundled list.
	expect(result.targets.map((t: any) => t.pivotId)).toContain('google-exact')
})

test('a pane opened by a pivot says where it came from, and has not loaded', async ({ tangent, workspace }) => {
	test.setTimeout(120_000)
	const window = await tangent.firstWindow()

	// The shape fanOut writes. A pivot pane is an ordinary browsing pane carrying a URL,
	// which is exactly why it comes up parked: a fan-out that fired eight requests the
	// moment someone right-clicked would hand the selected value to eight third parties
	// before the analyst had decided to ask any of them.
	fs.writeFileSync(path.join(workspace, 'Pivoted.osintbrowse'), JSON.stringify({
		url: 'https://github.com/ada_lovelace',
		openedBy: {
			value: 'ada_lovelace',
			pivotId: 'github-user',
			fromUrl: 'https://forum.example/thread/42',
			at: '2026-01-01T00:00:00.000Z',
		},
	}))
	await waitForNode(window, 'Pivoted.osintbrowse', workspace)
	await window.setThread({ paths: ['Pivoted.osintbrowse'] })

	// Provenance: four steps into an investigation this still says which value, on which
	// page, produced the pane.
	const provenance = window.page.locator('[data-testid="browse-opened-by"]')
	await expect(provenance).toBeVisible({ timeout: 20_000 })
	await expect(provenance).toContainText('ada_lovelace')
	await expect(provenance).toContainText('forum.example/thread/42')

	// And nothing has been requested.
	await expect(window.page.locator('[data-testid="browse-parked"]')).toBeVisible({ timeout: 20_000 })
	await expect(window.page.locator('[data-testid="browse-guest"]'))
		.toHaveAttribute('src', 'about:blank')
})
