import {
	DEFAULT_LICENSE_SERVER,
	LICENSE_ENDPOINT,
	entitlementsForTier,
	fail,
	isAppTier,
	type AppTier,
	type Entitlements,
	type LicenseFailure,
	type LicenseStatus,
	type SubscriptionDetails,
} from '../common/license'

/**
 * Checking a subscription key against the OSINT Copilot dashboard.
 *
 * The dashboard (the `ready-saas` Django app) is the authority on who has paid for what.
 * This module is the only place that talks to it, and the only place that turns its JSON
 * into the app's own `LicenseStatus` — so a change to the server's field names lands in
 * exactly one function.
 *
 * ## What it deliberately does not do
 *
 * No caching, no storage, no grace period. Those belong to license.ts, which owns the
 * stored key and has to decide what to do when the answer is "I could not ask". Keeping
 * them apart means the network shape can be tested by pointing this at a stub server,
 * with nothing on disk.
 *
 * ## Not net-guard
 *
 * `src/main/osint/node/net-guard.ts` refuses private and loopback addresses, because it
 * fetches URLs that a *model* chose. This is the opposite case: the address comes from
 * the build, or from a developer's own environment variable, and during development it is
 * deliberately `http://localhost:8000`. Running it through the guard would make the local
 * dashboard unusable while protecting against nothing.
 */

/** Long enough for a slow connection; short enough not to hang a cold start. */
const REQUEST_TIMEOUT_MS = 12_000

/**
 * Where to check keys.
 *
 * `OSINT_LICENSE_SERVER` is honoured only outside a packaged build. In a shipped app the
 * constant is the whole answer: an environment variable that could redirect the check to
 * a server of the user's choosing would be a licence bypass requiring no tools at all.
 */
export function licenseServerUrl(isPackaged: boolean): string {
	if (!isPackaged) {
		const override = process.env.OSINT_LICENSE_SERVER?.trim()
		if (override) return override.replace(/\/+$/, '')
	}
	return DEFAULT_LICENSE_SERVER
}

/** The server's per-feature flags, named as the server names them. */
interface ServerFeatures {
	allow_plugin_access?: boolean
	allow_chat_view?: boolean
	allow_graph_automation?: boolean
	allow_custom_chat_config?: boolean
	allow_local_agent?: boolean
}

/**
 * Translate the server's flags into the app's own names.
 *
 * The tier's defaults are the base, and a flag that is actually present overrides it. That
 * ordering is what lets an admin turn one feature on for one plan from the Django admin
 * without a desktop release, while an older server that does not send flags at all still
 * produces a sensible licence rather than an empty one.
 */
function entitlementsFrom(tier: AppTier, features: ServerFeatures | undefined): Entitlements {
	const base = entitlementsForTier(tier)
	if (!features || typeof features !== 'object') return base

	const pick = (value: unknown, fallback: boolean) =>
		typeof value === 'boolean' ? value : fallback

	return {
		osint: pick(features.allow_plugin_access, base.osint),
		chat: pick(features.allow_chat_view, base.chat),
		graphAutomation: pick(features.allow_graph_automation, base.graphAutomation),
		customModels: pick(features.allow_custom_chat_config, base.customModels),
		localAgent: pick(features.allow_local_agent, base.localAgent),
	}
}

/** The failure the server named, mapped onto ours. Anything unrecognised is a server error. */
function reasonFrom(serverReason: unknown): LicenseFailure {
	switch (serverReason) {
		case 'revoked': return 'revoked'
		case 'expired': return 'expired'
		case 'subscription-inactive': return 'subscription-inactive'
		default: return 'server-error'
	}
}

/**
 * Turn one `license` object from the server into a status.
 *
 * Exported so it can be tested against captured server responses without a network, which
 * is where the interesting cases are: a lapsed subscription, a plan with one feature
 * switched on, a response from a server newer than this build.
 */
export function statusFromResponse(body: unknown): LicenseStatus {
	const envelope = body as { ok?: boolean, license?: Record<string, unknown> } | null
	const license = envelope?.license
	if (!envelope?.ok || !license || typeof license !== 'object') {
		return fail('server-error')
	}

	// An unreadable tier is a trial rather than an error: a future server sending a tier
	// this build has never heard of should leave the user working, not locked out.
	const tier: AppTier = isAppTier(license.tier) ? license.tier : 'trial'

	const details: SubscriptionDetails = {
		tier,
		plan: String(license.plan ?? 'NONE'),
		planDisplayName: String(license.plan_display_name ?? tier),
		email: typeof license.email === 'string' ? license.email : undefined,
		name: typeof license.name === 'string' ? license.name : undefined,
		isTrial: license.is_trial === true,
		subscriptionStatus: typeof license.subscription_status === 'string'
			? license.subscription_status
			: undefined,
		expires: typeof license.expires === 'string' ? license.expires : null,
		endDate: typeof license.subscription_end_date === 'string' ? license.subscription_end_date : null,
		credits: typeof license.credits === 'number' ? license.credits : 0,
		features: entitlementsFrom(tier, license.features as ServerFeatures | undefined),
		// Our clock, not the server's. The grace period is measured against this machine,
		// and a server whose clock is off must not silently extend or shorten it.
		checkedAt: new Date().toISOString(),
	}

	if (license.active !== true) {
		const reason = reasonFrom(license.reason)
		return {
			...fail(reason),
			source: 'subscription',
			// Carried even though invalid: the settings page shows which plan lapsed, and
			// the cache keeps the answer so the app does not forget the account on a retry.
			// A reason this build does not know reads as server-error, "could not ask",
			// which is not a refusal and must not be remembered as one.
			subscription: reason === 'server-error' ? details : { ...details, refusal: reason },
		}
	}

	return {
		valid: true,
		source: 'subscription',
		subscription: details,
		tier,
		entitlements: details.features,
	}
}

/**
 * Ask the dashboard about a key.
 *
 * Never throws. A network failure comes back as `server-error`, which the caller treats
 * as "could not ask" — distinct from the server saying no, because only one of those two
 * should cost the user their access.
 */
export async function checkSubscriptionKey(
	key: string,
	serverUrl: string,
	fetchImpl: typeof fetch = fetch,
): Promise<LicenseStatus> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

	try {
		const response = await fetchImpl(`${serverUrl}${LICENSE_ENDPOINT}`, {
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${key}`,
				'Accept': 'application/json',
			},
			signal: controller.signal,
		})

		// 401 is the one status that means the server understood and said no. Every other
		// failure — 500, a proxy's 502, a captive portal's 200 of HTML — is "could not
		// ask", and must not delete anyone's licence.
		if (response.status === 401) return fail('unknown-key')
		if (!response.ok) return fail('server-error')

		return statusFromResponse(await response.json())
	}
	catch {
		// Timeout, DNS, TLS, or a body that is not JSON.
		return fail('server-error')
	}
	finally {
		clearTimeout(timer)
	}
}
