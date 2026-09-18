// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The selection context menu: "Send to OSINT Copilot as entity".
 *
 * The click is a user gesture, which is what lets chrome.sidePanel.open() run without
 * the panel having been open, and what grants activeTab for the tab. The selection itself
 * goes to storage.session (trusted contexts only, cleared when the browser closes), where
 * the panel picks it up to prefill the entity form. Nothing is sent until the user
 * presses Send there.
 */
import { PENDING_SELECTION, type PendingSelection } from '../shared/messages';

export const MENU_SEND_ENTITY = 'oc-send-entity';

export function createMenus(): void {
	// removeAll first: onInstalled also fires on update, and create() refuses a duplicate id.
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: MENU_SEND_ENTITY,
			title: 'Send to OSINT Copilot as entity',
			contexts: ['selection'],
		});
	});
}

export function onMenuClicked(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): void {
	if (info.menuItemId !== MENU_SEND_ENTITY) return;
	// open() must be called before any await, while Chrome still counts the gesture.
	if (tab?.id !== undefined && tab.id >= 0) {
		chrome.sidePanel.open({ tabId: tab.id }).catch(() => {
			// The panel may already be open; the storage change below still reaches it.
		});
	}
	const pending: PendingSelection = {
		text: info.selectionText ?? '',
		url: info.pageUrl ?? tab?.url ?? '',
		title: tab?.title ?? '',
		tabId: tab?.id ?? null,
		at: Date.now(),
	};
	void chrome.storage.session.set({ [PENDING_SELECTION]: pending });
}
