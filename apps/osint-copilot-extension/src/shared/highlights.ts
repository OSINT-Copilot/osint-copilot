// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Messages between the content script and the service worker, for highlights, and the
 * ::highlight() styles.
 *
 * The content script runs beside page code that can read the DOM, drive the selection
 * and fake input, but cannot call chrome.runtime. So its messages are few, and the worker
 * answers each one only about the sender's own tab and top frame, identified by Chrome
 * (sender.tab, sender.frameId), never by anything in the message. A content script is
 * never told the pairing key, the app's port, the investigations or the queue.
 */
import type { HighlightSelectors } from './protocol';

/** What the content script needs to find and paint one highlight. */
export interface ContentHighlight {
	id: string;
	selectors: HighlightSelectors;
}

export type HighlightStatus = 'exact' | 'fuzzy' | 'orphan';

export interface HighlightNames {
	exact: string;
	fuzzy: string;
}

/** Content script to worker. */
export type ContentRequest =
	/**
	 * On load and after an in-page navigation: "which highlights are on this page?" The
	 * reply is ContentReady.
	 */
	| { type: 'content.ready'; names: HighlightNames | null }
	/**
	 * Which highlights were found, approximately found, or not found. navigated: the page
	 * changed its address without loading, and shows no highlights until asked (ContentReady).
	 */
	| { type: 'content.report'; statuses: HighlightReport[]; navigated?: boolean }
	/** The investigator clicked a highlight; the panel, if open, shows it. */
	| { type: 'content.clicked'; id: string };

export interface HighlightReport {
	id: string;
	status: HighlightStatus;
}

/**
 * The answer to content.ready: the highlights of the page the document was loaded from.
 * Chrome names that page (sender.url), and it does not follow history.pushState. So when
 * the tab's address has moved on since (a single-page site), the answer is navigated and
 * no highlights: another address's highlights are shown only when the investigator asks
 * for them from the panel (content.paint), never because the page moved its address.
 */
export interface ContentReady {
	highlights: ContentHighlight[];
	navigated?: boolean;
}

/** What a content script says about its page: content.status's reply. */
export interface ContentStatus {
	statuses: HighlightReport[];
	navigated: boolean;
}

export const CONTENT_REQUEST_TYPES: readonly ContentRequest['type'][] = ['content.ready', 'content.report', 'content.clicked'];

/** Worker to content script. */
export type ContentCommand =
	| { type: 'content.describeSelection' }
	| { type: 'content.add'; highlight: ContentHighlight }
	| { type: 'content.remove'; id: string }
	| { type: 'content.findAgain'; id: string }
	| { type: 'content.scrollTo'; id: string }
	/** Ask for this page's highlights again: the investigation changed, or the extension was unpaired. */
	| { type: 'content.refresh' }
	/** Report again (ContentStatus): the worker restarted and forgot. */
	| { type: 'content.status' }
	/** Show these highlights, which the investigator asked for from the panel for the tab's address. */
	| { type: 'content.paint'; highlights: ContentHighlight[] };

export type DescribeReply =
	/** shown: the selection as the browser reads it (Selection.toString()). */
	| { ok: true; selectors: HighlightSelectors; exact: string; shown: string }
	/** hidden-text: the page hides text inside the selection, so the quote is not what was seen. */
	| { ok: false; reason: 'no-selection' | 'empty' | 'too-long' | 'not-in-page' | 'hidden-text' };

/** Invisible in any case: whitespace, soft hyphens and zero-width characters, which a copy may drop. */
const INVISIBLE = /[\s\u00ad\u200b-\u200d\u2060\ufeff]+/g;

/**
 * Text as compared across readings of it (the DOM's, the browser's, the menu's): without
 * what is invisible, and without case. Upper then lower: "ß" and "SS" (text-transform)
 * meet as "ss", and "İ" lowers to an "i".
 */
export function foldText(text: string): string {
	return text.replace(INVISIBLE, '').toUpperCase().toLowerCase();
}

/**
 * Whether the selection the right-click menu reported is still the one being described.
 * The menu's copy may be cut short, so it need only begin the same.
 */
export function sameSelection(menuText: string, shown: string): boolean {
	const menu = foldText(menuText);
	return menu.length > 0 && foldText(shown).startsWith(menu);
}

/** The painter's names are random and of exactly this shape; anything else is not styled. */
export const HIGHLIGHT_NAME = /^oc-[a-z0-9]{12}$/;

export function isHighlightNames(value: unknown): value is HighlightNames {
	const v = value as Partial<HighlightNames> | null;
	return !!v && typeof v === 'object' && typeof v.exact === 'string' && typeof v.fuzzy === 'string'
		&& HIGHLIGHT_NAME.test(v.exact) && HIGHLIGHT_NAME.test(v.fuzzy) && v.exact !== v.fuzzy;
}

/**
 * The ::highlight() rules for a painter's names, injected with origin USER: a user
 * !important rule beats the page's own !important rules, so a page cannot restyle or hide
 * our marks with CSS. Only background, colour and text decoration are allowed in
 * ::highlight(), so a mark cannot carry anything but colour.
 */
export function highlightCss(names: HighlightNames): string {
	if (!isHighlightNames(names)) throw new Error('not highlight names');
	return [
		`::highlight(${names.exact}) { background-color: rgba(255, 214, 10, 0.55) !important; color: inherit !important; }`,
		// Found approximately: the text changed since it was highlighted.
		`::highlight(${names.fuzzy}) { background-color: rgba(255, 149, 0, 0.35) !important; color: inherit !important; `
			+ 'text-decoration: underline wavy rgba(200, 80, 0, 0.9) !important; }',
	].join('\n');
}
