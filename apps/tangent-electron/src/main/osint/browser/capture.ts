/**
 * Turning a live page into evidence.
 *
 * The sequence matters more than any single step. The MHTML archive is taken first, the
 * document is read back OUT of that archive, and the markdown and both hashes are derived
 * from those same bytes -- so the hash attests to the thing the analyst reads, rather than
 * to a different moment of a page that kept changing while we worked.
 *
 * What the hash is, precisely: sha256 of a locally re-serialised post-JavaScript DOM, with
 * <script> and <noscript> stripped by Chromium's own MHTML writer. It is tamper-evidence
 * AFTER capture. It is NOT a record of what the server sent, and must never be described
 * as one.
 */
import { createHash, randomUUID } from 'crypto'

import * as vaultFs from '../node/vault'
import { extractMainDocument } from './mhtml'
import { htmlToMarkdown } from './html-to-markdown-node'
import {
	addCapture, checkBudget, isDuplicate, normaliseCaptureUrl,
	parseCaptureIndex, serialiseCaptureIndex,
	type CaptureIndex, type CaptureRecord,
} from './capture-index'

/**
 * Must agree with DEFAULT_EVIDENCE_FOLDER in src/osint/constants/vault-layout.ts.
 * Duplicated for the same reason as the URL normaliser, and pinned by the same kind of test.
 */
export const EVIDENCE_FOLDER = 'OSINTCopilot/Evidence'
export const CAPTURE_INDEX_PATH = 'OSINTCopilot/browsing/captures.json'

/** Smaller than this and the image is a blank or torn frame, not a screenshot. */
const MIN_SCREENSHOT_EDGE = 50

function sha256(data: string | Uint8Array): string {
	return createHash('sha256').update(data as any).digest('hex')
}

/** A filename that says what it is, without inviting a path traversal or a 300-char name. */
export function evidenceSlug(title: string, url: string): string {
	const source = (title || '').trim() || (() => {
		try { return new URL(url).hostname }
		catch { return 'capture' }
	})()
	const slug = source
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
	return slug || 'capture'
}

export type CaptureOutcome =
	| { status: 'captured', record: CaptureRecord }
	| { status: 'duplicate', url: string }
	| { status: 'over-budget', reason: string, usedBytes: number, budgetBytes: number }
	| { status: 'skipped', reason: string }

export interface CaptureRequest {
	guest: Electron.WebContents
	profileId: string
	/** 0 means no limit. */
	budgetBytes: number
	/** The visible text of the page, as the selector matcher saw it. */
	scanText?: string
}

async function readIndex(): Promise<CaptureIndex> {
	try {
		return parseCaptureIndex(await vaultFs.read(CAPTURE_INDEX_PATH))
	}
	catch {
		return parseCaptureIndex(null)
	}
}

/**
 * Writes through a `.part` name and renames into place.
 *
 * Tangent's watcher polls a file while it is still growing (chokidar awaitWriteFinish at
 * 30ms), and a multi-megabyte archive written directly is a burst of events for a file
 * nothing can read yet. `.part` is not a known extension, so the watcher ignores it, and
 * the rename is one event for a file that is already complete.
 */
async function writeStaged(path: string, data: string | Uint8Array): Promise<void> {
	const staging = `${path}.part`
	if (typeof data === 'string') await vaultFs.write(staging, data)
	else await vaultFs.writeBinary(staging, data)
	await vaultFs.rename(staging, path)
}

/**
 * Takes the screenshot, and reports failure rather than storing a broken image.
 *
 * `capturePage` renders the guest's VISIBLE viewport. A pane that is collapsed to a strip,
 * scrolled out of the thread, or behind another window yields a truncated or 0x0 image --
 * and a blank PNG filed as evidence is worse than a recorded gap, because it looks like
 * the page was blank.
 */
interface ScreenshotResult {
	png?: Buffer
	reason?: string
}

async function screenshot(guest: Electron.WebContents): Promise<ScreenshotResult> {
	try {
		const image = await guest.capturePage()
		const size = image.getSize()
		if (size.width < MIN_SCREENSHOT_EDGE || size.height < MIN_SCREENSHOT_EDGE) {
			return {
				reason: `the pane was not rendered at capture time (${size.width}x${size.height}); `
					+ 'a collapsed or hidden pane cannot be screenshotted',
			}
		}
		return { png: image.toPNG() }
	}
	catch (e) {
		return { reason: String((e as Error)?.message ?? e) }
	}
}

