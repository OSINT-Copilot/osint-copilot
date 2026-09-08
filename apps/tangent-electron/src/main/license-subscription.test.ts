import { describe, it, expect } from 'vitest'

import {
	checkSubscriptionKey,
	licenseServerUrl,
	statusFromResponse,
} from './license-subscription'
import { DEFAULT_LICENSE_SERVER, licenseKeyKind } from '../common/license'

/**
 * The dashboard half of licensing, tested against captured response shapes rather than a
 * running Django.
 *
 * The cases that matter are the ones where being wrong costs a user their access: a
 * lapsed subscription must be told apart from an unreachable server, and a response this
 * build does not fully understand must not lock anyone out.
 */

/** What `orders/entitlements.build_entitlement` produces for a live premium account. */
const ACTIVE = {
	ok: true,
	license: {
		schema: 1,
		active: true,
		reason: null,
		tier: 'premium',
		plan: 'PREMIUM',
		plan_display_name: 'Premium',
		email: 'analyst@example.org',
		name: 'Jane Analyst',
		is_trial: false,
		subscription_status: 'active',
		expires: '2099-12-31T23:59:59+00:00',
		credits: 400,
		features: {
			allow_plugin_access: true,
			allow_chat_view: true,
			allow_graph_automation: true,
			allow_custom_chat_config: true,
			allow_local_agent: true,
		},
	},
}

/** A stub in place of fetch. A plain function, never a spy: a spy that throws is
 *  attributed to the test by vitest even when the code under test catches it. */
const responds = (status: number, body: unknown) => (async () => ({
	status,
	ok: status >= 200 && status < 300,
	json: async () => body,
})) as unknown as typeof fetch

const unreachable = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch

describe('telling the two kinds of key apart', () => {
	it('reads a dashboard token as a subscription key', () => {
		expect(licenseKeyKind('kPqR3sT7uVwX2yZ4aB6cD8eF0gH1iJ3kL5mN7oP9')).toBe('subscription')
	})

	it('reads an OSINT- key as an offline key', () => {
		expect(licenseKeyKind('OSINT-eyJhIjoxfQ.c2ln')).toBe('offline')
	})

	it('refuses text that is neither', () => {
		expect(licenseKeyKind('not a key at all!')).toBeNull()
		expect(licenseKeyKind('')).toBeNull()
	})

	it('ignores the line breaks a pasted key arrives with', () => {
		expect(licenseKeyKind('kPqR3sT7uVwX2yZ4\naB6cD8eF0gH1iJ3k')).toBe('subscription')
	})
})

describe('reading what the dashboard said', () => {
	it('accepts a live subscription and carries its tier through', () => {
		const status = statusFromResponse(ACTIVE)
		expect(status.valid).toBe(true)
		expect(status.tier).toBe('premium')
		expect(status.source).toBe('subscription')
		expect(status.subscription?.credits).toBe(400)
		expect(status.entitlements?.localAgent).toBe(true)
	})

	it('translates the server\'s flag names into the app\'s', () => {
		const status = statusFromResponse({
			...ACTIVE,
			license: {
				...ACTIVE.license,
				tier: 'basic',
				features: { ...ACTIVE.license.features, allow_custom_chat_config: false },
			},
		})
		expect(status.entitlements?.customModels).toBe(false)
		expect(status.entitlements?.graphAutomation).toBe(true)
	})

	it('lets a plan flag override its tier default', () => {
		// The reason flags are sent at all: enabling one feature for one plan from the
		// Django admin has to reach the app without a desktop release.
		const status = statusFromResponse({
			...ACTIVE,
			license: {
				...ACTIVE.license,
				tier: 'trial',
				features: { ...ACTIVE.license.features, allow_graph_automation: true },
			},
		})
		expect(status.tier).toBe('trial')
		expect(status.entitlements?.graphAutomation).toBe(true)
	})

	it('falls back to the tier defaults when a server sends no flags', () => {
		const { features, ...withoutFlags } = ACTIVE.license
		const status = statusFromResponse({ ok: true, license: { ...withoutFlags, tier: 'basic' } })
		expect(status.valid).toBe(true)
		expect(status.entitlements?.graphAutomation).toBe(true)
		expect(status.entitlements?.customModels).toBe(false)
	})

	it('treats a tier it has never heard of as a trial rather than an error', () => {
		// A server ahead of this build must leave the user working, not locked out.
		const status = statusFromResponse({
			...ACTIVE,
			license: { ...ACTIVE.license, tier: 'platinum' },
		})
		expect(status.valid).toBe(true)
		expect(status.tier).toBe('trial')
	})

	it('reports a lapsed subscription as such, and still names the plan', () => {
		const status = statusFromResponse({
			ok: true,
			license: { ...ACTIVE.license, active: false, reason: 'subscription-inactive' },
		})
		expect(status.valid).toBe(false)
		expect(status.reason).toBe('subscription-inactive')
		// Kept so settings can say which plan lapsed instead of going blank.
		expect(status.subscription?.planDisplayName).toBe('Premium')
	})

	it('reports a switched-off key as revoked', () => {
		const status = statusFromResponse({
			ok: true,
			license: { ...ACTIVE.license, active: false, reason: 'revoked' },
		})
		expect(status.reason).toBe('revoked')
	})

	it('refuses a body that is not a licence at all', () => {
		// A captive portal answering 200 with a login page reaches exactly here.
		expect(statusFromResponse({ ok: true }).reason).toBe('server-error')
		expect(statusFromResponse(null).reason).toBe('server-error')
		expect(statusFromResponse('<html>').reason).toBe('server-error')
	})

	it('stamps the check with this machine\'s clock, not the server\'s', () => {
		// The grace period is measured against this; a server with a wrong clock must not
		// be able to shorten or extend it.
		const before = Date.now()
		const status = statusFromResponse(ACTIVE)
		const stamped = new Date(status.subscription!.checkedAt).getTime()
		expect(stamped).toBeGreaterThanOrEqual(before)
		expect(stamped).toBeLessThanOrEqual(Date.now())
	})
})

