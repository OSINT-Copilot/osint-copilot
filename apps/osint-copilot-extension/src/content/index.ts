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
 * Finding happens when the page loads, again on changes to the page for a minute (for
 * content that arrives late: lazy loading, single-page apps), and after an in-page
 * navigation. A highlight not found is reported as such, so the side panel can list it
 * under "Not found on this page"; it is never deleted for not being found.
 */
import { anchor } from './anchor';
import { describeRange } from './describe';
import { Painter, windowHighlightApi } from './render';
import { buildTextModel, rangeFromOffsets, type TextModel } from './text-model';
import type {
	ContentCommand, ContentHighlight, ContentRequest, DescribeReply, HighlightStatus,
} from '../shared/highlights';

/** A flag only this isolated world can see: injecting twice must not paint twice. */
const FLAG = '__osintCopilotContent';

/** How long after a load or a navigation page changes are watched for late content. */
const RETRY_MS = 60_000;
const DEBOUNCE_MS = 250;

interface Tracked {
	highlight: ContentHighlight;
	status: HighlightStatus;
}

function pageKey(href: string): string {
	const url = new URL(href);
	url.hash = '';
	return url.href;
}

function send(message: ContentRequest): Promise<unknown> {
	return chrome.runtime.sendMessage(message);
}

function start(): void {
	const api = windowHighlightApi(window as Window & typeof globalThis);
	const painter = api ? new Painter(api) : null;
	const tracked = new Map<string, Tracked>();
	let key = pageKey(location.href);
	let retryUntil = Date.now() + RETRY_MS;
	let model: TextModel | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const freshModel = (): TextModel => (model ??= buildTextModel(document.body));

	/** Finds one highlight in the current model and paints it; returns its status. */
	function place(h: ContentHighlight): HighlightStatus {
		const m = freshModel();
		const found = anchor(m, h.selectors);
		const range = found ? rangeFromOffsets(m, found.start, found.end) : null;
		if (!found || !range) {
			painter?.remove(h.id);
			return 'orphan';
		}
		painter?.set({ id: h.id, range, fuzzy: found.fuzzy });
		return found.fuzzy ? 'fuzzy' : 'exact';
	}

	function report(): void {
		void send({ type: 'content.report', statuses: [...tracked.values()].map((t) => ({ id: t.highlight.id, status: t.status })) }).catch(() => {});
	}

	/** Places every highlight again; reports only if anything changed. */
	function placeAll(): void {
		model = null;
		let changed = false;
		for (const t of tracked.values()) {
			const status = place(t.highlight);
			if (status !== t.status) changed = true;
			t.status = status;
		}
		if (changed) report();
	}

	/** Asks the worker for this page's highlights (on load and after a navigation). */
	async function load(): Promise<void> {
		let reply: { highlights?: ContentHighlight[] } | undefined;
		try {
			reply = await send({ type: 'content.ready', names: painter?.names ?? null }) as typeof reply;
		} catch {
			return; // The worker restarted or the extension was reloaded: nothing to show.
		}
		tracked.clear();
		painter?.clear();
		model = null;
		for (const h of reply?.highlights ?? []) tracked.set(h.id, { highlight: h, status: place(h) });
		report();
	}

	/** Something in the page changed, or the URL did. */
	function onChange(): void {
		timer = null;
		const nowKey = pageKey(location.href);
		if (nowKey !== key) {
			// An in-page navigation (a single-page app): another page's highlights.
			key = nowKey;
			retryUntil = Date.now() + RETRY_MS;
			void load();
			return;
		}
		model = null;
		const lost = [...tracked.values()].some((t) => {
			if (t.status === 'orphan') return true;
			const painted = painter?.entry(t.highlight.id);
			// A painted range the page's edit emptied or moved text through.
			return !painted || painted.range.collapsed;
		});
		if (lost && Date.now() < retryUntil) placeAll();
		painter?.ensureRegistered();
	}

	const schedule = () => {
		if (!timer) timer = setTimeout(onChange, DEBOUNCE_MS);
	};

	new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
	document.addEventListener('visibilitychange', () => painter?.ensureRegistered());
	// The Navigation API reports in-page navigations without the webNavigation permission.
	const nav = (window as unknown as { navigation?: EventTarget }).navigation;
	nav?.addEventListener('navigatesuccess', schedule);
	window.addEventListener('popstate', schedule);

	// A click on a highlight tells the panel which one. Only a real click: a page can
	// dispatch synthetic events, and they must not move the panel around.
	window.addEventListener('click', (ev) => {
		if (!ev.isTrusted || !painter) return;
		const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
		const pos = doc.caretPositionFromPoint?.(ev.clientX, ev.clientY);
		const id = pos ? painter.idAt(pos.offsetNode, pos.offset) : null;
		if (id) void send({ type: 'content.clicked', id }).catch(() => {});
	}, true);

	chrome.runtime.onMessage.addListener((message: ContentCommand, sender, sendResponse) => {
		// Content scripts hear only their own extension, but check anyway.
		if (sender.id !== chrome.runtime.id || typeof message !== 'object' || message === null) return false;
		switch (message.type) {
			case 'content.describeSelection': {
				const selection = window.getSelection();
				let reply: DescribeReply;
				if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
					reply = { ok: false, reason: 'no-selection' };
				} else {
					const range = selection.getRangeAt(0);
					if (!document.body.contains(range.commonAncestorContainer)) reply = { ok: false, reason: 'not-in-page' };
					else {
						const d = describeRange(buildTextModel(document.body), range);
						reply = d.ok ? { ok: true, selectors: d.selectors, exact: d.exact } : { ok: false, reason: d.reason };
					}
				}
				sendResponse(reply);
				return false;
			}
			case 'content.add': {
				model = null;
				const status = place(message.highlight);
				tracked.set(message.highlight.id, { highlight: message.highlight, status });
				sendResponse({ status });
				report();
				return false;
			}
			case 'content.remove':
				tracked.delete(message.id);
				painter?.remove(message.id);
				sendResponse({ ok: true });
				return false;
			case 'content.findAgain': {
				const t = tracked.get(message.id);
				if (t) {
					model = null;
					t.status = place(t.highlight);
					report();
					if (t.status !== 'orphan') scrollTo(message.id);
				}
				sendResponse({ status: t?.status ?? 'orphan' });
				return false;
			}
			case 'content.scrollTo':
				scrollTo(message.id);
				sendResponse({ ok: true });
				return false;
			case 'content.refresh':
				retryUntil = Date.now() + RETRY_MS;
				void load();
				sendResponse({ ok: true });
				return false;
			default:
				return false;
		}
	});

	function scrollTo(id: string): void {
		const range = painter?.entry(id)?.range;
		const el = range?.startContainer.parentElement;
		el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	void load();
}

const scope = globalThis as unknown as Record<string, unknown>;
if (!scope[FLAG] && document.body) {
	scope[FLAG] = true;
	start();
}
