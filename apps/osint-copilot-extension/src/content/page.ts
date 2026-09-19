// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * One page's highlights, as the content script keeps them: which belong here, where each
 * was found, and what the side panel is told about them. index.ts wires it to the page's
 * events and to Chrome; the rest is here so tests can drive it.
 *
 * Finding again. A page keeps changing after it loads (late content, a framework
 * re-rendering), so on every batch of changes the highlights whose marks were lost are
 * looked for again; the others are left alone. Highlights not found at all are looked for
 * again only for a minute after the page loads, only when its text has changed since the
 * last look, and less often each time: each look is a pass over the whole text, and on a
 * page that never stops changing it would never stop. A highlight not found is reported
 * as such, and never deleted for it.
 */
import { anchor } from './anchor';
import { describeRange } from './describe';
import type { PaintEntry, Painter } from './render';
import { buildTextModel, rangeFromOffsets, type TextModel } from './text-model';
import type {
	ContentCommand, ContentHighlight, ContentRequest, DescribeReply, HighlightStatus,
} from '../shared/highlights';

/** How long after a load highlights not found are looked for again. */
export const RETRY_MS = 60_000;
/** How long page changes are gathered before they are looked at. */
export const DEBOUNCE_MS = 250;
/** The longest wait between looks while highlights stay not found. */
export const MAX_DELAY_MS = 4_000;

export interface PageDeps {
	document: Document;
	painter: Painter | null;
	send(message: ContentRequest): Promise<unknown>;
	now(): number;
	/** Runs `run` once, `ms` from now. */
	later(run: () => void, ms: number): void;
}

interface Tracked {
	highlight: ContentHighlight;
	status: HighlightStatus;
	/** Where it is painted, when found. */
	range: Range | null;
	/** What that range read when it was placed; reading otherwise now, it has lost its text. */
	text: string;
}

export function pageKey(href: string): string {
	const url = new URL(href);
	url.hash = '';
	return url.href;
}

/** Invisible in any case: soft hyphens and zero-width characters, which a copy may drop. */
const INVISIBLE = /[\s­​-‍⁠﻿]+/g;

function fold(text: string): string {
	// Upper then lower: "ß" and "SS" (text-transform) meet as "ss", and "İ" lowers to an "i".
	return text.replace(INVISIBLE, '').toUpperCase().toLowerCase();
}

/**
 * Whether the quote holds text the selection did not show. The quote is taken from the
 * DOM (text model v1), which includes text the page hides with CSS; the browser's own
 * reading of the selection leaves hidden text out. Every character of the quote must
 * appear, in order, in what was shown. The shown text may hold more (a list marker,
 * generated content), and neither case nor spacing counts.
 */
export function hidesText(exact: string, shown: string): boolean {
	const a = fold(exact);
	const b = fold(shown);
	if (a === b) return false;
	let j = 0;
	for (let i = 0; i < a.length; i++) {
		j = b.indexOf(a[i], j);
		if (j < 0) return true;
		j++;
	}
	return false;
}

export class PageHighlights {
	private readonly tracked = new Map<string, Tracked>();
	/** The page (URL without fragment) these highlights were loaded for. */
	private key: string;
	private retryUntil: number;
	private delay = DEBOUNCE_MS;
	private pending = false;
	/** Each load's number; only the latest may fill in the page. */
	private loads = 0;
	/** The page text last searched for highlights not found; not searched again until it changes. */
	private searched: string | null = null;

	constructor(private readonly deps: PageDeps) {
		this.key = pageKey(deps.document.location.href);
		this.retryUntil = deps.now() + RETRY_MS;
	}

	private get body(): HTMLElement {
		return this.deps.document.body;
	}

	private restartWindow(): void {
		this.retryUntil = this.deps.now() + RETRY_MS;
		this.delay = DEBOUNCE_MS;
		this.searched = null;
	}

	/** Finds these highlights in the page as it is now and paints them in one go; true if a status changed. */
	private place(list: Tracked[], model: TextModel): boolean {
		const paint: PaintEntry[] = [];
		const unpaint: string[] = [];
		let changed = false;
		for (const t of list) {
			const found = anchor(model, t.highlight.selectors);
			const range = found ? rangeFromOffsets(model, found.start, found.end) : null;
			const status: HighlightStatus = !found || !range ? 'orphan' : found.fuzzy ? 'fuzzy' : 'exact';
			if (found && range) {
				paint.push({ id: t.highlight.id, range, fuzzy: found.fuzzy });
				t.text = range.toString();
			} else {
				unpaint.push(t.highlight.id);
				t.text = '';
			}
			t.range = range;
			if (status !== t.status) changed = true;
			t.status = status;
		}
		this.deps.painter?.update(paint, unpaint);
		this.searched = model.text;
		return changed;
	}

