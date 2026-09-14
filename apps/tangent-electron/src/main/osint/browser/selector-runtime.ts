/**
 * Watching pages for what an investigation cares about.
 *
 * Two toggles, deliberately independent of each other:
 *
 *   - "capture pages" is per PROFILE and off by default (Phase 3).
 *   - "watch selectors" is per INVESTIGATION, and is this.
 *
 * Collapsing them was the obvious simplification and it is wrong. Auto-capture is off for
 * most browsing, so a matcher fed only from captured text would find nothing almost all of
 * the time -- the feature would appear to work and quietly do nothing. Watching reads the
 * live page whether or not anything is being written down.
 */
import Logger from 'js-logger'

import * as vaultFs from '../node/vault'
import { parseSelectors, type Selector, type SelectorHit } from './selector-policy'
import { scan } from './selector-host'

export const SELECTORS_VAULT_PATH = 'OSINTCopilot/browsing/selectors.json'

/**
 * Pulled by MAIN from the guest's isolated world.
 *
 * `innerText` rather than `textContent` on purpose: it reports what is actually laid out
 * and visible, so hidden SEO stuffing and off-screen markup do not become hits an analyst
 * then has to explain. Falls back when there is no body to read.
 */
export const TEXT_SNIPPET = `(() => {
	try {
		const body = document.body
		if (!body) return ''
		return body.innerText || body.textContent || ''
	} catch { return '' }
})()`

let watching = false

export function setWatching(value: boolean): void {
	watching = value
	Logger.info(`[osint] selector watching ${value ? 'on' : 'off'}`)
}

export function isWatching(): boolean {
	return watching
}

export async function loadSelectors(): Promise<Selector[]> {
	try {
		return parseSelectors(await vaultFs.read(SELECTORS_VAULT_PATH))
	}
	catch {
		return []
	}
}

/** The visible text of a guest, as the matcher will see it. */
export async function extractText(guest: Electron.WebContents): Promise<string> {
	try {
		// World 1, the same isolated world the reality check uses: the page cannot read the
		// probe, and no channel is exposed to it.
		const text = await guest.executeJavaScriptInIsolatedWorld(1, [{ code: TEXT_SNIPPET }])
		return typeof text === 'string' ? text : ''
	}
	catch (e) {
		Logger.warn('[osint] could not read page text:', e)
		return ''
	}
}

export interface GuestScan {
	/**
	 * The address the text was read from.
	 *
	 * Carried because a scan outlives the page it started on: extraction and matching take
	 * long enough that the analyst can navigate away mid-scan, and a result delivered after
	 * that would put the previous page's findings under the new address. Whoever displays
	 * this compares it against what is on screen now.
	 */
	url: string
	text: string
	hits: SelectorHit[]
	timedOutOn?: string
}

export async function scanGuest(guest: Electron.WebContents): Promise<GuestScan> {
	const url = guest.getURL()
	const text = await extractText(guest)
	if (!text.trim()) return { url, text, hits: [] }
	const selectors = await loadSelectors()
	if (!selectors.length) return { url, text, hits: [] }
	const result = await scan(selectors, text)
	return { url, text, hits: result.hits, timedOutOn: result.timedOutOn }
}

/**
 * Re-runs the current watchlist over everything already captured.
 *
 * The point of a watchlist is that you learn what matters partway through. Hunchly's
 * selectors apply to history as well as to new pages, and a version that only looked
 * forward would be the less useful half of the feature.
 */
export async function rescan(
	captures: Array<{ id: string, url: string, title: string, files: { text?: string } }>,
): Promise<Array<{ captureId: string, url: string, title: string, hits: SelectorHit[] }>> {
	const selectors = await loadSelectors()
	if (!selectors.length) return []

	const results: Array<{ captureId: string, url: string, title: string, hits: SelectorHit[] }> = []
	for (const capture of captures) {
		if (!capture.files.text) continue
		let text: string
		try {
			text = await vaultFs.read(capture.files.text)
		}
		catch {
			// A capture whose text file was deleted is skipped rather than failing the run.
			continue
		}
		const result = await scan(selectors, text)
		if (result.hits.length) {
			results.push({ captureId: capture.id, url: capture.url, title: capture.title, hits: result.hits })
		}
	}
	return results
}

/** Test seam. */
export function resetSelectorRuntimeForTests(): void {
	watching = false
}
