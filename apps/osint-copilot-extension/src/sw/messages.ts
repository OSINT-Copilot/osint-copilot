// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The runtime.onMessage router.
 *
 * runtime.onMessage hears our own extension's pages and our own content scripts. The
 * two are not equally trusted: a content script shares its page with hostile code that
 * can drive it, so a message from one proves nothing about what the user wanted. Every
 * action here (pairing, choosing an investigation, sending, the queue) is therefore
 * accepted only from our own extension pages, identified by sender.url on this
 * extension's origin. A content script in a tab's top frame may send only the content.*
 * highlight requests, about its own page; anything else gets a refusal, and it learns
 * nothing: not the port, the key, the investigations or the queue. Messages from any
 * other extension are ignored; this extension declares neither externally_connectable
 * nor onMessageExternal.
 */
import { PANEL_REQUEST_TYPES, type PanelRequest, type Reply } from '../shared/messages';
import { CONTENT_REQUEST_TYPES, type ContentRequest } from '../shared/highlights';

export type Handler = (request: PanelRequest) => Promise<Reply>;

/**
 * Our own content script, in a tab's top frame. Chrome fills sender.tab and frameId; a
 * page cannot. The tab and URL a content handler acts on come from here, never from the
 * message: page code can steer what the content script says, not who Chrome says it is.
 */
export interface ContentSender {
	tabId: number;
	/** The sending document's URL, as Chrome reports it. */
	url: string;
}

export type ContentHandler = (request: ContentRequest, sender: ContentSender) => Promise<unknown>;

export interface RouterOptions {
	/** chrome.runtime.id */
	runtimeId: string;
	/** chrome.runtime.getURL(''), i.e. "chrome-extension://<id>/". */
	extensionOrigin: string;
	handle: Handler;
	/** Highlight messages from content scripts; without it they are refused like any other. */
	content?: ContentHandler;
}

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (reply: unknown) => void) => boolean;

/** Our own extension pages: the side panel, and nothing a web page can host or script. */
function isExtensionPage(sender: chrome.runtime.MessageSender, runtimeId: string, extensionOrigin: string): boolean {
	if (sender.id !== runtimeId) return false;
	if (typeof sender.url !== 'string' || !sender.url.startsWith(extensionOrigin)) return false;
	// Where Chrome reports the origin too, it must agree; an opaque or foreign one is not ours.
	if (sender.origin !== undefined && `${sender.origin}/` !== extensionOrigin) return false;
	return true;
}

function isContentRequest(message: unknown): message is ContentRequest {
	return typeof message === 'object' && message !== null
		&& (CONTENT_REQUEST_TYPES as readonly unknown[]).includes((message as { type?: unknown }).type);
}

/** A content script of ours in a tab's top frame, or null. */
function contentSender(sender: chrome.runtime.MessageSender, runtimeId: string, extensionOrigin: string): ContentSender | null {
	if (sender.id !== runtimeId || isExtensionPage(sender, runtimeId, extensionOrigin)) return null;
	const tabId = sender.tab?.id;
	if (typeof tabId !== 'number' || tabId < 0 || sender.frameId !== 0) return null;
	const url = sender.url ?? sender.tab?.url;
	return typeof url === 'string' ? { tabId, url } : null;
}

function isPanelRequest(message: unknown): message is PanelRequest {
	return typeof message === 'object' && message !== null
		&& (PANEL_REQUEST_TYPES as readonly unknown[]).includes((message as { type?: unknown }).type);
}

export function createRouter(options: RouterOptions): Listener {
	return (message, sender, sendResponse) => {
		if (sender.id !== options.runtimeId) return false;
		if (!isExtensionPage(sender, options.runtimeId, options.extensionOrigin)) {
			// A content script may ask about its own page's highlights, and nothing else.
			const from = contentSender(sender, options.runtimeId, options.extensionOrigin);
			if (from && options.content && isContentRequest(message)) {
				options.content(message, from).then(sendResponse, () => sendResponse({ highlights: [] }));
				return true;
			}
			const reply: Reply = { ok: false, error: 'forbidden', message: 'Not available to page scripts.' };
			sendResponse(reply);
			return false;
		}
		if (!isPanelRequest(message)) {
			// Broadcasts such as CHANGED reach here too when a panel sends one; not ours to answer.
			return false;
		}
		options.handle(message).then(sendResponse, (err: unknown) => {
			const reply: Reply = { ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) };
			sendResponse(reply);
		});
		// Keeps the channel open for the asynchronous reply.
		return true;
	};
}
