// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Service-worker entry point.
 *
 * Every listener is registered synchronously at top level: Chrome starts the worker to
 * deliver an event and only dispatches it to listeners that exist by the end of the first
 * turn, so a listener added after an await would miss the event that woke us.
 */
import { CAPTURE_PERMISSIONS, CHANGED } from '../shared/messages';
import { capturePage, chromeCaptureApi } from './capture';
import { Channel, webDeps } from './channel';
import { COMMAND_CAPTURE, MENU_CAPTURE_PAGE, captureFromGesture, createMenus, onMenuClicked, type CaptureGestureDeps } from './menus';
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
	else onMenuClicked(info, tab);
});
chrome.commands.onCommand.addListener((command, tab) => {
	if (command === COMMAND_CAPTURE) void captureFromGesture(tab, gesture);
});
chrome.runtime.onMessage.addListener(createRouter({
	runtimeId: chrome.runtime.id,
	extensionOrigin: chrome.runtime.getURL(''),
	handle: request => service.handle(request),
}));

// Whatever was left queued when the worker last stopped goes now, if the app is there.
void service.refresh(false).catch(() => {});
