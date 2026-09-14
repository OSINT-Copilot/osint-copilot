/**
 * What has been captured, so the same page is not written forty times.
 *
 * Armed browsing captures on every load-settle, and an infinite feed settles repeatedly
 * while the reader scrolls. Without dedupe, a morning on one site is gigabytes of
 * near-identical archives; with it, a capture is written when the page is actually
 * different from the last one at that address.
 *
 * The key is (normalised url, DOM hash). The URL alone is not enough -- a dashboard at one
 * address genuinely changes -- and the hash alone is not enough either, because the same
 * content served from two addresses is two pieces of evidence.
 *
 * Pure, so the accounting and the budget are testable without a filesystem.
 */

export interface CaptureRecord {
	id: string
	/** As the guest reported it. */
	url: string
	/** Dedupe key. Must agree with the renderer's normalizeSourceUrl. */
	normalisedUrl: string
	title: string
	capturedAt: string
	/** sha256 of the MHTML archive -- the bytes the markdown was derived from. */
	sha256: string
	/** Hash of the document alone, so a page that only changed its subresources dedupes. */
	domHash: string
	profileId: string
	files: { mhtml: string, markdown: string, screenshot?: string, text?: string }
	bytes: number
	/** Present when a screenshot could not be taken; recorded rather than silently absent. */
	screenshotFailure?: string
}

export interface CaptureIndex {
	version: 1
	captures: CaptureRecord[]
}

export const EMPTY_INDEX: CaptureIndex = { version: 1, captures: [] }

/**
 * Must agree with normalizeSourceUrl in src/osint/services/osint-confidence-engine.ts.
 *
 * Duplicated rather than imported because main's tsconfig cannot resolve `osint/*`, and
 * reaching across that boundary drags Tangent's tree into the strict typecheck. The
 * agreement is pinned by a test that imports both.
 */
export function normaliseCaptureUrl(url: string): string {
	const trimmed = url.trim()
	try {
		if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
			const parsed = new URL(trimmed)
			parsed.hash = ''
			return parsed.toString()
		}
	}
	catch {
		/* vault path or nonsense; returned as-is, like the renderer does */
	}
	return trimmed
}

export function parseCaptureIndex(text: string | null): CaptureIndex {
	if (!text) return { ...EMPTY_INDEX, captures: [] }
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === 'object' && Array.isArray(parsed.captures)) {
			return { version: 1, captures: parsed.captures as CaptureRecord[] }
		}
	}
	catch {
		/* a corrupt index must not stop the operator capturing */
	}
	return { ...EMPTY_INDEX, captures: [] }
}

export function serialiseCaptureIndex(index: CaptureIndex): string {
	return JSON.stringify(index, null, '\t') + '\n'
}

/** The most recent capture of this address, whatever its content was. */
export function lastCaptureOf(index: CaptureIndex, url: string): CaptureRecord | undefined {
	const key = normaliseCaptureUrl(url)
	for (let i = index.captures.length - 1; i >= 0; i--) {
		if (index.captures[i].normalisedUrl === key) return index.captures[i]
	}
	return undefined
}

/**
 * True when this exact document at this exact address is already on disk.
 *
 * Compared against the LAST capture of the address rather than all of them, so a page that
 * alternates between two states still records each change. Someone watching a page for
 * edits needs the flapping, not a single sample of each state ever seen.
 */
export function isDuplicate(index: CaptureIndex, url: string, domHash: string): boolean {
	return lastCaptureOf(index, url)?.domHash === domHash
}

export function bytesForProfile(index: CaptureIndex, profileId: string): number {
	return index.captures
		.filter(capture => capture.profileId === profileId)
		.reduce((total, capture) => total + (capture.bytes || 0), 0)
}

export interface BudgetVerdict {
	permitted: boolean
	usedBytes: number
	budgetBytes: number
	reason?: string
}

/**
 * Whether another capture fits.
 *
 * Over budget, capture STOPS; it does not prune. Deleting the oldest evidence to make room
 * for the newest is the wrong failure for a chain of custody -- an investigator who comes
 * back to a case should find a gap they were told about, not a record that quietly
 * rewrote itself.
 */
export function checkBudget(
	index: CaptureIndex, profileId: string, budgetBytes: number, incomingBytes: number,
): BudgetVerdict {
	const usedBytes = bytesForProfile(index, profileId)
	if (budgetBytes <= 0) return { permitted: true, usedBytes, budgetBytes }
	if (usedBytes + incomingBytes <= budgetBytes) return { permitted: true, usedBytes, budgetBytes }
	return {
		permitted: false,
		usedBytes,
		budgetBytes,
		reason: `Capture budget reached for this profile: ${Math.round(usedBytes / 1e6)} MB of `
			+ `${Math.round(budgetBytes / 1e6)} MB. Nothing has been deleted; capturing is paused `
			+ 'until the budget is raised or older captures are removed deliberately.',
	}
}

export function addCapture(index: CaptureIndex, record: CaptureRecord): CaptureIndex {
	return { version: 1, captures: [...index.captures, record] }
}
