// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The side panel: pairing, the investigation picker, the page items attach to, page
 * capture, a quick note, the entity form and the queue.
 *
 * Plain DOM. Everything that came from a page or from the app is written with
 * textContent, never as HTML, because page text is hostile and the panel runs with the
 * extension's privileges.
 */
import { classify } from '../shared/classify';
import { describeError } from '../shared/errors';
import { CAPTURE_PERMISSIONS, CHANGED, HIGHLIGHT_CLICKED, PENDING_SELECTION, type CaptureStatus, type PanelState, type PendingSelection, type QueueEntry, type Reply } from '../shared/messages';
import type { EntityKind, EntityPayload, WalletChain } from '../shared/protocol';
import { platformFromUrl } from '../shared/url';
import { validateEntity } from '../shared/validate';
import { ask } from './api';
import { initHighlights } from './highlights';
import { currentPage, selectedText, type PageInfo } from './page';

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

const ui = {
	connection: $<HTMLSpanElement>('connection'),
	workspaceCurrent: $<HTMLParagraphElement>('workspace-current'),
	connectionProblem: $<HTMLParagraphElement>('connection-problem'),
	connectionDetail: $<HTMLParagraphElement>('connection-detail'),
	pairing: $<HTMLElement>('pairing'),
	pairForm: $<HTMLFormElement>('pair-form'),
	pairInput: $<HTMLInputElement>('pair-input'),
	paired: $<HTMLDivElement>('paired'),
	workspace: $<HTMLSelectElement>('workspace'),
	workspaceNote: $<HTMLParagraphElement>('workspace-note'),
	page: $<HTMLDivElement>('page'),
	noteForm: $<HTMLFormElement>('note-form'),
	noteText: $<HTMLTextAreaElement>('note-text'),
	entityForm: $<HTMLFormElement>('entity-form'),
	entityValue: $<HTMLInputElement>('entity-value'),
	entityGuess: $<HTMLParagraphElement>('entity-guess'),
	entityKind: $<HTMLSelectElement>('entity-kind'),
	chainRow: $<HTMLDivElement>('chain-row'),
	entityChain: $<HTMLSelectElement>('entity-chain'),
	platformRow: $<HTMLDivElement>('platform-row'),
	entityPlatform: $<HTMLInputElement>('entity-platform'),
	entityContext: $<HTMLTextAreaElement>('entity-context'),
	entityProblem: $<HTMLParagraphElement>('entity-problem'),
	useSelection: $<HTMLButtonElement>('use-selection'),
	capture: $<HTMLButtonElement>('capture'),
	capturePermission: $<HTMLParagraphElement>('capture-permission'),
	captureShortcut: $<HTMLSpanElement>('capture-shortcut'),
	captureStatus: $<HTMLParagraphElement>('capture-status'),
	captureProgress: $<HTMLProgressElement>('capture-progress'),
	queue: $<HTMLUListElement>('queue'),
	refresh: $<HTMLButtonElement>('refresh'),
	unpair: $<HTMLButtonElement>('unpair'),
	flash: $<HTMLParagraphElement>('flash'),
};

let state: PanelState | null = null;
let page: PageInfo = { tabId: null, url: null, title: '', problem: null };
/**
 * The last context-menu click, whose URL stands in when the tab's own URL is hidden.
 * Dropped as soon as that tab changes in any way: with its URL hidden the panel cannot
 * tell a navigation from a title update, and naming the clicked page for a later one
 * would file evidence against the wrong source.
 */
let pending: PendingSelection | null = null;
/** Once the user picks a kind or platform by hand, typing no longer overrides it. */
let kindChosen = false;
let platformEdited = false;

// --- feedback ------------------------------------------------------------------------

let flashTimer: ReturnType<typeof setTimeout> | undefined;

function flash(text: string, isError = false): void {
	ui.flash.textContent = text;
	ui.flash.classList.toggle('error', isError);
	ui.flash.hidden = false;
	clearTimeout(flashTimer);
	flashTimer = setTimeout(() => { ui.flash.hidden = true; }, isError ? 10_000 : 4_000);
}

function apply(reply: Reply): boolean {
	if (reply.state) render(reply.state);
	if (reply.ok) {
		if (reply.note) flash(reply.note);
		return true;
	}
	flash(reply.message, true);
	return false;
}

