import {
	entitlementsForTier,
	fail,
	graceExhausted,
	isExpired,
	shouldRevalidate,
	type Entitlements,
	type LicenseFailure,
	type LicensePayload,
	type LicenseStatus,
	type SubscriptionDetails,
} from '../common/license'

/**
 * What to do with what is on disk — the decisions, with nothing around them.
 *
 * Pure and dependency-free, so the awkward cases can be tested by passing a date rather
 * than by waiting a fortnight or unplugging a network: a licence a day old, a licence
 * fifteen days old with no connection, a plan whose last known state was "cancelled".
 *
 * Storage lives in license.ts and the network in license-subscription.ts.
 */

/** Whether to contact the server, and what it costs if we cannot. */
export interface CachePolicy {
	/** Try the server at all. */
	check: boolean
	/**
	 * The check has to succeed. False means a failed check is survivable and the cached
	 * answer stands; true means the app cannot run without a fresh one.
	 */
	required: boolean
	/** What to report if `required` and the server cannot be reached. */
	reasonIfUnreachable: LicenseFailure
}

/**
 * How to treat a cached subscription answer of a given age.
 *
 * Three bands, and the middle one is the point of the design: between roughly a day and
 * two weeks old the app *tries* the server on every launch but does not need it, so an
 * analyst with no connection keeps working and one who has just renewed sees it promptly.
 */
export function cachePolicy(cached: SubscriptionDetails | null, now = new Date()): CachePolicy {
	if (!cached) {
		// Nothing to fall back on: a key we have never had an answer about is not a licence.
		return { check: true, required: true, reasonIfUnreachable: 'server-error' }
	}
	if (graceExhausted(cached.checkedAt, now)) {
		return { check: true, required: true, reasonIfUnreachable: 'offline-too-long' }
	}
	if (shouldRevalidate(cached.checkedAt, now)) {
		return { check: true, required: false, reasonIfUnreachable: 'server-error' }
	}
	return { check: false, required: false, reasonIfUnreachable: 'server-error' }
}

/**
 * The status a cached subscription answer produces, without asking the server.
 *
 * Expiry is re-checked here against the current date rather than trusted from the cached
 * `active` flag: a subscription that was valid when we last asked can have ended since,
 * and a laptop that has been shut in a bag for a month must not open onto a live licence.
 *
 * @param stale marks an answer served because the server could not be reached, so the UI
 *        can say so. It does not affect whether the licence is honoured.
 */
export function statusFromCache(
	cached: SubscriptionDetails,
	now = new Date(),
	stale = false,
): LicenseStatus {
	if (cached.expires && new Date(cached.expires).getTime() <= now.getTime()) {
		return { ...fail('expired'), source: 'subscription', subscription: cached }
	}

	return {
		valid: true,
		source: 'subscription',
		subscription: cached,
		tier: cached.tier,
		entitlements: cached.features,
		...(stale ? { stale: true } : {}),
	}
}

/**
 * The status a verified offline key produces.
 *
 * The signature has already been checked by the time this is called; all that is left is
 * turning the payload into the same shape a subscription produces, so that everything
 * downstream of the gate can read `tier` and `entitlements` without caring which kind of
 * key it got.
 *
 * A payload with no tier is premium. Keys minted before tiers existed were sold as the
 * whole product, and downgrading them retroactively would break paying customers.
 */
export function statusFromOfflinePayload(payload: LicensePayload, now = new Date()): LicenseStatus {
	if (isExpired(payload, now)) return fail('expired')

	const tier = payload.tier ?? 'premium'
	const entitlements: Entitlements = entitlementsForTier(tier)

	return { valid: true, source: 'offline', payload, tier, entitlements }
}
