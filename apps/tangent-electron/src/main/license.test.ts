import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { LicenseStatus, SubscriptionDetails } from '../common/license'
import * as license from './license'
import { failWith } from './license-subscription'

/**
 * The licence-change hook, driven the way the extension channel uses it: a listener that
 * asks licenseStatus() again. The dashboard is a stub counting its requests, so a hook
 * that re-fires on its own answers shows up as a count that keeps climbing.
 */

const state = vi.hoisted(() => ({
	userData: '',
	answers: [] as LicenseStatus[],
	requests: 0,
}))

vi.mock('electron', () => ({
	app: { getPath: () => state.userData, isPackaged: false },
	ipcMain: { handle: () => {} },
}))

vi.mock('./license-subscription', async importOriginal => {
	const actual = await importOriginal<typeof import('./license-subscription')>()
	return {
		...actual,
		checkSubscriptionKey: async () => {
			state.requests++
			// A real round trip yields to timers; without it a loop would starve settle().
			await new Promise(resolve => setTimeout(resolve, 0))
			// The last answer repeats, so "the dashboard keeps saying 401" is one entry.
			return state.answers[Math.min(state.requests, state.answers.length) - 1]
		},
	}
})

const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'

function subscription(checkedAt: string): SubscriptionDetails {
	return {
		tier: 'premium',
		plan: 'PREMIUM',
		planDisplayName: 'Premium',
		isTrial: false,
		expires: '2099-01-01T00:00:00Z',
		credits: 10,
		features: { osint: true, chat: true, graphAutomation: true, customModels: true, localAgent: true },
		checkedAt,
	}
}

function validAnswer(): LicenseStatus {
	const details = subscription(new Date().toISOString())
	return {
		valid: true,
		source: 'subscription',
		subscription: details,
		tier: details.tier,
		entitlements: details.features,
	}
}

/** Waits out every reconcile the listeners may have queued. */
async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('onLicenseChanged', () => {
	let unsubscribe: (() => void) | null = null

	beforeEach(() => {
		delete process.env.OSINT_SKIP_LICENSE
		state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-license-'))
		// Drops what the previous test left in memory; no listener is attached yet.
		license.clearLicense()
		state.requests = 0
		state.answers = []
		// A day and a half old: past revalidation, well inside the grace window.
		const checkedAt = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
		fs.writeFileSync(path.join(state.userData, 'license.json'), JSON.stringify({
			key: KEY,
			kind: 'subscription',
			subscription: subscription(checkedAt),
		}))
	})

	afterEach(() => {
		unsubscribe?.()
		unsubscribe = null
		fs.rmSync(state.userData, { recursive: true, force: true })
	})

	it('does not loop when a listener re-asks and the dashboard keeps refusing the key', async () => {
		// A revoked key answers 401, which keeps the stale `checkedAt`, so every ask is
		// another request. Notifying on each answer made that a request loop.
		state.answers = [failWith('unknown-key')]
		let notified = 0
		unsubscribe = license.onLicenseChanged(() => {
			notified++
			void license.licenseStatus()
		})

		const status = await license.licenseStatus()
		await settle()

		expect(status.valid).toBe(false)
		// The first answer is news (nothing was known), the re-ask it causes is not.
		expect(notified).toBe(1)
		expect(state.requests).toBe(2)
	})

	it('notifies when the dashboard withdraws a licence it had granted', async () => {
		state.answers = [validAnswer(), failWith('unknown-key')]
		let notified = 0
		unsubscribe = license.onLicenseChanged(() => { notified++ })

		expect((await license.licenseStatus()).valid).toBe(true)
		expect(notified).toBe(1)

		// Same verdict again: nothing to tell anyone.
		state.answers = [validAnswer(), validAnswer(), failWith('unknown-key')]
		expect((await license.licenseStatus(true)).valid).toBe(true)
		expect(notified).toBe(1)

		expect((await license.licenseStatus(true)).valid).toBe(false)
		expect(notified).toBe(2)
	})

	it('notifies on clear and on refresh, which the user asked for', async () => {
		state.answers = [validAnswer()]
		let notified = 0
		unsubscribe = license.onLicenseChanged(() => { notified++ })

		await license.licenseStatus()
		const before = notified
		await license.refreshLicense()
		expect(notified).toBe(before + 1)

		license.clearLicense()
		expect(notified).toBe(before + 2)
		expect((await license.licenseStatus()).valid).toBe(false)
	})
})
