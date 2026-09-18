// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Service-worker entry point.
 *
 * Every listener is registered synchronously at top level: Chrome starts the worker to
 * deliver an event and only dispatches it to listeners that exist by the end of the first
 * turn, so a listener added after an await would miss the event that woke us.
 */
import { CHANGED } from '../shared/messages';
import { Channel, webDeps } from './channel';
import { createMenus, onMenuClicked } from './menus';
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
	send: manifest => sendBundle(channel, manifest),
	schedule: (delayMs, run) => {
		setTimeout(run, delayMs);
	},
	onChange: broadcastChanged,
});

const service = new Service({
	channel,
	queue,
	storage,
	extVersion: chrome.runtime.getManifest().version,
	now: () => Date.now(),
	onChange: broadcastChanged,
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => createMenus());
// Registered so Chrome wakes the worker at browser start, and the queue drains then.
chrome.runtime.onStartup.addListener(() => {});
chrome.contextMenus.onClicked.addListener(onMenuClicked);
chrome.runtime.onMessage.addListener(createRouter({
	runtimeId: chrome.runtime.id,
	extensionOrigin: chrome.runtime.getURL(''),
	handle: request => service.handle(request),
}));

// Whatever was left queued when the worker last stopped goes now, if the app is there.
void service.refresh(false).catch(() => {});
