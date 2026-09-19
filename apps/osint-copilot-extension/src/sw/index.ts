// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Service-worker entry point.
 *
 * Every listener is registered synchronously at top level: Chrome starts the worker to
 * deliver an event and only dispatches it to listeners that exist by the end of the first
 * turn, so a listener added after an await would miss the event that woke us.
 */
import { CAPTURE_PERMISSIONS, CHANGED, HIGHLIGHT_CLICKED, HIGHLIGHT_PERMISSIONS } from '../shared/messages';
import type { ContentCommand } from '../shared/highlights';
import { capturePage, chromeCaptureApi } from './capture';
import { Channel, webDeps } from './channel';
import { HighlightStore, Highlights, type HighlightTabs } from './highlights';
import {
	COMMAND_CAPTURE, MENU_CAPTURE_PAGE, MENU_HIGHLIGHT, captureFromGesture, createMenus, onMenuClicked, type CaptureGestureDeps,
} from './menus';
import { createRouter } from './messages';
import { Queue, sendBundle } from './queue';
import { Service } from './service';
import { chromeLocal, restrictToTrustedContexts } from './storage';

restrictToTrustedContexts();

const storage = chromeLocal();
const channel = new Channel(webDeps(storage));

function broadcastChanged(): void {
	// Only extension pages receive runtime.sendMessage; with no panel open there is nobody.
	chrome.runtime.sendMessage({ type: CHANGED }).catch(() => {});
}

const queue = new Queue({
	indexedDB: self.indexedDB,
	now: () => Date.now(),
	send: (manifest, ctx) => sendBundle(channel, manifest, ctx),
	schedule: (delayMs, run) => {
		setTimeout(run, delayMs);
	},
	onChange: broadcastChanged,
});

const captureApi = chromeCaptureApi();

/** The content script, where it may run: the top frame, for highlights. */
const CONTENT_SCRIPT_ID = 'oc-content';

const highlightTabs: HighlightTabs = {
	async page(tabId) {
		try {
			const tab = await chrome.tabs.get(tabId);
			// Without activeTab or host access for the tab, Chrome leaves url undefined.
			return tab.url ? { url: tab.url, title: tab.title ?? '' } : null;
		} catch {
			return null;
		}
	},
	async inject(tabId) {
		try {
			// Safe to repeat: the script paints nothing twice (a flag in its own world).
			await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
			return true;
		} catch {
			return false;
		}
	},
	send: <T>(tabId: number, command: ContentCommand) => chrome.tabs.sendMessage(tabId, command, { frameId: 0 }) as Promise<T>,
	async insertCss(tabId, css) {
		// USER origin: the page's own !important rules cannot restyle or hide our marks.
		await chrome.scripting.insertCSS({ target: { tabId, frameIds: [0] }, css, origin: 'USER' });
	},
};

const highlights = new Highlights({
	store: new HighlightStore(self.indexedDB),
	queue,
	storage,
	paired: async () => Boolean(await channel.pairing()),
	tabs: highlightTabs,
	now: () => Date.now(),
	onChange: broadcastChanged,
	onClicked: (tabId, id) => {
		chrome.runtime.sendMessage({ type: HIGHLIGHT_CLICKED, tabId, id }).catch(() => {});
	},
});

/**
 * With permission to read pages, the content script runs on every page as it loads, so
 * highlights come back on a revisit. Without it, it runs only where the user invoked the
 * extension (activeTab). Registered here, not in the manifest, because the permission is
 * optional and may come and go.
 */
async function syncContentScript(): Promise<void> {
	const granted = await chrome.permissions.contains(HIGHLIGHT_PERMISSIONS);
	const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
	if (granted && existing.length === 0) {
		await chrome.scripting.registerContentScripts([{
			id: CONTENT_SCRIPT_ID,
			matches: ['http://*/*', 'https://*/*'],
			js: ['content.js'],
			runAt: 'document_idle',
			allFrames: false,
			persistAcrossSessions: true,
		}]);
	} else if (!granted && existing.length > 0) {
		await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
	}
}

const service = new Service({
	channel,
	queue,
	storage,
	extVersion: chrome.runtime.getManifest().version,
	now: () => Date.now(),
	onChange: broadcastChanged,
	capture: tabId => capturePage(captureApi, tabId),
	hasCapturePermission: () => chrome.permissions.contains(CAPTURE_PERMISSIONS),
	activeTabId: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id,
	highlights,
});

const gesture: CaptureGestureDeps = {
	requestPermissions: () => chrome.permissions.request(CAPTURE_PERMISSIONS),
	openPanel: tabId => {
		// The panel shows the capture's progress; it may already be open.
		chrome.sidePanel.open({ tabId }).catch(() => {});
	},
	capture: tabId => service.capture(tabId),
	refused: () => service.captureRefused(),
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => createMenus());
// Registered so Chrome wakes the worker at browser start, and the queue drains then.
chrome.runtime.onStartup.addListener(() => {});
chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (info.menuItemId === MENU_CAPTURE_PAGE) void captureFromGesture(tab, gesture);
	else if (info.menuItemId === MENU_HIGHLIGHT) {
		// The click granted activeTab for this tab, which is what lets us read the selection.
		if (tab?.id !== undefined && tab.id >= 0) {
			const tabId = tab.id;
			chrome.sidePanel.open({ tabId }).catch(() => {});
			void highlights.create(tabId).then((result) => {
				if (!result.ok) chrome.runtime.sendMessage({ type: CHANGED, error: result.error }).catch(() => {});
			});
		}
	} else onMenuClicked(info, tab);
});
chrome.permissions.onAdded.addListener(() => void syncContentScript().catch(() => {}));
chrome.permissions.onRemoved.addListener(() => void syncContentScript().catch(() => {}));
// A tab opened before the permission was granted gets the script when it is next looked at.
chrome.tabs.onActivated.addListener(({ tabId }) => {
	void chrome.permissions.contains(HIGHLIGHT_PERMISSIONS).then((granted) => {
		if (granted) void highlightTabs.inject(tabId);
	});
});
chrome.tabs.onRemoved.addListener((tabId) => highlights.tabClosed(tabId));
chrome.commands.onCommand.addListener((command, tab) => {
	if (command === COMMAND_CAPTURE) void captureFromGesture(tab, gesture);
});
chrome.runtime.onMessage.addListener(createRouter({
	runtimeId: chrome.runtime.id,
	extensionOrigin: chrome.runtime.getURL(''),
	handle: request => service.handle(request),
	content: async (request, from) => {
		switch (request.type) {
			case 'content.ready':
				return highlights.contentReady(from.tabId, from.url, request.names);
			case 'content.report':
				highlights.contentReport(from.tabId, Array.isArray(request.statuses) ? request.statuses : []);
				return { ok: true };
			case 'content.clicked':
				highlights.contentClicked(from.tabId, request.id);
				return { ok: true };
		}
	},
}));

void syncContentScript().catch(() => {});

// Whatever was left queued when the worker last stopped goes now, if the app is there.
void service.refresh(false).catch(() => {});
