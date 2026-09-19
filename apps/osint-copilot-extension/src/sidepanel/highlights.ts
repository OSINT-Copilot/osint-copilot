// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The panel's Highlights card: make one from the selection, and for each highlight on
 * this page its quote, where it stands (found, found with changed text, not found), its
 * note, and Delete. Highlights the page no longer has are listed apart, never dropped.
 *
 * Quotes are page text, so they are written with textContent only, like everything else
 * in the panel.
 */
import { describeError } from '../shared/errors';
import { HIGHLIGHT_PERMISSIONS, type PanelRequest, type Reply } from '../shared/messages';
import type { HighlightItem, HighlightList } from '../sw/highlights';

export interface HighlightPanelDeps {
	ask(request: PanelRequest): Promise<Reply>;
	flash(text: string, isError?: boolean): void;
	/** The tab items attach to, or null when the panel cannot see one. */
	tabId(): number | null;
	/** The investigation the picker shows; sent so a change in another window is caught. */
	workspaceId(): string | undefined;
	/** Why no page can be used, when tabId() is null. */
	pageProblem(): string | null;
}

const STATUS_TEXT: Record<HighlightItem['status'], string> = {
	exact: 'On the page.',
	fuzzy: 'On the page, but its text has changed since you highlighted it.',
	orphan: 'Not found on this page.',
	unknown: 'Not checked on this page yet.',
};

function $<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`missing #${id}`);
	return el as T;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
	const el = Object.assign(document.createElement(tag), props);
	el.append(...children);
	return el;
}

export function initHighlights(deps: HighlightPanelDeps) {
	const ui = {
		create: $<HTMLButtonElement>('highlight-create'),
		revisit: $<HTMLParagraphElement>('highlight-revisit'),
		grant: $<HTMLButtonElement>('highlight-grant'),
		list: $<HTMLUListElement>('highlights'),
		orphans: $<HTMLUListElement>('orphans'),
		orphansTitle: $<HTMLHeadingElement>('orphans-title'),
		orphansHint: $<HTMLParagraphElement>('orphans-hint'),
	};
	let shown: HighlightList | null = null;
	let focusedId: string | null = null;

	function editing(): boolean {
		// A redraw would drop what the user is typing into a note.
		const active = document.activeElement;
		return !!active && (ui.list.contains(active) || ui.orphans.contains(active)) && active.tagName === 'TEXTAREA';
	}

	function item(entry: HighlightItem, tabId: number): HTMLLIElement {
		const li = h('li', { className: entry.status });
		li.dataset.id = entry.id;
		if (entry.id === focusedId) li.classList.add('focused');
		const quote = entry.exact.length > 600 ? `${entry.exact.slice(0, 599)}…` : entry.exact;
		li.append(
			h('div', { className: 'quote', textContent: quote }),
			h('p', { className: 'status', textContent: STATUS_TEXT[entry.status] }),
		);
		const note = h('textarea', { rows: 2, maxLength: 20_000, placeholder: 'Note (optional)', value: entry.note });
		const save = h('button', { type: 'button', className: 'secondary', textContent: 'Save note' });
		save.addEventListener('click', () => void act({ type: 'highlight.note', tabId, id: entry.id, note: note.value }));
		const actions = h('div', { className: 'row' }, save);
		if (entry.status === 'orphan') {
			const again = h('button', { type: 'button', className: 'secondary', textContent: 'Find again' });
			again.addEventListener('click', () => void act({ type: 'highlight.findAgain', tabId, id: entry.id }));
			actions.append(again);
		} else if (entry.status !== 'unknown') {
			const show = h('button', { type: 'button', className: 'secondary', textContent: 'Show' });
			show.addEventListener('click', () => void deps.ask({ type: 'highlight.show', tabId, id: entry.id }));
			actions.append(show);
		}
		const del = h('button', { type: 'button', className: 'danger', textContent: 'Delete' });
		del.addEventListener('click', () => {
			if (confirm('Delete this highlight? It is also removed from the investigation.')) {
				void act({ type: 'highlight.delete', tabId, id: entry.id });
			}
		});
		actions.append(del);
		li.append(note, actions);
		return li;
	}

	function render(list: HighlightList | undefined): void {
		if (!list || editing()) return;
		shown = list;
		const found = list.items.filter((i) => i.status !== 'orphan');
		const lost = list.items.filter((i) => i.status === 'orphan');
		ui.list.replaceChildren(...found.map((i) => item(i, list.tabId)));
		ui.orphans.replaceChildren(...lost.map((i) => item(i, list.tabId)));
		ui.orphansTitle.hidden = lost.length === 0;
		ui.orphansHint.hidden = lost.length === 0;
	}

	async function act(request: PanelRequest): Promise<void> {
		const reply = await deps.ask(request);
		if (reply.ok) {
			if (reply.note) deps.flash(reply.note);
			render(reply.highlights);
		} else {
			deps.flash(reply.message, true);
		}
	}

	async function refresh(): Promise<void> {
		const tabId = deps.tabId();
		if (tabId === null) {
			shown = null;
			ui.list.replaceChildren();
			ui.orphans.replaceChildren();
			ui.orphansTitle.hidden = ui.orphansHint.hidden = true;
			return;
		}
		const reply = await deps.ask({ type: 'highlights', tabId });
		if (reply.ok) render(reply.highlights);
	}

	async function refreshPermission(): Promise<void> {
		try {
			ui.revisit.hidden = await chrome.permissions.contains(HIGHLIGHT_PERMISSIONS);
		} catch {
			ui.revisit.hidden = true;
		}
	}

	ui.create.addEventListener('click', () => {
		const tabId = deps.tabId();
		if (tabId === null) {
			deps.flash(deps.pageProblem() ?? describeError('highlight_no_page'), true);
			return;
		}
		void act({ type: 'highlight.create', tabId, workspaceId: deps.workspaceId() });
	});

	ui.grant.addEventListener('click', () => {
		// Asked from this click: Chrome shows its prompt only during a user gesture.
		void chrome.permissions.request(HIGHLIGHT_PERMISSIONS).then((granted) => {
			void refreshPermission();
			if (granted) deps.flash('Highlights will show again when you come back to a page.');
		}).catch(() => {});
	});

	/** A highlight was clicked on the page: bring its entry into view. */
	function focus(tabId: number, id: string): void {
		if (shown?.tabId !== tabId) return;
		focusedId = id;
		for (const li of [...ui.list.children, ...ui.orphans.children] as HTMLLIElement[]) {
			const match = li.dataset.id === id;
			li.classList.toggle('focused', match);
			if (match) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
	}

	void refreshPermission();
	chrome.permissions.onAdded.addListener(() => void refreshPermission());
	chrome.permissions.onRemoved.addListener(() => void refreshPermission());

	return { refresh, focus };
}
