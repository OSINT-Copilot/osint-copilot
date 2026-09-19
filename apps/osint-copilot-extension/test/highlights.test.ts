// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { ContentCommand, ContentStatus, DescribeReply } from '../src/shared/highlights';
import type { HighlightSelectors, Manifest } from '../src/shared/protocol';
import { validateManifest } from '../src/shared/validate';
import { Channel } from '../src/sw/channel';
import { HighlightStore, Highlights, pageKeyOf, type HighlightTabs } from '../src/sw/highlights';
import { createRouter } from '../src/sw/messages';
import { Queue, sendBundle } from '../src/sw/queue';
import { KEYS, memoryKV, type PairingRecord } from '../src/sw/storage';
import { FakeApp, counterBytes, fakeNetwork, type Handler } from './fake-app';
import { protocolVectors as v } from './vectors';

const WS = 'gtoz4Juogr-egTX3kAreCn';
const OTHER_WS = 'AAAAAAAAAAAAAAAAAAAAAA';
const PAGE = { url: 'https://example.com/article#comments', title: 'Article' };
const SELECTORS: HighlightSelectors = [
	{ type: 'TextQuoteSelector', exact: 'darkfox99', prefix: 'the handle ', suffix: ' on two' },
	{ type: 'TextPositionSelector', start: 40, end: 49 },
];

const ID0 = 'urn:uuid:5f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f60';

interface WorldOptions {
	selection?: DescribeReply;
	inject?: boolean;
	page?: { url: string; title: string } | null;
	/** Highlights may be shown again on a revisit. */
	revisit?: boolean;
	/** The content script is already in the page. */
	present?: boolean;
	/** What an asked content script says about its page. */
	status?: ContentStatus;
	tabs?: number[];
}

function world(opts: WorldOptions = {}) {
	const bundles: Manifest[] = [];
	const fake = new FakeApp({
		port: 23760,
		instanceId: v.inputs.instanceId,
		clientId: v.inputs.clientId,
		key: Buffer.from(v.keyDerivation.keyHex, 'hex'),
		route: (method, path, body) => {
			if (method === 'POST' && path === '/v1/bundles') {
				const m = JSON.parse(body);
				bundles.push(m);
				return { status: 200, body: { status: 'accepted', bundleId: m.bundleId, receivedAt: '2026-09-19T08:00:00.000Z' } };
			}
			return { status: 404, body: { error: 'not_found' } };
		},
	});
	const handlers = new Map<number, Handler>([[23760, fake.handler]]);
	const record: PairingRecord = { clientId: v.inputs.clientId, key: v.keyDerivation.key, instanceId: v.inputs.instanceId, port: 23760, pairingPort: 23760, pairedAt: 1 };
	const storage = memoryKV({ [KEYS.pairing]: record, [KEYS.selectedWorkspace]: WS });
	const channel = new Channel({ fetch: fakeNetwork(handlers).fetch, storage, now: () => Date.now(), randomBytes: counterBytes() });
	const queue = new Queue({ indexedDB: new IDBFactory(), now: () => Date.now(), send: m => sendBundle(channel, m) });
	const sent: Array<{ tabId: number; command: ContentCommand }> = [];
	const css: string[] = [];
	let page = opts.page === undefined ? PAGE : opts.page;
	let present = opts.present ?? false;
	let revisit = opts.revisit ?? false;
	let injections = 0;
	const tabs: HighlightTabs = {
		page: async () => page,
		inject: async () => {
			injections++;
			if (opts.inject === false) return false;
			present = true;
			return true;
		},
		send: async <T>(tabId: number, command: ContentCommand) => {
			sent.push({ tabId, command });
			if (command.type === 'content.describeSelection') {
				return (opts.selection ?? { ok: true, selectors: SELECTORS, exact: 'darkfox99', shown: 'darkfox99' }) as T;
			}
			if (!present) throw new Error('Could not establish connection. Receiving end does not exist.');
			if (command.type === 'content.add') return { status: 'exact' } as T;
			if (command.type === 'content.status') return (opts.status ?? { statuses: [], navigated: false }) as T;
			if (command.type === 'content.paint') {
				return { statuses: command.highlights.map(h => ({ id: h.id, status: 'exact' })), navigated: false } satisfies ContentStatus as T;
			}
			return { ok: true } as T;
		},
		insertCss: async (_tabId, text) => { css.push(text); },
		all: async () => opts.tabs ?? [3],
	};
	let clock = Date.parse('2026-09-19T08:00:00.000Z');
	let ids = 0;
	const store = new HighlightStore(new IDBFactory());
	const deps = {
		store, queue, storage, tabs,
		paired: async () => Boolean(await channel.pairing()),
		revisit: async () => revisit,
		now: () => clock,
		uuid: () => `5f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f6${ids++}`,
	};
	const highlights = new Highlights(deps);
	return {
		highlights, store, queue, storage, channel, bundles, sent, css,
		tick: (ms: number) => { clock += ms; },
		drain: () => queue.drain({ force: true }),
		/** The service worker stopped and started again: same storage, nothing in memory. */
		restart: () => new Highlights(deps),
		setPage: (next: { url: string; title: string } | null) => { page = next; },
		setPresent: (value: boolean) => { present = value; },
		setRevisit: (value: boolean) => { revisit = value; },
		injections: () => injections,
	};
}

