import { describe, it, expect } from 'vitest'

import { cachePolicy, statusFromCache, statusFromOfflinePayload } from './license-policy'
import {
	OFFLINE_GRACE_DAYS,
	REVALIDATE_AFTER_HOURS,
	type SubscriptionDetails,
} from '../common/license'

/**
 * The offline rules, tested by moving the clock rather than the calendar.
 *
 * These are the cases that decide whether a paying analyst on a train keeps working and
 * whether a cancelled subscription stops, and neither can be exercised by hand: one needs
 * a fortnight, the other needs a billing system. Both are one argument here.
 */

const NOW = new Date('2026-06-01T12:00:00Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString()

function cached(overrides: Partial<SubscriptionDetails> = {}): SubscriptionDetails {
	return {
		tier: 'premium',
		plan: 'PREMIUM',
		planDisplayName: 'Premium',
		email: 'analyst@example.org',
		isTrial: false,
		expires: '2027-01-01T00:00:00Z',
		credits: 400,
		features: { osint: true, chat: true, graphAutomation: true, customModels: true, localAgent: true },
		checkedAt: hoursAgo(1),
		...overrides,
	}
}

describe('when to ask the server again', () => {
	it('does not ask at all for an answer from an hour ago', () => {
		// The ordinary launch. One file read, no request, no delay before the window opens.
		expect(cachePolicy(cached({ checkedAt: hoursAgo(1) }), NOW))
			.toMatchObject({ check: false, required: false })
	})

	it('asks, but survives failure, once the answer is a day old', () => {
		const policy = cachePolicy(cached({ checkedAt: hoursAgo(REVALIDATE_AFTER_HOURS + 1) }), NOW)
		expect(policy.check).toBe(true)
		// The point of the middle band: try, but do not need it.
		expect(policy.required).toBe(false)
	})

	it('requires an answer once the grace period is spent', () => {
		const policy = cachePolicy(cached({ checkedAt: daysAgo(OFFLINE_GRACE_DAYS + 1) }), NOW)
		expect(policy).toMatchObject({ check: true, required: true, reasonIfUnreachable: 'offline-too-long' })
	})

	it('requires an answer when there is no cache at all', () => {
		// A key we have never had an answer about is not yet a licence.
		expect(cachePolicy(null, NOW)).toMatchObject({ check: true, required: true })
	})

	it('treats an unreadable timestamp as spent rather than as fresh', () => {
		// This is what a hand-edited cache file looks like. It must not buy access.
		const policy = cachePolicy(cached({ checkedAt: 'not a date' }), NOW)
		expect(policy).toMatchObject({ check: true, required: true, reasonIfUnreachable: 'offline-too-long' })
	})
})

describe('when the last answer was a refusal', () => {
	it('asks again on every launch, so a renewal lets the user straight back in', () => {
		const policy = cachePolicy(cached({ refusal: 'revoked', checkedAt: hoursAgo(1) }), NOW)
		expect(policy.check).toBe(true)
		// Offline, the refusal simply stands; no connection must not mean a way back in.
		expect(policy.required).toBe(false)
	})
})

describe('reading a cached answer', () => {
	it('honours a live subscription without a request', () => {
		const status = statusFromCache(cached(), NOW)
		expect(status.valid).toBe(true)
		expect(status.tier).toBe('premium')
		expect(status.entitlements?.customModels).toBe(true)
		expect(status.stale).toBeUndefined()
	})

	it('marks an answer served because the server was unreachable', () => {
		expect(statusFromCache(cached(), NOW, true).stale).toBe(true)
	})

	it('refuses a subscription whose end date has passed since the last check', () => {
		// The laptop-in-a-bag case: the cache says active, but the date says otherwise.
		const status = statusFromCache(cached({ expires: '2026-05-01T00:00:00Z' }), NOW)
		expect(status.valid).toBe(false)
		expect(status.reason).toBe('expired')
		// Still names the plan, so settings can say what lapsed.
		expect(status.subscription?.planDisplayName).toBe('Premium')
	})

	it('stays refused when the last answer was a refusal, however recent', () => {
		// The answer is an hour old, so nothing is asked; it was a no, and must stay one.
		const status = statusFromCache(cached({ refusal: 'subscription-inactive' }), NOW)
		expect(status.valid).toBe(false)
		expect(status.reason).toBe('subscription-inactive')
		expect(status.subscription?.planDisplayName).toBe('Premium')
	})

	it('carries the plan\'s own flags rather than the tier defaults', () => {
		// An admin turning one feature on for one plan must reach the app without a release.
		const status = statusFromCache(cached({
			tier: 'basic',
			features: { osint: true, chat: true, graphAutomation: true, customModels: true, localAgent: false },
		}), NOW)
		expect(status.entitlements?.customModels).toBe(true)
	})
})

describe('an offline key', () => {
	it('grants premium when the payload names no tier', () => {
		// Keys minted before tiers existed were sold as the whole product.
		const status = statusFromOfflinePayload({ v: 1, name: 'Jane Analyst' }, NOW)
		expect(status.valid).toBe(true)
		expect(status.tier).toBe('premium')
		expect(status.entitlements?.localAgent).toBe(true)
	})

	it('grants only what the named tier includes', () => {
		const status = statusFromOfflinePayload({ v: 1, name: 'Jane', tier: 'basic' }, NOW)
		expect(status.tier).toBe('basic')
		expect(status.entitlements?.graphAutomation).toBe(true)
		expect(status.entitlements?.customModels).toBe(false)
	})

	it('reports an expired payload as expired', () => {
		const status = statusFromOfflinePayload({ v: 1, name: 'Jane', expires: '2026-01-01' }, NOW)
		expect(status.valid).toBe(false)
		expect(status.reason).toBe('expired')
	})
})
