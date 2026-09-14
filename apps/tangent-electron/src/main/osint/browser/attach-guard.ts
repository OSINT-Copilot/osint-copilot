/**
 * What a <webview> is allowed to be, decided in main.
 *
 * `will-attach-webview` is the only moment where main can still change a guest's
 * webPreferences, and it is the reason enabling `webviewTag` is safe at all. Everything
 * the renderer put on the element is a *request*; this module answers it.
 *
 * Two things make that necessary rather than tidy:
 *
 *  - Electron's inheritance is conditional. A guest inherits a preference from its host
 *    only where the host's value matches the default, and `webSecurity` is not inherited
 *    at all -- it is computed from the renderer-controlled `disablewebsecurity`
 *    attribute. So "the window is sandboxed, therefore guests are" is not a guarantee.
 *  - The renderer must not pick the cookie jar. A guest's partition decides which
 *    identity a site sees, so letting the renderer name one means a bug in pane
 *    bookkeeping can log a sock puppet into the wrong investigation. Main hands out
 *    opaque tokens and translates them here; a token it does not recognise is refused.
 *
 * Electron-free, like the guards beside it, so the policy is unit-testable.
 */
import Logger from 'js-logger'

/**
 * Partitions are namespaced so nothing here can collide with a Tangent session.
 *
 * No `persist:` prefix, so the jar lives in memory and dies with the app. Phase 2 adds
 * named profiles backed by `Session.fromPath` under userData -- deliberately not in the
 * vault, where the workspace watchers would churn on Chromium's LevelDB files and the
 * jar would sit unencrypted inside the artifact analysts sync to each other.
 */
export const BROWSE_PARTITION_PREFIX = 'osint-browse-'

/** Schemes a guest may be pointed at. Everything else -- file:, data:, blob: -- is refused. */
const PERMITTED_SCHEMES = ['http:', 'https:']

export interface AttachRequest {
	/** The token the renderer put in the `partition` attribute. */
	partition?: string
	src?: string
	preload?: string
	disablewebsecurity?: string
	[key: string]: string | undefined
}

export interface AttachDecision {
	allowed: boolean
	/** Present when allowed: the real partition main chose for this pane. */
	partition?: string
	/** Present when refused: why, for the log. */
	reason?: string
}

/** token -> partition. A pane holds its token for as long as it is open. */
const sessionsByToken = new Map<string, string>()

/**
 * Registers a browsing session and returns the token the renderer should hand back.
 *
 * The token is deliberately not the partition: it is meaningless outside this map, so a
 * renderer that leaks or confuses one cannot address another profile's jar.
 */
export function registerSession(token: string, profileId: string): void {
	sessionsByToken.set(token, BROWSE_PARTITION_PREFIX + profileId)
}

export function releaseSession(token: string): void {
	sessionsByToken.delete(token)
}

/** Test seam. */
export function clearSessions(): void {
	sessionsByToken.clear()
}

export function isBrowseUrlPermitted(src: string | undefined): boolean {
	// A guest that has not been pointed anywhere yet is fine; it is showing nothing.
	if (!src || src === 'about:blank') return true
	let parsed: URL
	try {
		parsed = new URL(src)
	}
	catch {
		return false
	}
	return PERMITTED_SCHEMES.includes(parsed.protocol)
}

/**
 * Decides whether this attach may proceed, and under which partition.
 *
 * Refusing is the default: an unrecognised token, or no token at all, means something
 * other than a browsing pane is trying to create a guest.
 */
export function decideAttach(params: AttachRequest): AttachDecision {
	const token = params.partition
	if (!token) return { allowed: false, reason: 'no session token' }

	const partition = sessionsByToken.get(token)
	if (!partition) return { allowed: false, reason: 'unknown session token' }

	if (!isBrowseUrlPermitted(params.src)) {
		return { allowed: false, reason: `refused scheme in src: ${params.src}` }
	}

	return { allowed: true, partition }
}

/**
 * The preferences a guest gets, whatever it asked for.
 *
 * Written as an overwrite rather than a validation on purpose: a validator has to
 * enumerate everything dangerous and stays wrong as Electron adds preferences, while an
 * overwrite is wrong only about the things it names.
 */
export function applyGuestPreferences(webPreferences: Record<string, unknown>): void {
	// Nothing the renderer asked for is trusted; a preload in particular would be a file
	// path of its choosing running next to hostile page content.
	delete webPreferences.preload
	delete webPreferences.preloadURL

	webPreferences.nodeIntegration = false
	webPreferences.nodeIntegrationInWorker = false
	webPreferences.nodeIntegrationInSubFrames = false
	webPreferences.contextIsolation = true
	webPreferences.sandbox = true
	// NOT inherited from the host: Electron computes this from the `disablewebsecurity`
	// attribute, which the renderer controls. Turning it off would drop the same-origin
	// policy for every site in that guest.
	webPreferences.webSecurity = true
	webPreferences.allowRunningInsecureContent = false
	webPreferences.experimentalFeatures = false
	// The app's own spellchecker dictionary is per-session and not something a browsing
	// guest should be adding words to.
	webPreferences.spellcheck = false
}

/** Applies the decision to the live params object, and says whether to proceed. */
export function guardAttach(
	params: AttachRequest,
	webPreferences: Record<string, unknown>,
): boolean {
	const decision = decideAttach(params)
	if (!decision.allowed) {
		Logger.warn('[osint] refused a <webview> attach:', decision.reason)
		return false
	}
	params.partition = decision.partition
	// Refuse any preload the element named, at the params level too: Electron reads it
	// from here as well as from webPreferences depending on version.
	delete params.preload
	params.disablewebsecurity = ''
	applyGuestPreferences(webPreferences)
	return true
}