// --- rendering -----------------------------------------------------------------------

function workspaceName(id: string): string {
	const found = state?.workspaces.find(w => w.id === id);
	return found ? found.name : 'an investigation not in the current list';
}

function render(next: PanelState): void {
	state = next;
	const paired = next.connection !== 'unpaired';
	ui.pairing.hidden = paired;
	ui.paired.hidden = !paired;
	ui.workspaceCurrent.hidden = !paired;

	ui.connection.className = `badge ${next.connection}`;
	// "Not connected" rather than "App not running": the reason (rate limited, an impostor
	// on the port, revoked) is in the problem line below.
	ui.connection.textContent = next.connection === 'connected' ? 'Connected'
		: next.connection === 'offline' ? 'Not connected' : 'Not paired';
	ui.connectionProblem.hidden = next.connection !== 'offline';
	ui.connectionProblem.textContent = next.connection === 'offline'
		? `${next.problem ?? describeError('unreachable')}`
		: '';
	ui.connectionDetail.textContent = next.paired
		? `Paired with app instance ${next.paired.instanceId} on ${new Date(next.paired.pairedAt).toLocaleString()}.`
			+ (next.appVersion ? ` App version ${next.appVersion}.` : '')
		: '';

	// Not while the user is picking: a rebuilt select would reset their choice. The send
	// carries what the select shows, so a stale one is refused rather than misfiled.
	if (document.activeElement !== ui.workspace) renderWorkspaces(next);
	renderCapture(next.capture);
	renderQueue(next.queue);
	highlightCard.renderState(next);
}

function renderCapture(status: CaptureStatus | null): void {
	ui.captureStatus.hidden = !status;
	ui.captureStatus.textContent = status?.message ?? '';
	ui.captureStatus.className = `hint ${status?.phase ?? ''}`;
	const progress = status?.progress;
	ui.captureProgress.hidden = !(status && (status.phase === 'preparing' || status.phase === 'uploading'));
	if (progress && progress.total > 0) {
		ui.captureProgress.max = progress.total;
		ui.captureProgress.value = progress.sent;
	} else {
		// Indeterminate while the archive is made.
		ui.captureProgress.removeAttribute('value');
	}
	ui.capture.disabled = status?.phase === 'preparing';
}

/** Shows the permission explanation until the permissions are granted. */
async function refreshCapturePermission(): Promise<void> {
	let granted = false;
	try {
		granted = await chrome.permissions.contains(CAPTURE_PERMISSIONS);
	} catch {
		granted = false;
	}
	ui.capturePermission.hidden = granted;
}

function mb(bytes: number): string {
	const n = bytes / (1024 * 1024);
	return n < 0.1 ? '<0.1' : n < 10 ? n.toFixed(1) : String(Math.round(n));
}

function renderWorkspaces(next: PanelState): void {
	const select = ui.workspace;
	select.replaceChildren();
	if (!next.selectedWorkspaceId) select.append(h('option', { value: '', textContent: 'Choose an investigation…' }));
	for (const w of next.workspaces) {
		// A dot marks investigations open in a window, where items appear at once.
		select.append(h('option', { value: w.id, textContent: w.open ? `● ${w.name}` : w.name }));
	}
	if (next.selectedWorkspaceId && !next.workspaces.some(w => w.id === next.selectedWorkspaceId)) {
		select.append(h('option', { value: next.selectedWorkspaceId, textContent: '(not in the current list)' }));
	}
	select.value = next.selectedWorkspaceId ?? '';
	ui.workspaceCurrent.textContent = next.selectedWorkspaceId ? `To: ${workspaceName(next.selectedWorkspaceId)}` : 'No investigation chosen';

	let note = '';
	if (!next.workspaces.length) {
		note = next.workspacesLive ? 'No investigations yet. Create or open one in OSINT Copilot.' : 'The investigation list appears once the app is reachable.';
	} else if (!next.workspacesLive) {
		const when = next.workspacesFetchedAt ? new Date(next.workspacesFetchedAt).toLocaleString() : 'earlier';
		note = `Offline: the list as of ${when}. Items will be sent later.`;
	} else {
		note = '● open in a window: items appear there at once. Others get them when next opened.';
	}
	ui.workspaceNote.textContent = note;
}