describe('making a highlight', () => {
	it('queues an annotation the app accepts, keeps it for revisits, and paints it', async () => {
		const w = world();
		const result = await w.highlights.create(3);
		expect(result).toMatchObject({ ok: true, note: 'Highlighted.' });
		await w.drain();
		expect(w.bundles).toHaveLength(1);
		const [bundle] = w.bundles;
		expect(bundle).toMatchObject({ kind: 'highlight', workspaceId: WS, page: { url: PAGE.url } });
		expect(validateManifest(bundle)).toMatchObject({ ok: true });
		if (bundle.kind !== 'highlight') return;
		// Filed under the page without its fragment, which is what a revisit is matched on.
		expect(bundle.highlight.annotation.target.source).toBe('https://example.com/article');
		expect(bundle.highlight.annotation.id).toBe('urn:uuid:5f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f60');
		expect(w.sent.map(s => s.command.type)).toEqual(['content.describeSelection', 'content.add']);
		expect(result.ok && result.list.items).toEqual([expect.objectContaining({ exact: 'darkfox99', status: 'exact', note: '' })]);
		expect(await w.store.forPage(WS, pageKeyOf(PAGE.url)!)).toHaveLength(1);
	});

	it.each([
		['not paired', async (w: ReturnType<typeof world>) => { await w.channel.unpair(); }, 'not_paired'],
		['no investigation chosen', async (w: ReturnType<typeof world>) => { await w.storage.remove(KEYS.selectedWorkspace); }, 'no_workspace'],
	])('refuses when %s', async (_why, arrange, error) => {
		const w = world();
		await arrange(w);
		expect(await w.highlights.create(3)).toMatchObject({ ok: false, error });
		expect(w.sent).toEqual([]);
	});

	it('refuses when the panel showed another investigation than the one chosen', async () => {
		const w = world();
		expect(await w.highlights.create(3, OTHER_WS)).toMatchObject({ ok: false, error: 'workspace_changed' });
	});

	it('refuses a tab it cannot see or reach, and a page that is not the web', async () => {
		expect(await world({ page: null }).highlights.create(3)).toMatchObject({ ok: false, error: 'highlight_no_page' });
		expect(await world({ page: { url: 'chrome://settings', title: '' } }).highlights.create(3)).toMatchObject({ ok: false, error: 'highlight_no_page' });
		expect(await world({ inject: false }).highlights.create(3)).toMatchObject({ ok: false, error: 'highlight_no_access' });
	});

	it('says why when nothing is selected, too much, or text the page hides', async () => {
		expect(await world({ selection: { ok: false, reason: 'no-selection' } }).highlights.create(3)).toMatchObject({ ok: false, error: 'highlight_no_selection' });
		expect(await world({ selection: { ok: false, reason: 'too-long' } }).highlights.create(3)).toMatchObject({ ok: false, error: 'highlight_too_long' });
		expect(await world({ selection: { ok: false, reason: 'hidden-text' } }).highlights.create(3)).toMatchObject({ ok: false, error: 'highlight_hidden_text' });
	});
});

