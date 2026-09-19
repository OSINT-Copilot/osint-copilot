// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The context menus ("Send to OSINT Copilot as entity" on a selection, "Capture this page
 * to OSINT Copilot" on a page) and the capture keyboard command.
 *
 * The click is a user gesture, which is what lets chrome.sidePanel.open() run without
 * the panel having been open, and what grants activeTab for the tab. The selection itself
 * goes to storage.session (trusted contexts only, cleared when the browser closes), where
 * the panel picks it up to prefill the entity form. Nothing is sent until the user
 * presses Send there.
 */
import { PENDING_SELECTION, type PendingSelection } from '../shared/messages';

export const MENU_SEND_ENTITY = 'oc-send-entity';
export const MENU_CAPTURE_PAGE = 'oc-capture-page';
export const MENU_HIGHLIGHT = 'oc-highlight';
/** The manifest's commands key for capture. */
export const COMMAND_CAPTURE = 'capture-page';

export function createMenus(): void {
	// removeAll first: onInstalled also fires on update, and create() refuses a duplicate id.
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: MENU_HIGHLIGHT,
			title: 'Highlight in OSINT Copilot',
			contexts: ['selection'],
		});
		chrome.contextMenus.create({
			id: MENU_SEND_ENTITY,
			title: 'Send to OSINT Copilot as entity',
			contexts: ['selection'],
		});
		chrome.contextMenus.create({
			id: MENU_CAPTURE_PAGE,
			title: 'Capture this page to OSINT Copilot',
			contexts: ['page'],
		});
	});
}

export interface CaptureGestureDeps {
	/** chrome.permissions.request(CAPTURE_PERMISSIONS); Chrome shows its prompt only if not yet granted. */
	requestPermissions(): Promise<boolean>;
	openPanel(tabId: number): void;
	/** Captures the tab; undefined means "find the active tab now". */
	capture(tabId: number | undefined): Promise<unknown>;
	/** The user said no to the permissions: tell them, capture nothing. */
	refused(): void;
}

/**
 * A capture the user asked for with the menu item or the keyboard command.
 *
 * Both calls into Chrome happen synchronously, before the first await: Chrome counts the
 * click or key press as a user gesture only during this turn, and permissions.request and
 * sidePanel.open are refused without one. Nothing else in the extension asks for the
 * permissions; a capture requested any other way without them simply fails.
 */
export function captureFromGesture(tab: chrome.tabs.Tab | undefined, deps: CaptureGestureDeps): Promise<void> {
	const tabId = tab?.id !== undefined && tab.id >= 0 ? tab.id : undefined;
	if (tabId !== undefined) deps.openPanel(tabId);
	const asked = deps.requestPermissions();
	return (async () => {
		let granted = false;
		try {
			granted = await asked;
		} catch {
			granted = false;
		}
		if (!granted) {
			deps.refused();
			return;
		}
		await deps.capture(tabId);
	})();
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
