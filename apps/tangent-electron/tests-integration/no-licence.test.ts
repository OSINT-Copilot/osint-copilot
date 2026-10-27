import { expect, test } from './tangent'

test.use({ launchEnv: { OSINT_SKIP_LICENSE: '' } })

test('the open-source build starts without a key and hides licence controls', async ({ tangent }) => {
	const window = await tangent.firstWindow()

	expect(await window.page.locator('.LicenseGate').count()).toBe(0)
	const status = await window.page.evaluate(() => (globalThis as any).api.license.status())
	expect(status).toEqual({
		valid: true,
		source: 'open',
		entitlements: {
			osint: true,
			chat: true,
			graphAutomation: true,
			customModels: true,
			localAgent: true,
		},
	})

	await window.page.evaluate(() => {
		(document as any).workspace.viewState.system.showMenu.set(true)
	})
	await expect(window.page.locator('.SystemMenu')).toBeVisible()
	await expect(window.page.locator('.SystemMenu nav button', { hasText: 'Licence' })).toHaveCount(0)
})
