import { app, ipcMain } from 'electron'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import Logger from 'js-logger'

import {
	FULL_ENTITLEMENTS,
	LICENSE_FORMAT_VERSION,
	licenseKeyKind,
	normalizeLicenseKey,
	type LicenseKeyKind,
	type LicenseStatus,
	type SubscriptionDetails,
} from '../common/license'
import { checkLicenseKey, fail } from './license-verify'
import { cachePolicy, statusFromCache, statusFromOfflinePayload } from './license-policy'
import { checkSubscriptionKey, licenseServerUrl } from './license-subscription'
import { mode } from './environment'

const log = Logger.get('license')

/**
 * Licence storage and the IPC surface, in main.
 *
 * In main and not the renderer for two reasons: node:crypto is here, and the stored key
 * never has to cross into a window at all -- the renderer asks "am I licensed?" and gets
 * back a yes/no plus the plan it is on, never the key itself.
 *
 * This is a lock on the front door, not a safe. Anyone who can edit the application bundle
 * can remove it, which is true of every licence check in every Electron app. What it does
 * buy is that a key cannot be forged or invented as plausible-looking text.
 *
 * ## Two kinds of key
 *
 * An **offline key** (`OSINT-…`) is checked by its signature, here, with no network. A
 * **subscription key** is checked against the dashboard, which is where tiers and billing
 * live. Which one a pasted key is comes from its shape, so the user is never asked.
 *
 * Both become the same `LicenseStatus`, carrying a tier and a set of entitlements, so the
 * rest of the app never branches on where a licence came from.
 *
 * ## Working without a connection
 *
 * A subscription answer is cached with the key. Inside the grace window the app runs from
 * that cache, trying the server when the answer gets stale but not needing it to succeed.
 * Past the window it stops until the server can be reached once. See license-policy.ts,
 * which owns those decisions and is where they are tested.
 */

/** Where the accepted key is kept. Per-user, beside the app's other state. */
function licenseFilePath(): string {
	return path.join(app.getPath('userData'), 'license.json')
}

interface StoredLicense {
	key: string
	kind: LicenseKeyKind
	/** The dashboard's last answer, for subscription keys. Absent until one arrives. */
	subscription?: SubscriptionDetails
}

/** Avoids re-reading and re-verifying on every call; invalidated whenever we write. */
let cached: { stored: StoredLicense, status: LicenseStatus } | null = null

const changeListeners = new Set<() => void>()

/**
 * Called after anything that may have changed the licence: activate, refresh, clear, and
 * an answer from the dashboard that changes the verdict. Listeners call licenseStatus()
 * for the new verdict; the browser-extension channel uses this to close its port the
 * moment the entitlement goes.
 */
export function onLicenseChanged(listener: () => void): () => void {
	changeListeners.add(listener)
	return () => changeListeners.delete(listener)
}

function notifyLicenseChanged(): void {
	for (const listener of changeListeners) {
		try {
			listener()
		}
		catch (e) {
			log.error('A licence-change listener failed:', e)
		}
	}
}

/**
 * What a listener could act on: valid or not, and what it allows. The reason, message and
 * plan details are left out, since a change to those alone changes nothing a listener does.
 */
function verdictOf(status: LicenseStatus | undefined): string | null {
	if (!status) return null
	return JSON.stringify([status.valid, status.tier ?? null, status.entitlements ?? null])
}

function readStored(): StoredLicense | null {
	let parsed: any
	try {
		parsed = JSON.parse(readFileSync(licenseFilePath(), 'utf8'))
	}
	catch (e) {
		// Absent is the ordinary first-run case; anything else is worth a line in the log.
		if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			log.error('Could not read the stored licence:', e)
		}
		return null
	}

	const key = typeof parsed?.key === 'string' ? parsed.key : null
	if (!key) return null

	// `kind` is inferred rather than required, so a file written by a build that predates
	// subscription keys still loads instead of sending an existing customer to the gate.
	const kind: LicenseKeyKind = parsed?.kind === 'offline' || parsed?.kind === 'subscription'
		? parsed.kind
		: (licenseKeyKind(key) ?? 'offline')

	const subscription = parsed?.subscription
	return {
		key,
		kind,
		subscription: subscription && typeof subscription?.checkedAt === 'string'
			? subscription as SubscriptionDetails
			: undefined,
	}
}

function writeStored(stored: StoredLicense): boolean {
	try {
		writeFileSync(
			licenseFilePath(),
			JSON.stringify(stored, null, '\t'),
			{ encoding: 'utf8', mode: 0o600 },
		)
		return true
	}
	catch (e) {
		log.error('Could not store the licence:', e)
		return false
	}
}

/**
 * Whether this build may run without a key.
 *
 * Only outside a packaged build: a developer running `npm run dev` should not have to mint
 * a licence to see their change, but a shipped application must never treat an environment
 * variable as a way past the check.
 */
function developerBypass(): boolean {
	return mode !== 'production' && process.env.OSINT_SKIP_LICENSE === '1'
}

function bypassStatus(): LicenseStatus {
	return {
		valid: true,
		source: 'offline',
		payload: { v: LICENSE_FORMAT_VERSION, name: 'Development build', tier: 'premium' },
		tier: 'premium',
		entitlements: { ...FULL_ENTITLEMENTS },
	}
}