export async function captureGuest(request: CaptureRequest): Promise<CaptureOutcome> {
	const { guest, profileId, budgetBytes } = request
	const url = guest.getURL()
	if (!url || url === 'about:blank') return { status: 'skipped', reason: 'nothing loaded' }

	const alreadyAttached = guest.debugger.isAttached()
	if (!alreadyAttached) guest.debugger.attach('1.3')

	let mhtml: string
	try {
		const result = await guest.debugger.sendCommand('Page.captureSnapshot', { format: 'mhtml' })
		mhtml = (result as { data: string }).data
	}
	finally {
		// DevTools and the debugger are mutually exclusive; do not hold it open.
		if (!alreadyAttached && guest.debugger.isAttached()) guest.debugger.detach()
	}

	const { html } = extractMainDocument(mhtml)
	const domHash = sha256(html)

	const index = await readIndex()
	if (isDuplicate(index, url, domHash)) return { status: 'duplicate', url }

	const title = guest.getTitle() ?? ''
	const markdown = htmlToMarkdown(html, { sourceUrl: url })
	// Derived from the same archive as everything else, so the text a selector matched is
	// the text that was captured -- not a separate read of a page that has moved on.
	const scanText = request.scanText ?? ''
	const shot = await screenshot(guest)

	const archiveBytes = Buffer.byteLength(mhtml, 'utf8')
	const markdownBytes = Buffer.byteLength(markdown, 'utf8')
	const shotBytes = shot.png ? shot.png.byteLength : 0
	const bytes = archiveBytes + markdownBytes + shotBytes

	const verdict = checkBudget(index, profileId, budgetBytes, bytes)
	if (!verdict.permitted) {
		return {
			status: 'over-budget',
			reason: verdict.reason!,
			usedBytes: verdict.usedBytes,
			budgetBytes: verdict.budgetBytes,
		}
	}

	const capturedAt = new Date().toISOString()
	const archiveHash = sha256(mhtml)
	const stem = `${evidenceSlug(title, url)}-${archiveHash.slice(0, 8)}`

	const files: CaptureRecord['files'] = {
		mhtml: `${EVIDENCE_FOLDER}/${stem}.mhtml`,
		markdown: `${EVIDENCE_FOLDER}/${stem}.md`,
		// The exact text the watchlist was run against, kept so a re-scan feeds the matcher
		// the same shape of input as the live scan did. Without it, adding a selector later
		// and re-running it over history would silently be a different operation -- and a
		// hit that appears on re-scan but not live, or the reverse, is not explainable.
		text: `${EVIDENCE_FOLDER}/${stem}.txt`,
	}

	await writeStaged(files.mhtml, mhtml)
	await writeStaged(files.markdown, [
		'---',
		`source_url: ${JSON.stringify(url)}`,
		`captured_at: ${capturedAt}`,
		`sha256: ${archiveHash}`,
		`profile: ${JSON.stringify(profileId)}`,
		`archive: ${JSON.stringify(files.mhtml)}`,
		'---',
		'',
		`# ${title || url}`,
		'',
		markdown,
	].join('\n'))

	await writeStaged(files.text!, scanText)

	if (shot.png) {
		files.screenshot = `${EVIDENCE_FOLDER}/${stem}.png`
		await writeStaged(files.screenshot, shot.png)
	}

	const record: CaptureRecord = {
		id: randomUUID(),
		url,
		normalisedUrl: normaliseCaptureUrl(url),
		title,
		capturedAt,
		sha256: archiveHash,
		domHash,
		profileId,
		files,
		bytes,
	}
	// Recorded, not omitted: a capture with no screenshot should say why, or the gap reads
	// as a page that looked blank.
	if (shot.reason) record.screenshotFailure = shot.reason

	await writeStaged(CAPTURE_INDEX_PATH, serialiseCaptureIndex(addCapture(index, record)))
	return { status: 'captured', record }
}