describe('asking the dashboard', () => {
	const KEY = 'kPqR3sT7uVwX2yZ4aB6cD8eF0gH1iJ3kL5mN7oP9'

	it('sends the key as a bearer token to the licence endpoint', async () => {
		let seenUrl = ''
		let seenAuth = ''
		const fetchImpl = (async (url: string, init: RequestInit) => {
			seenUrl = String(url)
			seenAuth = String((init.headers as Record<string, string>).Authorization)
			return { status: 200, ok: true, json: async () => ACTIVE }
		}) as unknown as typeof fetch

		const status = await checkSubscriptionKey(KEY, 'http://localhost:8000', fetchImpl)
		expect(status.valid).toBe(true)
		expect(seenUrl).toBe('http://localhost:8000/api/desktop/license')
		expect(seenAuth).toBe(`Bearer ${KEY}`)
	})

	it('reads a 401 as the server saying it has never heard of this key', async () => {
		const status = await checkSubscriptionKey(KEY, 'http://x', responds(401, { ok: false }))
		expect(status.reason).toBe('unknown-key')
	})

	it('reads a 500 as "could not ask", not as a refusal', async () => {
		// The distinction the whole offline design rests on: a broken server must not
		// cost a paying user their access.
		const status = await checkSubscriptionKey(KEY, 'http://x', responds(500, {}))
		expect(status.reason).toBe('server-error')
	})

	it('reads a transport failure as "could not ask"', async () => {
		const status = await checkSubscriptionKey(KEY, 'http://x', unreachable)
		expect(status.reason).toBe('server-error')
	})

	it('reads a 200 of unparseable body as "could not ask"', async () => {
		const fetchImpl = (async () => ({
			status: 200, ok: true, json: async () => { throw new SyntaxError('not json') },
		})) as unknown as typeof fetch
		const status = await checkSubscriptionKey(KEY, 'http://x', fetchImpl)
		expect(status.reason).toBe('server-error')
	})
})

describe('which server is asked', () => {
	it('uses the built-in address in a packaged build', () => {
		process.env.OSINT_LICENSE_SERVER = 'http://localhost:8000'
		try {
			// A shipped app must not be redirectable to a friendlier server by a variable.
			expect(licenseServerUrl(true)).toBe(DEFAULT_LICENSE_SERVER)
		}
		finally {
			delete process.env.OSINT_LICENSE_SERVER
		}
	})

	it('honours the override outside a packaged build', () => {
		process.env.OSINT_LICENSE_SERVER = 'http://localhost:8000/'
		try {
			// Trailing slash trimmed, so the endpoint path does not double up.
			expect(licenseServerUrl(false)).toBe('http://localhost:8000')
		}
		finally {
			delete process.env.OSINT_LICENSE_SERVER
		}
	})

	it('falls back to the built-in address when nothing is set', () => {
		delete process.env.OSINT_LICENSE_SERVER
		expect(licenseServerUrl(false)).toBe(DEFAULT_LICENSE_SERVER)
	})
})