function describeWhen(ms: number): string {
	const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
	if (s < 60) return s <= 1 ? 'now' : `in ${s} s`;
	return `in ${Math.round(s / 60)} min`;
}

function renderQueue(items: QueueEntry[]): void {
	ui.queue.replaceChildren();
	if (!items.length) {
		ui.queue.append(h('li', { className: 'hint', textContent: 'Nothing waiting. Items leave the queue once the app has them.' }));
		return;
	}
	for (const item of items) {
		const meta = item.state === 'sending'
			? item.progress ? `Uploading ${mb(item.progress.sent)} of ${mb(item.progress.total)} MB…` : 'Sending…'
			: item.state === 'failed' ? `Not sent: ${item.problem ?? 'refused'}`
			: `Waiting, next try ${describeWhen(item.nextAttemptAt)}${item.attempts ? ` (attempt ${item.attempts + 1})` : ''}${item.problem ? `. ${item.problem}` : ''}`;
		const size = item.kind === 'capture' ? ` (${mb(item.size)} MB)` : '';
		const li = h('li', { className: item.state },
			h('div', { className: 'label', textContent: `${item.label}${size}` }),
			h('div', { className: 'meta', textContent: `To ${workspaceName(item.workspaceId)}. ${meta}` }));
		if (item.notes.length) li.append(h('ul', { className: 'notes' }, ...item.notes.map(n => h('li', { textContent: n }))));
		const actions = h('div', { className: 'actions' });
		if (item.state === 'failed') {
			const others = (state?.workspaces ?? []).filter(w => w.id !== item.workspaceId);
			if (others.length) {
				const target = h('select', { ariaLabel: 'Another investigation' });
				for (const w of others) target.append(h('option', { value: w.id, textContent: w.name }));
				const move = h('button', { type: 'button', className: 'secondary', textContent: 'Retry to this investigation' });
				move.addEventListener('click', () => void act({ type: 'queue.retry', bundleId: item.bundleId, workspaceId: target.value }));
				actions.append(target, move);
			}
		}
		if (item.state !== 'sending') {
			const retry = h('button', { type: 'button', className: 'secondary', textContent: item.state === 'failed' ? 'Retry' : 'Send now' });
			retry.addEventListener('click', () => void act({ type: 'queue.retry', bundleId: item.bundleId }));
			const del = h('button', { type: 'button', className: 'danger', textContent: 'Delete' });
			del.addEventListener('click', () => {
				if (confirm('Delete this item? It has not reached OSINT Copilot and cannot be recovered.')) {
					void act({ type: 'queue.delete', bundleId: item.bundleId });
				}
			});
			actions.append(retry, del);
		}
		if (actions.childElementCount) li.append(actions);
		ui.queue.append(li);
	}
}

async function act(request: Parameters<typeof ask>[0]): Promise<boolean> {
	return apply(await ask(request));
}

const highlightCard = initHighlights({
	ask,
	flash,
	// Only a tab whose page the panel can see: the same rule as items attaching to it.
	tabId: () => (page.url ? page.tabId : null),
	workspaceId: () => ui.workspace.value || undefined,
	pageProblem: () => page.problem,
	render: next => render(next),
});

// --- the page ------------------------------------------------------------------------

async function refreshPage(): Promise<void> {
	page = await currentPage(pending);
	void highlightCard.refresh();
	if (page.url) {
		ui.page.replaceChildren(
			h('div', { className: 'page-title', textContent: page.title || '(untitled page)' }),
			h('div', { className: 'page-url', textContent: page.url }));
	} else {
		ui.page.replaceChildren(h('p', { className: 'hint', textContent: page.problem ?? '' }));
	}
	if (!platformEdited) ui.entityPlatform.value = platformFromUrl(page.url ?? undefined) ?? '';
}

// --- the entity form -----------------------------------------------------------------

const KIND_NAMES: Record<string, string> = {
	email: 'an email address',
	phone: 'a phone number',
	username: 'a username',
	domain: 'a domain',
	url: 'a URL',
	ip: 'an IP address',
	'wallet:btc': 'a Bitcoin address',
	'wallet:eth': 'an Ethereum address',
	'wallet:other': 'a wallet address',
};

function syncKindRows(): void {
	const kind = ui.entityKind.value;
	ui.chainRow.hidden = kind !== 'wallet';
	ui.platformRow.hidden = kind !== 'username';
}

