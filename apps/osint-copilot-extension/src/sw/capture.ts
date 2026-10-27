// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Page capture: the tab as MHTML, what the analyst saw of it, and a PDF tab's own bytes.
 *
 * Evidence has to be of the page the analyst meant. So the tab is read before and after
 * the archive is made, and the screenshot (captureVisibleTab shows whatever is on screen
 * in that window, not a given tab) is taken only while the same tab, at the same URL, is
 * still the one showing; otherwise it is left out and the item says why. A PDF is fetched
 * again with the browser's own cookies, because an investigator is often logged in to see
 * it, but only from the exact URL the tab shows, with redirects refused and the cached
 * copy preferred, so the extension never follows the page anywhere else.
 *
 * Everything that touches Chrome is behind CaptureApi, so the rules run in Node tests.
 */
import { fromB64url } from '../shared/b64url';
import { CAPTURE_FILE_CAPS, LIMITS, type CaptureFileName, type CaptureFiles, type ManifestPage } from '../shared/protocol';
import { sha256Hex } from '../shared/signing';
import { normalisePageUrl } from '../shared/url';

export interface CaptureApi {
	getTab(tabId: number): Promise<chrome.tabs.Tab>;
	/** The active tab of a window, if any. */
	activeTabOf(windowId: number): Promise<chrome.tabs.Tab | undefined>;
	/** Rejects with Chrome's lastError message. */
	saveAsMHTML(tabId: number): Promise<Blob>;
	/** A data: URL of the window's visible area as PNG. */
	captureVisibleTab(windowId: number): Promise<string>;
	/** document.contentType of the tab's top frame, when it can be read. */
	contentType(tabId: number): Promise<string | undefined>;
	fetch(url: string, init: RequestInit): Promise<Response>;
}

/** A capture that could not be made: `code` is one describeError() knows. */
export class CaptureError extends Error {
	constructor(readonly code: string, readonly detail?: string) {
		super(detail ? `${code}: ${detail}` : code);
	}
}

export interface CapturedPage {
	page: ManifestPage;
	files: Partial<Record<CaptureFileName, Blob>>;
	decls: CaptureFiles;
	/** Plain-language remarks about what was left out and why. */
	notes: string[];
}

/**
 * Sorts a chrome.runtime.lastError message from pageCapture (or tabs) into one of our
 * codes. Chrome's wording is not an API, so each test is loose and the raw message goes
 * along as detail when nothing matches.
 */
export function captureErrorCode(message: string, url = ''): string {
	const m = message.toLowerCase();
	if (m.includes('navigated')) return 'capture_navigated';
	if (m.includes('too big') || m.includes('too large')) return 'capture_too_big';
	if (m.includes('policy')) return 'capture_policy';
	if (m.includes('file://') || url.startsWith('file:')) return 'capture_file_access';
	if (m.includes('chrome://') || m.includes('chrome-extension://') || m.includes('extensions gallery') || m.includes('webstore') || isBrowserPage(url)) {
		return 'capture_browser_page';
	}
	if (m.includes('no tab with id') || m.includes('cannot find the tab') || m.includes('tab was closed')) return 'capture_tab_gone';
	if (m.includes('permission') || m.includes('cannot access')) return 'capture_permission';
	return 'capture_failed';
}

function isBrowserPage(url: string): boolean {
	if (/^(chrome|chrome-extension|chrome-untrusted|devtools|edge|brave|about|view-source):/i.test(url)) return true;
	try {
		const u = new URL(url);
		// The Chrome Web Store: no extension may read or script it.
		return u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'));
	} catch {
		return false;
	}
}

/** Refuses, before touching the tab, a page that cannot be captured or cannot be sent. */
function checkCapturable(url: string): string {
	if (isBrowserPage(url)) throw new CaptureError('capture_browser_page');
	if (url.startsWith('file:')) throw new CaptureError('capture_not_web');
	const page = normalisePageUrl(url);
	if (!page) throw new CaptureError(url ? 'capture_not_web' : 'capture_permission');
	return page;
}