describe('making a highlight from the right-click menu', () => {
	it('refuses a selection inside a frame: the page\'s own selection would be read instead', async () => {
		const w = world();
		expect(await w.highlights.create(3, undefined, { frameId: 2, selectionText: 'darkfox99' })).toMatchObject({ ok: false, error: 'highlight_frame' });
		expect(w.sent).toEqual([]);
	});

	it('refuses when the selection read is not the one right-clicked', async () => {
		const w = world();
		expect(await w.highlights.create(3, undefined, { frameId: 0, selectionText: 'something else' })).toMatchObject({ ok: false, error: 'highlight_selection_changed' });
		await w.drain();
		expect(w.bundles).toEqual([]);
		expect(await w.store.get(ID0)).toBeUndefined();
	});

	it('takes the one right-clicked, however Chrome spaced, cased or shortened it', async () => {
		const w = world({ selection: { ok: true, selectors: SELECTORS, exact: 'darkfox99', shown: 'darkfox99' } });
		expect(await w.highlights.create(3, undefined, { frameId: 0, selectionText: ' DARKFOX' })).toMatchObject({ ok: true });
	});
});

describe('editing and deleting', () => {
	it('queues a note as an update with a later modified time, and clearing it drops the body', async () => {
		const w = world();
		await w.highlights.create(3);
		const id = 'urn:uuid:5f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f60';
		// Same millisecond as the create: the update must still be later.
		await w.highlights.setNote(id, '  worth a look  ', 3);
		await w.highlights.setNote(id, '', 3);
		await w.drain();
		// Queued in the same millisecond, they may be sent in any order (the app orders a
		// highlight's edits by `modified`, not by arrival), so they are sorted here.
		const byModified = (m: Manifest) => m.kind === 'highlight' || m.kind === 'highlight.update' ? Date.parse(m.highlight.annotation.modified) : 0;
		const [create, note, cleared] = [...w.bundles].sort((a, b) => byModified(a) - byModified(b));
		expect(note).toMatchObject({ kind: 'highlight.update' });
		if (create.kind !== 'highlight' || note.kind !== 'highlight.update' || cleared.kind !== 'highlight.update') throw new Error('kinds');
		expect(note.highlight.annotation.body).toEqual({ type: 'TextualBody', purpose: 'commenting', value: 'worth a look' });
		expect(Date.parse(note.highlight.annotation.modified)).toBeGreaterThan(Date.parse(create.highlight.annotation.modified));
		expect(Date.parse(cleared.highlight.annotation.modified)).toBeGreaterThan(Date.parse(note.highlight.annotation.modified));
		expect(cleared.highlight.annotation.body).toBeUndefined();
		for (const b of w.bundles) expect(validateManifest(b)).toMatchObject({ ok: true });
	});

	it('deletes here, queues the delete for the app, and takes it off the page', async () => {
		const w = world();
		await w.highlights.create(3);
		const id = 'urn:uuid:5f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f60';
		const result = await w.highlights.remove(id, 3);
		expect(result).toMatchObject({ ok: true, note: 'Highlight deleted.' });
		await w.drain();
		expect(w.bundles.map(b => b.kind).sort()).toEqual(['highlight', 'highlight.delete']);
		expect(w.bundles.find(b => b.kind === 'highlight.delete')).toMatchObject({ highlight: { annotationId: id } });
		expect(w.sent.at(-1)?.command).toEqual({ type: 'content.remove', id });
		expect(await w.store.get(id)).toBeUndefined();
		expect(await w.highlights.setNote(id, 'x', 3)).toMatchObject({ ok: false, error: 'highlight_gone' });
	});
});

