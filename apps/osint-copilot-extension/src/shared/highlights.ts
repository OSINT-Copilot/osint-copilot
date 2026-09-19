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
	/** On load and after an in-page navigation: "which highlights are on this page?" */
	| { type: 'content.ready'; names: HighlightNames | null }
	/** Which highlights were found, approximately found, or not found. */
	| { type: 'content.report'; statuses: Array<{ id: string; status: HighlightStatus }> }
	/** The investigator clicked a highlight; the panel, if open, shows it. */
	| { type: 'content.clicked'; id: string };

export const CONTENT_REQUEST_TYPES: readonly ContentRequest['type'][] = ['content.ready', 'content.report', 'content.clicked'];

/** Worker to content script. */
export type ContentCommand =
	| { type: 'content.describeSelection' }
	| { type: 'content.add'; highlight: ContentHighlight }
	| { type: 'content.remove'; id: string }
	| { type: 'content.findAgain'; id: string }
	| { type: 'content.scrollTo'; id: string }
	| { type: 'content.refresh' };

export type DescribeReply =
	| { ok: true; selectors: HighlightSelectors; exact: string }
	| { ok: false; reason: 'no-selection' | 'empty' | 'too-long' | 'not-in-page' };

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