function reclassify(): void {
	const guess = classify(ui.entityValue.value);
	if (!ui.entityValue.value.trim()) {
		ui.entityGuess.textContent = '';
	} else if (guess) {
		ui.entityGuess.textContent = `Looks like ${KIND_NAMES[guess.kind === 'wallet' ? `wallet:${guess.chain}` : guess.kind]}. Change the kind if not.`;
	} else {
		ui.entityGuess.textContent = 'Not sure what this is. Choose a kind.';
	}
	if (!kindChosen) {
		ui.entityKind.value = guess?.kind ?? '';
		if (guess?.chain) ui.entityChain.value = guess.chain;
	}
	syncKindRows();
}

function setEntityValue(text: string): void {
	// Not cut to fit: the protocol rejects rather than truncates, and a clipped value would
	// be a different entity. Too long shows the length error on Send.
	ui.entityValue.value = text.trim();
	kindChosen = false;
	ui.entityProblem.hidden = true;
	reclassify();
	ui.entityValue.focus();
}

async function takePending(): Promise<void> {
	let got: Record<string, unknown> = {};
	try {
		got = await chrome.storage.session.get(PENDING_SELECTION);
	} catch {
		return;
	}
	const next = got[PENDING_SELECTION] as PendingSelection | undefined;
	if (!next || typeof next.text !== 'string') return;
	// A click the panel only sees now (it could not open at the time) may be from a page
	// the tab has since left; its text is still worth offering, its URL is not.
	pending = Date.now() - next.at < 30_000 ? next : null;
	// Consumed: reopening the panel later must not refill the form with an old selection.
	void chrome.storage.session.remove(PENDING_SELECTION).catch(() => {});
	setEntityValue(next.text);
	await refreshPage();
}

function entityFromForm(): EntityPayload | string {
	const kind = ui.entityKind.value as EntityKind | '';
	if (!kind) return 'Choose what kind of entity this is.';
	const entity: EntityPayload = { kind, value: ui.entityValue.value };
	if (kind === 'wallet') entity.chain = ui.entityChain.value as WalletChain;
	if (kind === 'username' && ui.entityPlatform.value.trim()) entity.platform = ui.entityPlatform.value.trim().toLowerCase();
	if (ui.entityContext.value.trim()) entity.context = ui.entityContext.value;
	const checked = validateEntity(entity);
	return checked.ok ? checked.value : describeFieldProblem(checked.detail);
}

function describeFieldProblem(detail: string): string {
	return detail.replace(/^entity\.value: /, '').replace(/^entity\.(\w+): /, (_m, f: string) => `${f[0].toUpperCase()}${f.slice(1)}: `);
}

// --- wiring --------------------------------------------------------------------------

function pageOrComplain(): { url: string; title: string } | null {
	if (!page.url) {
		flash(page.problem ?? describeError('no_page'), true);
		return null;
	}
	return { url: page.url, title: page.title };
}

ui.pairForm.addEventListener('submit', async event => {
	event.preventDefault();
	const text = ui.pairInput.value.trim();
	if (!text) return;
	const button = ui.pairForm.querySelector('button');
	if (button) button.disabled = true;
	flash('Waiting for you to confirm in OSINT Copilot…');
	try {
		if (await act({ type: 'pair', pairingString: text })) ui.pairInput.value = '';
	} finally {
		if (button) button.disabled = false;
	}
});

ui.workspace.addEventListener('change', () => {
	if (ui.workspace.value) void act({ type: 'selectWorkspace', workspaceId: ui.workspace.value });
});

ui.noteForm.addEventListener('submit', async event => {
	event.preventDefault();
	await refreshPage();
	const where = pageOrComplain();
	if (!where) return;
	const text = ui.noteText.value;
	if (!text.trim()) return;
	if (await act({ type: 'send', item: { kind: 'note', page: where, note: { text } }, workspaceId: ui.workspace.value })) ui.noteText.value = '';
});

ui.entityValue.addEventListener('input', () => reclassify());
ui.entityKind.addEventListener('change', () => {
	kindChosen = true;
	syncKindRows();
});
ui.entityPlatform.addEventListener('input', () => { platformEdited = true; });