/**
 * Records what the dashboard said, so the next launch has something to fall back on.
 *
 * A negative answer is cached too. That is deliberate: it keeps the settings page able to
 * name the plan that lapsed, and it stops a cancelled subscription from being resurrected
 * by simply going offline, which is what dropping the cache on failure would allow.
 */
function remember(stored: StoredLicense, status: LicenseStatus): LicenseStatus {
	const previous = cached?.status
	const next: StoredLicense = { ...stored, subscription: status.subscription ?? stored.subscription }
	writeStored(next)
	cached = { stored: next, status }
	// Only on a change of verdict. A listener asks licenseStatus() again, and a refusal
	// (401) keeps the old `checkedAt`, so that ask goes back to the dashboard: notifying on
	// every answer would turn one refusal into requests without end.
	if (verdictOf(previous) !== verdictOf(status)) notifyLicenseChanged()
	return status
}

/** Checks a subscription key against the dashboard, applying the offline grace rules. */
async function subscriptionStatus(stored: StoredLicense, force = false): Promise<LicenseStatus> {
	const policy = cachePolicy(stored.subscription ?? null)

	// `force` overrides only whether we ask, never whether the answer is required. The
	// "Check for changes" button must not be able to revoke a licence that is still
	// inside its grace period simply because it was pressed on a train.
	if (!(force || policy.check) && stored.subscription) {
		return statusFromCache(stored.subscription)
	}

	const result = await checkSubscriptionKey(stored.key, licenseServerUrl(app.isPackaged))

	// Told apart on purpose: "the server said no" ends access, "we could not ask" does not.
	const unreachable = result.reason === 'server-error'
	if (!unreachable) return remember(stored, result)

	if (!policy.required && stored.subscription) {
		log.info('Licence server unreachable; continuing on the cached answer')
		return statusFromCache(stored.subscription, new Date(), true)
	}

	log.warn(`Licence server unreachable and no usable cache: ${policy.reasonIfUnreachable}`)
	return {
		...fail(policy.reasonIfUnreachable),
		// Kept so the settings page can still show whose licence this is while it is
		// unverifiable, rather than going blank the moment the network drops.
		...(stored.subscription ? { subscription: stored.subscription } : {}),
	}
}

/**
 * The current licence status.
 *
 * Asynchronous because a subscription key may need the network. It usually does not: a
 * cached answer less than a day old is returned without a request, so the ordinary launch
 * costs one file read.
 */
export async function licenseStatus(force = false): Promise<LicenseStatus> {
	if (developerBypass()) return bypassStatus()

	const stored = readStored()
	if (!stored) {
		cached = null
		return fail('missing')
	}

	if (stored.kind === 'offline') {
		if (cached?.stored.key === stored.key) return cached.status
		const verified = checkLicenseKey(stored.key)
		const status = verified.valid && verified.payload
			? statusFromOfflinePayload(verified.payload)
			: verified
		cached = { stored, status }
		log.info(status.valid
			? `Licensed to ${status.payload?.name ?? 'unknown'} (${status.tier})`
			: `Stored licence is not usable: ${status.reason}`)
		return status
	}

	return subscriptionStatus(stored, force)
}

/** Verifies a key and, if it is good, stores it. Returns what the user should be told. */
export async function activateLicense(key: string): Promise<LicenseStatus> {
	const normalized = normalizeLicenseKey(key)
	const kind = licenseKeyKind(normalized)
	if (!kind) return fail('malformed')

	let status: LicenseStatus
	if (kind === 'offline') {
		const verified = checkLicenseKey(normalized)
		status = verified.valid && verified.payload
			? statusFromOfflinePayload(verified.payload)
			: verified
	}
	else {
		status = await checkSubscriptionKey(normalized, licenseServerUrl(app.isPackaged))
	}

	// Nothing is stored for a key that did not work, so a mistyped key leaves no trace and
	// the next launch shows the gate rather than a stored failure.
	if (!status.valid) return status

	const stored: StoredLicense = { key: normalized, kind, subscription: status.subscription }
	if (!writeStored(stored)) {
		// Verified but unstorable. Say so, rather than reporting success and then asking
		// for the key again on the next launch.
		return {
			valid: false,
			reason: 'missing',
			message: 'The key is valid, but it could not be saved. Check permissions on the application data folder.',
		}
	}

	cached = { stored, status }
	log.info(`Licence activated: ${kind}, tier ${status.tier}`)
	notifyLicenseChanged()
	return status
}

/**
 * Asks the dashboard again, ignoring the cache.
 *
 * What the "Refresh" button in settings calls, so someone who has just upgraded or topped
 * up their credits does not have to wait out the revalidation window or restart.
 */
export async function refreshLicense(): Promise<LicenseStatus> {
	const status = await licenseStatus(true)
	notifyLicenseChanged()
	return status
}

export function clearLicense(): void {
	cached = null
	try {
		rmSync(licenseFilePath(), { force: true })
	}
	catch (e) {
		log.error('Could not remove the stored licence:', e)
	}
	notifyLicenseChanged()
}

export function initLicense() {
	ipcMain.handle('license', async (_event, action: string, ...params: unknown[]) => {
		switch (action) {
			case 'status':
				return licenseStatus()
			case 'refresh':
				return refreshLicense()
			case 'activate':
				return activateLicense(String(params[0] ?? ''))
			case 'clear':
				clearLicense()
				return licenseStatus()
			default:
				log.error('Unknown licence action:', action)
				return licenseStatus()
		}
	})
}
