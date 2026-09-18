// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Which page the next item attaches to, and the text selected on it.
 *
 * The extension has no "tabs" permission and no standing access to sites, so it sees a
 * tab's URL and title, and can read its selection, only after the user grants activeTab
 * for that tab: by clicking the toolbar button or the context-menu item there. Before
 * that, the panel says how to grant it instead of guessing which page is meant.
 */
import type { PendingSelection } from '../shared/messages';
import { normalisePageUrl } from '../shared/url';

export interface PageInfo {
	tabId: number | null;
	/** http(s), credentials removed; null when unknown or not attachable. */
	url: string | null;
	title: string;
	/** Why no page can be attached, in plain language. */
	problem: string | null;
}

export const GRANT_HINT = 'To attach items to this tab, click the OSINT Copilot toolbar button while on it, or select text and right-click "Send to OSINT Copilot as entity". The extension can only see a page after you do.';

export async function currentPage(pending: PendingSelection | null): Promise<PageInfo> {
	let tab: chrome.tabs.Tab | undefined;
	try {
		[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	} catch {
		tab = undefined;
	}
	if (!tab || tab.id === undefined) return { tabId: null, url: null, title: '', problem: 'No active tab in this window.' };

	let raw = tab.url ?? tab.pendingUrl;
	let title = tab.title ?? '';
	// The context-menu click recorded the page even if this query cannot see it. The
	// caller passes it only while that tab has not changed since the click.
	if (!raw && pending && pending.tabId === tab.id) {
		raw = pending.url;
		title = pending.title;
	}
	if (!raw) return { tabId: tab.id, url: null, title: '', problem: GRANT_HINT };
	const url = normalisePageUrl(raw);
	if (!url) {
		return { tabId: tab.id, url: null, title, problem: 'Items can only be attached to web pages (http or https). This tab is not one.' };
	}
	return { tabId: tab.id, url, title, problem: null };
}

/** The selection in the tab's top frame, or why it could not be read. */
export async function selectedText(tabId: number): Promise<{ text: string } | { error: string }> {
	try {
		const [result] = await chrome.scripting.executeScript({
			target: { tabId },
			// Runs in the page's isolated world. What comes back is page-controlled text,
			// treated as data only: it fills an input, and nothing is sent until the user does.
			func: () => String(globalThis.getSelection?.() ?? ''),
		});
		const text = typeof result?.result === 'string' ? result.result : '';
		return text.trim() ? { text } : { error: 'Nothing is selected on the page.' };
	} catch {
		return { error: GRANT_HINT };
	}
}
