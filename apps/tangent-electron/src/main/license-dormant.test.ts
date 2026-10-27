import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FULL_ENTITLEMENTS } from '../common/license'
import { PREMIUM_LICENSING_ENABLED } from '../common/premium'
import * as license from './license'

const state = vi.hoisted(() => ({
	userData: '',
	subscriptionChecks: 0,
}))

vi.mock('electron', () => ({
	app: { getPath: () => state.userData, isPackaged: true },
	ipcMain: { handle: () => {} },
}))

vi.mock('./license-subscription', async importOriginal => {
	const actual = await importOriginal<typeof import('./license-subscription')>()
	return {
		...actual,
		checkSubscriptionKey: async () => {
			state.subscriptionChecks++
			throw new Error('The dormant build must not contact the licence server')
		},
	}
})

describe('dormant premium licensing', () => {
	let licensePath = ''

	beforeEach(() => {
		delete process.env.OSINT_SKIP_LICENSE
		state.subscriptionChecks = 0
		state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-license-open-'))
		licensePath = path.join(state.userData, 'license.json')
		fs.writeFileSync(licensePath, JSON.stringify({
			key: 'abcdefghijklmnopqrstuvwxyz0123456789ABCD',
			kind: 'subscription',
			subscription: {
				checkedAt: new Date(0).toISOString(),
				refusal: 'revoked',
			},
		}))
	})

	afterEach(() => fs.rmSync(state.userData, { recursive: true, force: true }))

	it('is an explicit false-by-default product switch', () => {
		expect(PREMIUM_LICENSING_ENABLED).toBe(false)
	})

	it('grants every entitlement without reading or checking a stored key', async () => {
		const before = fs.readFileSync(licensePath, 'utf8')
		const status = await license.licenseStatus()

		expect(status).toEqual({
			valid: true,
			source: 'open',
			entitlements: FULL_ENTITLEMENTS,
		})
		expect(state.subscriptionChecks).toBe(0)
		expect(fs.readFileSync(licensePath, 'utf8')).toBe(before)
	})

	it('leaves an existing key untouched for activate, refresh, and clear actions', async () => {
		const before = fs.readFileSync(licensePath, 'utf8')

		expect((await license.activateLicense('garbage')).source).toBe('open')
		expect((await license.refreshLicense()).source).toBe('open')
		license.clearLicense()

		expect(state.subscriptionChecks).toBe(0)
		expect(fs.readFileSync(licensePath, 'utf8')).toBe(before)
	})
})