	/**
	 * A mark whose text went: emptied, or cut loose when the page replaced a node it began
	 * or ended in (the range then falls back to an element and can stretch over new text),
	 * or reading otherwise than it did.
	 */
	private isLost(t: Tracked): boolean {
		const r = t.range;
		if (!r) return true;
		return r.collapsed
			|| r.startContainer.nodeType !== Node.TEXT_NODE || r.endContainer.nodeType !== Node.TEXT_NODE
			|| !r.startContainer.isConnected || !r.endContainer.isConnected
			|| r.toString() !== t.text;
	}

	private report(): void {
		const statuses = [...this.tracked.values()].map((t) => ({ id: t.highlight.id, status: t.status }));
		void this.deps.send({ type: 'content.report', statuses }).catch(() => {});
	}

	/** Asks the worker for this page's highlights, and paints them. On load and after a navigation. */
	async load(): Promise<void> {
		const load = ++this.loads;
		const key = this.key;
		let reply: { highlights?: ContentHighlight[] } | undefined;
		try {
			reply = await this.deps.send({ type: 'content.ready', names: this.deps.painter?.names ?? null }) as typeof reply;
		} catch {
			return; // The worker restarted or the extension was reloaded: nothing to show.
		}
		// A later load, or a navigation while this one waited: the answer is for another page.
		if (load !== this.loads || key !== this.key) return;
		this.tracked.clear();
		this.deps.painter?.clear();
		for (const h of reply?.highlights ?? []) this.tracked.set(h.id, { highlight: h, status: 'orphan', range: null, text: '' });
		if (this.tracked.size > 0) this.place([...this.tracked.values()], buildTextModel(this.body));
		this.report();
	}

	/** Something in the page changed, or its URL did: looked at once the changes settle. */
	changed(): void {
		if (this.pending) return;
		this.pending = true;
		this.deps.later(() => {
			this.pending = false;
			this.check();
		}, this.delay);
	}

	/** The page became visible again: our marks may have been cleared meanwhile. */
	visible(): void {
		this.deps.painter?.ensureRegistered();
	}

	check(): void {
		const nowKey = pageKey(this.deps.document.location.href);
		if (nowKey !== this.key) {
			// An in-page navigation (a single-page app): another page's highlights.
			this.key = nowKey;
			this.restartWindow();
			void this.load();
			return;
		}
		const all = [...this.tracked.values()];
		const inWindow = this.deps.now() < this.retryUntil;
		const lost = all.filter((t) => t.status !== 'orphan' && this.isLost(t));
		const orphans = inWindow ? all.filter((t) => t.status === 'orphan') : [];
		if (lost.length > 0 || orphans.length > 0) {
			const model = buildTextModel(this.body);
			// The text the orphans were last searched in, unchanged: they are not there either.
			const search = model.text !== this.searched ? [...lost, ...orphans] : lost;
			if (search.length > 0 && this.place(search, model)) this.report();
			// Back off while highlights stay not found: each look is a pass over the page.
			const stillOrphans = inWindow && all.some((t) => t.status === 'orphan');
			this.delay = stillOrphans ? Math.min(this.delay * 2, MAX_DELAY_MS) : DEBOUNCE_MS;
		}
		this.deps.painter?.ensureRegistered();
	}

	/** The highlight at a DOM point, for a click. */
	idAt(node: Node, offset: number): string | null {
		return this.deps.painter?.idAt(node, offset) ?? null;
	}

	describeSelection(): DescribeReply {
		const selection = this.deps.document.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return { ok: false, reason: 'no-selection' };
		const range = selection.getRangeAt(0);
		if (!this.body.contains(range.commonAncestorContainer)) return { ok: false, reason: 'not-in-page' };
		const d = describeRange(buildTextModel(this.body), range);
		if (!d.ok) return { ok: false, reason: d.reason };
		// The quote must be what the investigator saw: refused if the page hid text inside it.
		if (hidesText(d.exact, selection.toString())) return { ok: false, reason: 'hidden-text' };
		return { ok: true, selectors: d.selectors, exact: d.exact };
	}

	private scrollTo(id: string): void {
		const el = this.tracked.get(id)?.range?.startContainer.parentElement;
		el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	/** A command from the worker; returns the reply. */
	handle(message: ContentCommand): unknown {
		switch (message.type) {
			case 'content.describeSelection':
				return this.describeSelection();
			case 'content.add': {
				const t: Tracked = { highlight: message.highlight, status: 'orphan', range: null, text: '' };
				this.tracked.set(message.highlight.id, t);
				this.place([t], buildTextModel(this.body));
				this.report();
				return { status: t.status };
			}
			case 'content.remove':
				this.tracked.delete(message.id);
				this.deps.painter?.remove(message.id);
				return { ok: true };
			case 'content.findAgain': {
				const t = this.tracked.get(message.id);
				if (!t) return { status: 'orphan' };
				this.place([t], buildTextModel(this.body));
				this.report();
				if (t.status !== 'orphan') this.scrollTo(message.id);
				return { status: t.status };
			}
			case 'content.scrollTo':
				this.scrollTo(message.id);
				return { ok: true };
			case 'content.refresh':
				this.restartWindow();
				void this.load();
				return { ok: true };
			default:
				return undefined;
		}
	}
}