function withoutFragment(url: string): string {
	const u = new URL(url);
	u.hash = '';
	return u.href;
}

async function digest(blob: Blob): Promise<{ size: number; sha256: string }> {
	return { size: blob.size, sha256: await sha256Hex(new Uint8Array(await blob.arrayBuffer())) };
}

/** Is `after` still the same page, in front, in the same window as `before`? */
async function stillShowing(api: CaptureApi, before: chrome.tabs.Tab, after: chrome.tabs.Tab): Promise<boolean> {
	if (after.id !== before.id || after.url !== before.url || after.active !== before.active || !after.active) return false;
	if (after.windowId !== before.windowId) return false;
	const front = await api.activeTabOf(after.windowId).catch(() => undefined);
	return front?.id === after.id;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngFromDataUrl(dataUrl: string): Uint8Array<ArrayBuffer> | null {
	const m = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
	if (!m) return null;
	const bytes = fromB64url(m[1].replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'));
	if (!bytes || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
	return bytes;
}

async function viewport(api: CaptureApi, tabId: number, before: chrome.tabs.Tab, notes: string[]): Promise<Blob | undefined> {
	const changed = 'No screenshot of the visible part: the tab was switched, moved or navigated during the capture, so the screen no longer showed this page.';
	const after = await api.getTab(tabId).catch(() => undefined);
	if (!after || !(await stillShowing(api, before, after))) {
		notes.push(changed);
		return undefined;
	}
	let dataUrl: string;
	try {
		dataUrl = await api.captureVisibleTab(after.windowId);
	} catch (err) {
		notes.push(`No screenshot of the visible part: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
	// The screenshot is of whatever the window shows now; check it was still this page.
	const settled = await api.getTab(tabId).catch(() => undefined);
	if (!settled || !(await stillShowing(api, before, settled))) {
		notes.push(changed);
		return undefined;
	}
	const png = pngFromDataUrl(dataUrl);
	if (!png) {
		notes.push('No screenshot of the visible part: Chrome returned something that is not a PNG.');
		return undefined;
	}
	if (png.length > CAPTURE_FILE_CAPS['viewport.png']) {
		notes.push('No screenshot of the visible part: it is larger than the 25 MB the app accepts.');
		return undefined;
	}
	return new Blob([png], { type: 'image/png' });
}

function looksLikePdfUrl(url: string): boolean {
	try {
		return new URL(url).pathname.toLowerCase().endsWith('.pdf');
	} catch {
		return false;
	}
}

async function pdf(api: CaptureApi, tabId: number, url: string, notes: string[]): Promise<Blob | undefined> {
	const type = await api.contentType(tabId).catch(() => undefined);
	if (type !== 'application/pdf' && !looksLikePdfUrl(url)) return undefined;
	const target = withoutFragment(url);
	let res: Response;
	try {
		res = await api.fetch(target, {
			// The browser's own cookies: the analyst may be logged in to see this document.
			credentials: 'include',
			// The copy the tab already loaded, where the cache has it, rather than a new visit.
			cache: 'force-cache',
			// Only this URL: following a redirect would fetch a document the tab does not show.
			redirect: 'error',
		});
	} catch (err) {
		notes.push(`The original PDF could not be fetched from the tab's address (${err instanceof Error ? err.message : String(err)}).`);
		return undefined;
	}
	if (!res.ok || (res.url && withoutFragment(res.url) !== target)) {
		notes.push(`The original PDF could not be fetched from the tab's address (HTTP ${res.status}).`);
		return undefined;
	}
	const declared = Number(res.headers.get('Content-Length') ?? '0');
	if (declared > CAPTURE_FILE_CAPS['page.pdf']) {
		notes.push('The original PDF is larger than the 50 MB the app accepts, so it was left out.');
		return undefined;
	}
	const bytes = new Uint8Array(await res.arrayBuffer());
	const isPdf = bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
	if (!isPdf) {
		// A .pdf address that served a page (a login wall, an error) is not the document.
		if (type === 'application/pdf') notes.push('The tab\'s address did not return a PDF when fetched again, so the original PDF was left out.');
		return undefined;
	}
	if (bytes.length > CAPTURE_FILE_CAPS['page.pdf']) {
		notes.push('The original PDF is larger than the 50 MB the app accepts, so it was left out.');
		return undefined;
	}
	return new Blob([bytes], { type: 'application/pdf' });
}

/**
 * Captures one tab. Throws CaptureError when no archive can be made; anything optional
 * that fails (the screenshot, the PDF) is left out with a note instead.
 */
export async function capturePage(api: CaptureApi, tabId: number): Promise<CapturedPage> {
	let before: chrome.tabs.Tab;
	try {
		before = await api.getTab(tabId);
	} catch (err) {
		throw new CaptureError('capture_tab_gone', err instanceof Error ? err.message : undefined);
	}
	const rawUrl = before.url ?? '';
	const url = checkCapturable(rawUrl);

	let mhtml: Blob;
	try {
		mhtml = await api.saveAsMHTML(tabId);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = captureErrorCode(message, rawUrl);
		throw new CaptureError(code, code === 'capture_failed' ? message : undefined);
	}
	if (!mhtml || mhtml.size === 0) throw new CaptureError('capture_failed', 'Chrome returned an empty archive');
	if (mhtml.size > CAPTURE_FILE_CAPS['page.mhtml']) throw new CaptureError('capture_too_big');

	const notes: string[] = [];
	// First, while the screen may still show the page.
	const png = await viewport(api, tabId, before, notes);

	// The archive is of whatever the tab held while Chrome wrote it. A different address
	// afterwards means it may not be the page named below, so it is not sent as that page.
	const after = await api.getTab(tabId).catch(() => undefined);
	if (!after || after.url !== before.url) throw new CaptureError('capture_navigated');

	const pdfBlob = await pdf(api, tabId, rawUrl, notes);

	const files: Partial<Record<CaptureFileName, Blob>> = { 'page.mhtml': mhtml };
	if (png) files['viewport.png'] = png;
	if (pdfBlob) files['page.pdf'] = pdfBlob;
	const decls: Partial<CaptureFiles> = {};
	for (const [name, blob] of Object.entries(files) as [CaptureFileName, Blob][]) decls[name] = await digest(blob);

	return {
		// A page's title is the page's to choose, and not worth losing the capture over:
		// cut to what the app accepts rather than refused.
		page: { url, title: (before.title ?? '').slice(0, LIMITS.pageTitle) },
		files,
		decls: decls as CaptureFiles,
		notes,
	};
}

/** CaptureApi over Chrome, with every callback's lastError turned into a rejection. */
export function chromeCaptureApi(): CaptureApi {
	const lastError = (): Error | null => {
		const e = chrome.runtime.lastError;
		return e ? new Error(e.message ?? 'unknown error') : null;
	};
	return {
		getTab: tabId => chrome.tabs.get(tabId),
		activeTabOf: async windowId => (await chrome.tabs.query({ active: true, windowId }))[0],
		saveAsMHTML: tabId => new Promise((resolve, reject) => {
			chrome.pageCapture.saveAsMHTML({ tabId }, data => {
				const err = lastError();
				if (err) return reject(err);
				if (!data) return reject(new Error('Chrome returned no archive.'));
				// Read at once, inside the callback. The Blob is backed by a temporary file
				// Chrome deletes soon after; read a moment later (after the screenshot, say)
				// it fails with NotFoundError. The copy lives in memory, and in IndexedDB.
				data.arrayBuffer().then(bytes => resolve(new Blob([bytes], { type: 'multipart/related' })), reject);
			});
		}),
		captureVisibleTab: windowId => new Promise((resolve, reject) => {
			chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, dataUrl => {
				const err = lastError();
				if (err) reject(err);
				else resolve(dataUrl);
			});
		}),
		contentType: async tabId => {
			const [result] = await chrome.scripting.executeScript({
				target: { tabId },
				// A string from the page's isolated world, used only to compare with a constant.
				func: () => document.contentType,
			});
			return typeof result?.result === 'string' ? result.result : undefined;
		},
		fetch: (url, init) => fetch(url, init),
	};
}