describe('which pages show highlights', () => {
	const PAGE2 = { url: 'https://example.com/article/2', title: 'Second' };

	it('shows none on a page that moved its address without loading, until the investigator asks', async () => {
		const w = world({ present: true });
		await w.highlights.create(3);
		w.setPage(PAGE2);
		await w.highlights.create(3);
		// The document was loaded from PAGE; the tab's address is PAGE2 now (history.pushState).
		expect(await w.highlights.contentReady(3, PAGE.url, null)).toEqual({ highlights: [], navigated: true });
		w.highlights.contentReport(3, [], true);
		const before = await w.highlights.list(3);
		expect(before.shown).toBe('navigated');
		expect(before.items.map(i => [i.id, i.status])).toEqual([[`${ID0.slice(0, -1)}1`, 'unknown']]);

		const shown = await w.highlights.showHere(3);
		const paint = w.sent.find(s => s.command.type === 'content.paint')?.command;
		// PAGE2's highlight only: the address the tab shows, which the investigator sees.
		expect(paint).toEqual({ type: 'content.paint', highlights: [{ id: `${ID0.slice(0, -1)}1`, selectors: SELECTORS }] });
		expect(shown.ok && shown.list).toMatchObject({ shown: 'yes', items: [{ status: 'exact' }] });
	});

	it('asks an open page again after the service worker restarted', async () => {
		const w = world({ present: true, status: { statuses: [{ id: ID0, status: 'fuzzy' }], navigated: false } });
		await w.highlights.create(3);
		const list = await w.restart().list(3);
		expect(w.sent.at(-1)?.command).toEqual({ type: 'content.status' });
		expect(list).toMatchObject({ shown: 'yes', items: [{ id: ID0, status: 'fuzzy' }] });
	});

	it('goes into a page on its own only when revisits are allowed', async () => {
		const w = world();
		await w.highlights.create(3);
		expect(w.injections()).toBe(1);
		w.setPresent(false);
		const notAllowed = await w.restart().list(3);
		expect(w.injections()).toBe(1);
		expect(notAllowed).toMatchObject({ shown: 'no', items: [{ status: 'unknown' }] });

		w.setRevisit(true);
		const allowed = await w.restart().list(3);
		expect(w.injections()).toBe(2);
		expect(allowed.shown).toBe('pending');
	});

	it('forgets what a page said once the tab loads another document', async () => {
		const w = world({ present: true });
		await w.highlights.create(3);
		expect((await w.highlights.list(3)).shown).toBe('yes');
		// Reloaded: the new document has no content script, since revisits are not allowed.
		w.highlights.forgetTab(3);
		w.setPresent(false);
		expect(await w.highlights.list(3)).toMatchObject({ shown: 'no', items: [{ status: 'unknown' }] });
	});

	it('shows none once unpaired', async () => {
		const w = world();
		await w.highlights.create(3);
		await w.channel.unpair();
		expect(await w.highlights.contentReady(3, PAGE.url, null)).toEqual({ highlights: [] });
		expect((await w.highlights.list(3)).items).toEqual([]);
	});

	it('has every open page ask again, and forgets what they said', async () => {
		const w = world({ present: true, tabs: [3, 7] });
		await w.highlights.create(3);
		await w.highlights.refreshAll();
		expect(w.sent.filter(s => s.command.type === 'content.refresh').map(s => s.tabId)).toEqual([3, 7]);
		await w.highlights.list(3);
		expect(w.sent.at(-1)?.command).toEqual({ type: 'content.status' });
	});

	it('deletes every highlight kept in this browser without telling the app, even with the queue full', async () => {
		const w = world({ present: true });
		await w.highlights.create(3);
		await w.storage.set({ [KEYS.selectedWorkspace]: OTHER_WS });
		await w.highlights.create(3);
		await w.drain();
		expect(w.bundles).toHaveLength(2);
		// Nothing more can be queued; deleting here must not need to.
		vi.spyOn(w.queue, 'enqueue').mockRejectedValue(new Error('must not queue'));
		expect(await w.highlights.clearLocal()).toBe(2);
		expect(await w.store.count()).toBe(0);
		await w.drain();
		expect(w.bundles).toHaveLength(2);
		expect(w.sent.at(-1)?.command).toEqual({ type: 'content.refresh' });
	});
});