ui.useSelection.addEventListener('click', async () => {
	await refreshPage();
	if (page.tabId === null) return flash(page.problem ?? describeError('no_page'), true);
	const got = await selectedText(page.tabId);
	if ('error' in got) return flash(got.error, true);
	setEntityValue(got.text);
});

ui.entityForm.addEventListener('submit', async event => {
	event.preventDefault();
	await refreshPage();
	const entity = entityFromForm();
	if (typeof entity === 'string') {
		ui.entityProblem.textContent = entity;
		ui.entityProblem.hidden = false;
		return;
	}
	ui.entityProblem.hidden = true;
	const where = pageOrComplain();
	if (!where) return;
	if (await act({ type: 'send', item: { kind: 'entity', page: where, entity }, workspaceId: ui.workspace.value })) {
		ui.entityValue.value = '';
		ui.entityContext.value = '';
		kindChosen = false;
		reclassify();
	}
});

ui.capture.addEventListener('click', () => {
	// Asked here, synchronously in the click: Chrome allows permissions.request only
	// during a user gesture, and an await first would end it. Already granted, it
	// resolves true without a prompt.
	const asked = chrome.permissions.request(CAPTURE_PERMISSIONS);
	void (async () => {
		let granted = false;
		try {
			granted = await asked;
		} catch {
			granted = false;
		}
		void refreshCapturePermission();
		if (!granted) return flash(describeError('capture_permission_refused'), true);
		await refreshPage();
		if (page.tabId === null) return flash(page.problem ?? describeError('no_page'), true);
		await act({ type: 'capture', tabId: page.tabId, workspaceId: ui.workspace.value });
	})();
});

ui.refresh.addEventListener('click', () => void act({ type: 'refresh' }));
ui.unpair.addEventListener('click', () => {
	if (confirm('Unpair from OSINT Copilot? Items still in the queue stay here and are sent after you pair again.')) {
		void act({ type: 'unpair' });
	}
});

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
	// Only the service worker's broadcast: it has no tab and no page URL.
	if (sender.id !== chrome.runtime.id || sender.tab) return;
	const m = message as { type?: unknown; error?: unknown; tabId?: unknown; id?: unknown };
	if (m?.type === CHANGED) {
		void ask({ type: 'state' }).then(r => r.state && render(r.state));
		void highlightCard.refresh();
		// A highlight asked for from the page's menu, which could not be made.
		if (typeof m.error === 'string') flash(describeError(m.error), true);
	} else if (m?.type === HIGHLIGHT_CLICKED && typeof m.tabId === 'number' && typeof m.id === 'string') {
		highlightCard.focus(m.tabId, m.id);
	}
});

chrome.storage.session.onChanged.addListener(changes => {
	if (changes[PENDING_SELECTION]?.newValue) void takePending();
});

chrome.tabs.onActivated.addListener(() => void refreshPage());
chrome.tabs.onUpdated.addListener((tabId, info) => {
	if (pending && pending.tabId === tabId) pending = null;
	if (info.status || info.title || info.url) void refreshPage();
});
chrome.tabs.onRemoved.addListener(tabId => {
	if (pending && pending.tabId === tabId) pending = null;
});
window.addEventListener('focus', () => void refreshPage());
chrome.permissions.onAdded.addListener(() => void refreshCapturePermission());
chrome.permissions.onRemoved.addListener(() => void refreshCapturePermission());

// The queue's "next try in" text ages, so fetch it again now and then. Asking also keeps
// the service worker awake while the panel is open, so its retry timer can fire.
// Not while the user is working in the queue: a redraw would reset the select they are in.
setInterval(() => {
	void ask({ type: 'state' }).then(r => {
		if (r.state && !ui.queue.contains(document.activeElement)) render(r.state);
	});
}, 15_000);

void (async () => {
	void refreshCapturePermission();
	void chrome.commands.getAll().then(commands => {
		const shortcut = commands.find(c => c.name === 'capture-page')?.shortcut;
		ui.captureShortcut.textContent = shortcut ? `with ${shortcut}` : 'with a keyboard shortcut you can set in chrome://extensions/shortcuts';
	}).catch(() => {});
	await takePending();
	await refreshPage();
	// Cheap first paint from what the worker already knows, then prove the app and send.
	const first = await ask({ type: 'state' });
	if (first.state) render(first.state);
	apply(await ask({ type: 'panelOpened' }));
})();
