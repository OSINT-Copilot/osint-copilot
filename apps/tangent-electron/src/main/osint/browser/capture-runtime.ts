/**
 * When a capture happens, and for whom.
 *
 * Arming is per profile and off by default. That is the decision the plan settled on and
 * it is the right one for this tool: passive capture is what makes the category useful --
 * "I forgot to press record" is the case people pay to avoid -- but writing down every
 * page an investigator looks at, unasked, is not something to switch on for them. Arming
 * an identity is the moment they accept that everything seen as that identity is kept.
 */
import Logger from 'js-logger'

import { partitionForToken } from './attach-guard'
import { captureGuest, type CaptureOutcome } from './capture'
import { PARTITION_PREFIX } from './profiles'
import { extractText, isWatching, scanGuest } from './selector-runtime'

/**
 * How long the page must be quiet before it is worth archiving.
 *
 * `did-stop-loading` fires when the main resource is done, which on a modern page is well
 * before the content exists. Waiting for a settle costs a second and is the difference
 * between capturing an article and capturing a spinner.
 */
const SETTLE_MS = 900

/** Default ceiling per profile. Armed browsing is measured in gigabytes a day otherwise. */
export const DEFAULT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024

const armedProfiles = new Set<string>()
const guestProfiles = new Map<number, string>()
const guestHosts = new Map<number, Electron.WebContents>()
const pending = new Map<number, ReturnType<typeof setTimeout>>()

let budgetBytes = DEFAULT_BUDGET_BYTES

export function captureBudgetBytes(): number {
	return budgetBytes
}

export function setCaptureBudgetBytes(bytes: number): void {
	budgetBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : DEFAULT_BUDGET_BYTES
}

/** Resolves a renderer-held session token to the profile it was issued for. */
export function partitionOwner(token: string): string | null {
	const partition = partitionForToken(token)
	if (!partition || !partition.startsWith(PARTITION_PREFIX)) return null
	return partition.slice(PARTITION_PREFIX.length) || null
}

export function rememberGuest(webContentsId: number, profileId: string): void {
	guestProfiles.set(webContentsId, profileId)
}

export function rememberGuestHost(webContentsId: number, host: Electron.WebContents): void {
	guestHosts.set(webContentsId, host)
}

export function forgetGuest(webContentsId: number): void {
	guestProfiles.delete(webContentsId)
	guestHosts.delete(webContentsId)
}

export function guestProfile(webContentsId: number): string {
	return guestProfiles.get(webContentsId) ?? 'default'
}

export function armProfile(profileId: string, armed: boolean): void {
	if (armed) armedProfiles.add(profileId)
	else armedProfiles.delete(profileId)
	Logger.info(`[osint] capture ${armed ? 'armed' : 'disarmed'} for profile "${profileId}"`)
}

export function isArmed(profileId: string): boolean {
	return armedProfiles.has(profileId)
}

export function cancelCapture(webContentsId: number): void {
	const timer = pending.get(webContentsId)
	if (timer) clearTimeout(timer)
	pending.delete(webContentsId)
}

/**
 * Debounced: a page that settles, then settles again as a lazy section loads, is captured
 * once. Restarting the timer on every signal also means an infinite feed that keeps
 * emitting `did-navigate-in-page` while the reader scrolls produces one capture when they
 * stop, not one per scroll.
 */
export function scheduleCapture(guest: Electron.WebContents): void {
	const id = guest.id
	// The two toggles are independent, and share one settle. Watching without arming is the
	// common case -- capture is off by default -- and a matcher fed only from captured text
	// would therefore find nothing almost all of the time.
	if (!isArmed(guestProfile(id)) && !isWatching()) return

	cancelCapture(id)
	pending.set(id, setTimeout(() => {
		pending.delete(id)
		void runSettledWork(guest)
	}, SETTLE_MS))
}

async function runSettledWork(guest: Electron.WebContents): Promise<void> {
	if (guest.isDestroyed()) return
	const id = guest.id
	const armed = isArmed(guestProfile(id))
	let scanText = ''

	if (isWatching()) {
		try {
			const result = await scanGuest(guest)
			scanText = result.text
			// Reported even when EMPTY. Only reporting hits leaves the previous page's
			// findings on screen, which attributes them to whatever the analyst is looking
			// at now -- the one way this feature could actively mislead someone.
			reportHits(id, result.url, result.hits, result.timedOutOn)
		}
		catch (e) {
			Logger.warn('[osint] selector scan failed:', e)
		}
	}
	else if (armed) {
		// Read even when not watching, so a capture carries the text a LATER watchlist can
		// be re-run over. Captured evidence with no readable text is evidence you cannot
		// search once you learn what you were looking for.
		scanText = await extractText(guest)
	}

	if (!armed || guest.isDestroyed()) return

	try {
		report(id, await captureGuest({ guest, profileId: guestProfile(id), budgetBytes, scanText }))
	}
	catch (e) {
		Logger.warn('[osint] capture failed:', e)
		report(id, { status: 'skipped', reason: String((e as Error)?.message ?? e) })
	}
}

function reportHits(
	webContentsId: number, url: string, hits: unknown[], timedOutOn?: string,
): void {
	const host = guestHosts.get(webContentsId)
	if (!host || host.isDestroyed()) return
	host.send('osint:browse.hits', { webContentsId, url, hits, timedOutOn })
}

function report(webContentsId: number, outcome: CaptureOutcome): void {
	const host = guestHosts.get(webContentsId)
	if (!host || host.isDestroyed()) return
	host.send('osint:browse.capture', { webContentsId, outcome })
}

/** Test seam. */
export function resetCaptureRuntimeForTests(): void {
	armedProfiles.clear()
	guestProfiles.clear()
	guestHosts.clear()
	for (const timer of pending.values()) clearTimeout(timer)
	pending.clear()
	budgetBytes = DEFAULT_BUDGET_BYTES
}