describe('the content script', () => {
	it('gets the highlights of the page Chrome says it is on, in the chosen investigation only', async () => {
		const w = world();
		await w.highlights.create(3);
		const names = { exact: 'oc-aaaaaaaaaaaa', fuzzy: 'oc-bbbbbbbbbbbb' };
		const here = await w.highlights.contentReady(3, 'https://example.com/article#top', names);
		expect(here).toEqual({ highlights: [{ id: ID0, selectors: SELECTORS }] });
		expect(w.css).toHaveLength(1);
		expect(w.css[0]).toContain('::highlight(oc-aaaaaaaaaaaa)');
		expect((await w.highlights.contentReady(3, 'https://example.com/other', names)).highlights).toEqual([]);
		await w.storage.set({ [KEYS.selectedWorkspace]: OTHER_WS });
		expect((await w.highlights.contentReady(3, 'https://example.com/article', names)).highlights).toEqual([]);
	});

	it('styles only names of the painter\'s own shape: a name is written into CSS', async () => {
		const w = world();
		await w.highlights.contentReady(3, PAGE.url, { exact: 'x){} body{display:none} ::highlight(y', fuzzy: 'oc-bbbbbbbbbbbb' });
		await w.highlights.contentReady(3, PAGE.url, { exact: 'oc-aaaaaaaaaaaa', fuzzy: 'oc-aaaaaaaaaaaa' });
		expect(w.css).toEqual([]);
	});

	it('keeps only well-formed status reports', async () => {
		const w = world();
		await w.highlights.create(3);
		w.highlights.contentReport(3, [
			{ id: 'urn:uuid:5f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f60', status: 'orphan' },
			{ id: 'x', status: 'owned' as never },
		]);
		const list = await w.highlights.list(3);
		expect(list.items.map(i => i.status)).toEqual(['orphan']);
	});
});

describe('the router, for content scripts', () => {
	const ID = 'eokeefakkjidnblbahcdjobcpallgnfk';
	const ORIGIN = `chrome-extension://${ID}/`;
	const topFrame: chrome.runtime.MessageSender = { id: ID, url: 'https://example.com/article', tab: { id: 9 } as chrome.tabs.Tab, frameId: 0 };

	function route(message: unknown, sender: chrome.runtime.MessageSender) {
		const handle = vi.fn(async () => ({ ok: false as const, error: 'x', message: 'panel' }));
		const content = vi.fn(async () => ({ highlights: [] }));
		const sendResponse = vi.fn();
		const keepOpen = createRouter({ runtimeId: ID, extensionOrigin: ORIGIN, handle, content })(message, sender, sendResponse);
		return { handle, content, sendResponse, keepOpen };
	}

	it('hands a top frame\'s highlight request to the content handler, with Chrome\'s tab and URL', async () => {
		const r = route({ type: 'content.ready', names: null, url: 'https://evil.example/claimed' }, topFrame);
		expect(r.keepOpen).toBe(true);
		await vi.waitFor(() => expect(r.sendResponse).toHaveBeenCalledWith({ highlights: [] }));
		expect(r.content).toHaveBeenCalledWith(expect.objectContaining({ type: 'content.ready' }), { tabId: 9, url: 'https://example.com/article' });
		expect(r.handle).not.toHaveBeenCalled();
	});

	it('refuses a subframe, and anything else a content script asks for', () => {
		const sub = route({ type: 'content.ready', names: null }, { ...topFrame, frameId: 3 });
		expect(sub.content).not.toHaveBeenCalled();
		expect(sub.sendResponse).toHaveBeenCalledWith(expect.objectContaining({ error: 'forbidden' }));
		const panelRequest = route({ type: 'highlight.create', tabId: 9 }, topFrame);
		expect(panelRequest.content).not.toHaveBeenCalled();
		expect(panelRequest.handle).not.toHaveBeenCalled();
		expect(panelRequest.sendResponse).toHaveBeenCalledWith(expect.objectContaining({ error: 'forbidden' }));
	});
});
