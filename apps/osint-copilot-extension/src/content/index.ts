// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The content script: finds this page's highlights and paints them, and describes the
 * selection when the investigator makes a new one. Top frame only.
 *
 * It runs in an isolated world: page scripts share the DOM with it but not its variables,
 * and cannot call chrome.runtime. It never touches the network and never learns the key,
 * the port, the investigations or the queue; the service worker tells it only which
 * highlights belong to this page (see shared/highlights.ts).
 *
 * This file wires page.ts to the page's events and to Chrome.
 */
import { PageHighlights } from './page';
import { Painter, windowHighlightApi } from './render';
import type { ContentCommand, ContentRequest } from '../shared/highlights';

/** A flag only this isolated world can see: injecting twice must not paint twice. */
const FLAG = '__osintCopilotContent';

function start(): void {
	const api = windowHighlightApi(window as Window & typeof globalThis);
	const page = new PageHighlights({
		document,
		painter: api ? new Painter(api) : null,
		send: (message: ContentRequest) => chrome.runtime.sendMessage(message),
		now: () => Date.now(),
		later: (run, ms) => {
			setTimeout(run, ms);
		},
	});
	const changed = () => page.changed();

	new MutationObserver(changed).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
	document.addEventListener('visibilitychange', () => page.visible());
	// The Navigation API reports in-page navigations without the webNavigation permission:
	// currententrychange for history.pushState and replaceState too, which fire no navigate.
	const nav = (window as unknown as { navigation?: EventTarget }).navigation;
	nav?.addEventListener('currententrychange', changed);
	nav?.addEventListener('navigatesuccess', changed);
	window.addEventListener('popstate', changed);

	// A click on a highlight tells the panel which one. Only a real click: a page can
	// dispatch synthetic events, and they must not move the panel around.
	window.addEventListener('click', (ev) => {
		if (!ev.isTrusted) return;
		const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
		const pos = doc.caretPositionFromPoint?.(ev.clientX, ev.clientY);
		const id = pos ? page.idAt(pos.offsetNode, pos.offset) : null;
		if (id) void chrome.runtime.sendMessage({ type: 'content.clicked', id } satisfies ContentRequest).catch(() => {});
	}, true);

	chrome.runtime.onMessage.addListener((message: ContentCommand, sender, sendResponse) => {
		// Content scripts hear only their own extension, but check anyway.
		if (sender.id !== chrome.runtime.id || typeof message !== 'object' || message === null) return false;
		const reply = page.handle(message);
		if (reply !== undefined) sendResponse(reply);
		return false;
	});

	void page.load();
}

const scope = globalThis as unknown as Record<string, unknown>;
if (!scope[FLAG] && document.body) {
	scope[FLAG] = true;
	start();
}
