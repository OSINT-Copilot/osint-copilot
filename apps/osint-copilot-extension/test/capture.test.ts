// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError } from '../src/shared/errors';
import { CAPTURE_FILE_NAMES, type CaptureManifest } from '../src/shared/protocol';
import { hmacB64url, requestStringToSign, sha256Hex } from '../src/shared/signing';
import { validateManifest } from '../src/shared/validate';
import { CaptureError, captureErrorCode, capturePage, chromeCaptureApi, type CaptureApi } from '../src/sw/capture';
import { Channel } from '../src/sw/channel';
import { captureFromGesture, type CaptureGestureDeps } from '../src/sw/menus';
import { BLOBS, DB_NAME, Queue, sendBundle, type QueueItem } from '../src/sw/queue';
import { Service } from '../src/sw/service';
import { KEYS, type PairingRecord } from '../src/sw/storage';
import { FakeApp, counterBytes, fakeNetwork, type Handler } from './fake-app';
import { memoryKV } from './memory-kv';
import { fromHex, protocolVectors as v } from './vectors';

const hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
const MHTML = 'From: <Saved by Blink>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related;\r\n\ttype="text/html";\r\n\tboundary="----b"\r\n\r\n------b--\r\n';
const WS = 'gtoz4Juogr-egTX3kAreCn';
const URL_A = 'https://example.com/profile';

// --- the tab and Chrome, stubbed -----------------------------------------------------

interface TabStub { id: number; windowId: number; url: string; title: string; active: boolean }

/**
 * A CaptureApi over a mutable tab. `onSave` and `onScreenshot` let a test change the tab
 * while Chrome is "busy", which is exactly the window the identity checks guard.
 */
function stubApi(opts: {
	tab?: Partial<TabStub>;
	onSave?: (tab: TabStub) => void;
	onScreenshot?: (tab: TabStub) => void;
	saveError?: string;
	frontTabId?: () => number;
	contentType?: string;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
} = {}) {
	const tab: TabStub = { id: 7, windowId: 1, url: URL_A, title: 'Profile', active: true, ...opts.tab };
	const calls = { screenshots: 0, fetches: [] as { url: string; init: RequestInit }[] };
	const api: CaptureApi = {
		getTab: async id => {
			if (id !== tab.id) throw new Error(`No tab with id: ${id}.`);
			return { ...tab } as chrome.tabs.Tab;
		},
		activeTabOf: async windowId => (windowId === tab.windowId ? { id: opts.frontTabId?.() ?? (tab.active ? tab.id : 99) } as chrome.tabs.Tab : undefined),
		saveAsMHTML: async () => {
			if (opts.saveError) throw new Error(opts.saveError);
			opts.onSave?.(tab);
			return new Blob([MHTML]);
		},
		captureVisibleTab: async () => {
			calls.screenshots++;
			opts.onScreenshot?.(tab);
			return PNG_DATA_URL;
		},
		contentType: async () => opts.contentType ?? 'text/html',
		fetch: async (url, init) => {
			calls.fetches.push({ url, init });
			if (opts.fetch) return opts.fetch(url, init);
			throw new TypeError('no network in this test');
		},
	};
	return { api, tab, calls };
}

describe('the permission request', () => {
	function gestureDeps(answer: boolean | Error) {
		const log: string[] = [];
		const deps: CaptureGestureDeps = {
			requestPermissions: () => {
				log.push('request');
				return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
			},
			openPanel: id => { log.push(`panel ${id}`); },
			capture: async id => { log.push(`capture ${id}`); },
			refused: () => { log.push('refused'); },
		};
		return { deps, log };
	}

	it('is made synchronously inside the menu click or key press, before anything awaits', () => {
		const { deps, log } = gestureDeps(true);
		const done = captureFromGesture({ id: 7 } as chrome.tabs.Tab, deps);
		// Nothing has been awaited yet: Chrome still counts this turn as the user's gesture.
		expect(log).toEqual(['panel 7', 'request']);
		return done.then(() => expect(log).toEqual(['panel 7', 'request', 'capture 7']));
	});

	it('refused, or failing, captures nothing and says so', async () => {
		for (const answer of [false, new Error('This function must be called during a user gesture')]) {
			const { deps, log } = gestureDeps(answer);
			await captureFromGesture({ id: 7 } as chrome.tabs.Tab, deps);
			expect(log).toEqual(['panel 7', 'request', 'refused']);
		}
	});

	it('is never made by the worker for a message: without the permissions a capture is refused', async () => {
		const w = world({ permission: false });
		const capture = vi.fn();
		const service = new Service({ ...w.serviceDeps, capture });
		const reply = await service.handle({ type: 'capture', tabId: 7 });
		expect(reply).toMatchObject({ ok: false, error: 'capture_permission_needed' });
		expect(capture).not.toHaveBeenCalled();
		// The Service has no way to ask at all: its deps offer only hasCapturePermission.
		expect(Object.keys(w.serviceDeps)).not.toContain('requestPermissions');
		expect((await service.state()).queue).toEqual([]);
	});

	it('a refusal at the menu leaves the panel a message and queues nothing', async () => {
		const w = world();
		w.service.captureRefused();
		const state = await w.service.state();
		expect(state.capture).toMatchObject({ phase: 'failed', message: describeError('capture_permission_refused') });
		expect(state.queue).toEqual([]);
	});
});

describe('tab identity', () => {
	it('includes viewport.png when the same tab, at the same URL, stayed in front', async () => {
		const { api, calls } = stubApi();
		const got = await capturePage(api, 7);
		expect(Object.keys(got.files)).toEqual(['page.mhtml', 'viewport.png']);
		expect(calls.screenshots).toBe(1);
		expect(got.notes).toEqual([]);
		expect(got.decls['page.mhtml']).toEqual({ size: Buffer.byteLength(MHTML), sha256: hex(MHTML) });
		expect(got.decls['viewport.png']).toEqual({ size: PNG.length, sha256: hex(PNG) });
		expect(got.page).toEqual({ url: URL_A, title: 'Profile' });
	});

	it.each([
		['the user switched to another tab', (t: TabStub) => { t.active = false; }],
		['the tab was dragged to another window', (t: TabStub) => { t.windowId = 2; }],
	])('omits viewport.png, with a note, when %s during the archive', async (_n, change) => {
		const { api, calls } = stubApi({ onSave: change });
		const got = await capturePage(api, 7);
		expect(got.files['viewport.png']).toBeUndefined();
		expect(got.decls['viewport.png']).toBeUndefined();
		expect(calls.screenshots).toBe(0);
		expect(got.notes.join(' ')).toMatch(/No screenshot/);
	});

	it('omits viewport.png when another tab is the one in front of the window', async () => {
		const { api, calls } = stubApi({ frontTabId: () => 8 });
		const got = await capturePage(api, 7);
		expect(got.files['viewport.png']).toBeUndefined();
		expect(calls.screenshots).toBe(0);
	});

	it('discards a screenshot taken while the tab changed under it', async () => {
		const { api, calls } = stubApi({ onScreenshot: t => { t.active = false; } });
		const got = await capturePage(api, 7);
		expect(calls.screenshots).toBe(1);
		expect(got.files['viewport.png']).toBeUndefined();
		expect(got.notes.join(' ')).toMatch(/No screenshot/);
	});

	it('drops the whole capture when the tab navigated while the archive was made', async () => {
		const { api, calls } = stubApi({ onSave: t => { t.url = 'https://example.com/elsewhere'; } });
		await expect(capturePage(api, 7)).rejects.toMatchObject({ code: 'capture_navigated' });
		expect(calls.screenshots).toBe(0);
	});
});

describe('Chrome\'s errors', () => {
	it.each([
		['Tab navigated before capture could complete.', 'capture_navigated'],
		['The MHTML file generated is too big.', 'capture_too_big'],
		['This page cannot be scripted due to an ExtensionsSettings policy.', 'capture_policy'],
		['Cannot access contents of url "file:///home/a/x.html". Extension manifest must request permission to access this host.', 'capture_file_access'],
		['Cannot access a chrome:// URL', 'capture_browser_page'],
		['The extensions gallery cannot be scripted.', 'capture_browser_page'],
		['No tab with id: 12.', 'capture_tab_gone'],
		['Don\'t have permissions required to capture this page.', 'capture_permission'],
		['Failed to generate MHTML.', 'capture_failed'],
	])('%s', (message, code) => {
		expect(captureErrorCode(message)).toBe(code);
		// Each has a sentence of its own for the panel, not the fallback.
		expect(describeError(code)).not.toMatch(/replied/);
	});

	it('turns a saveAsMHTML failure into a clear refusal, keeping an unknown message as detail', async () => {
		await expect(capturePage(stubApi({ saveError: 'The MHTML file generated is too big.' }).api, 7)).rejects.toMatchObject({ code: 'capture_too_big' });
		await expect(capturePage(stubApi({ saveError: 'Something new' }).api, 7)).rejects.toMatchObject({ code: 'capture_failed', detail: 'Something new' });
	});

	it.each([
		['chrome://settings/', 'capture_browser_page'],
		['https://chromewebstore.google.com/detail/x', 'capture_browser_page'],
		['file:///home/a/x.html', 'capture_not_web'],
		['', 'capture_permission'],
	])('refuses %s before asking Chrome for anything', async (url, code) => {
		const save = vi.fn();
		const { api } = stubApi({ tab: { url } });
		api.saveAsMHTML = save;
		await expect(capturePage(api, 7)).rejects.toMatchObject({ code });
		expect(save).not.toHaveBeenCalled();
	});

	describe('over chrome.* callbacks', () => {
		afterEach(() => { vi.unstubAllGlobals(); });

		it('reads chrome.runtime.lastError in each callback and rejects with its message', async () => {
			const runtime: { lastError?: { message: string } } = {};
			vi.stubGlobal('chrome', {
				runtime,
				pageCapture: {
					saveAsMHTML: (_d: unknown, cb: (b?: Blob) => void) => {
						runtime.lastError = { message: 'Tab navigated before capture could complete.' };
						cb(undefined);
						delete runtime.lastError;
					},
				},
				tabs: {
					captureVisibleTab: (_w: number, _o: unknown, cb: (d: string) => void) => {
						runtime.lastError = { message: 'Either the \'<all_urls>\' or \'activeTab\' permission is required.' };
						cb('');
						delete runtime.lastError;
					},
				},
			});
			const api = chromeCaptureApi();
			await expect(api.saveAsMHTML(7)).rejects.toThrow('Tab navigated before capture could complete.');
			await expect(api.captureVisibleTab(1)).rejects.toThrow('permission is required');
		});
	});
});

describe('a PDF tab', () => {
	const PDF = new TextEncoder().encode('%PDF-1.7\n...');
	const PDF_URL = 'https://docs.example.com/report.pdf#page=2';

	it('fetches the original with the browser\'s credentials, from the tab\'s own URL only', async () => {
		const { api, calls } = stubApi({
			tab: { url: PDF_URL },
			fetch: async url => responseAt(url, PDF),
		});
		const got = await capturePage(api, 7);
		expect(calls.fetches).toHaveLength(1);
		expect(calls.fetches[0].url).toBe('https://docs.example.com/report.pdf');
		expect(calls.fetches[0].init).toMatchObject({ credentials: 'include', redirect: 'error' });
		expect(got.decls['page.pdf']).toEqual({ size: PDF.length, sha256: hex(PDF) });
	});

	it('leaves out what the address served if it is not a PDF, and a fetch that fails', async () => {
		const html = stubApi({ tab: { url: PDF_URL }, contentType: 'application/pdf', fetch: async url => responseAt(url, new TextEncoder().encode('<html>login</html>')) });
		const a = await capturePage(html.api, 7);
		expect(a.files['page.pdf']).toBeUndefined();
		expect(a.notes.join(' ')).toMatch(/did not return a PDF/);
		const refused = stubApi({ tab: { url: PDF_URL }, fetch: async () => { throw new TypeError('Failed to fetch'); } });
		const b = await capturePage(refused.api, 7);
		expect(b.files['page.pdf']).toBeUndefined();
		expect(b.files['page.mhtml']).toBeDefined();
	});

	it('does not fetch anything for an ordinary page', async () => {
		const { api, calls } = stubApi();
		await capturePage(api, 7);
		expect(calls.fetches).toEqual([]);
	});
});

function responseAt(url: string, body: Uint8Array): Response {
	const res = new Response(body as Uint8Array<ArrayBuffer>, { status: 200 });
	Object.defineProperty(res, 'url', { value: url });
	return res;
}

// --- the queue and the three-step upload ---------------------------------------------

interface Staged { files: Record<string, { size: number; sha256: string }>; received: Set<string> }

/** The app's capture endpoints, as PROTOCOL.md §7.4-7.6 describe them, over a FakeApp. */
function captureServer() {
	const staged = new Map<string, Staged>();
	const committed = new Set<string>();
	const log: string[] = [];
	const uploads: { name: string; contentType: string; sha256: string }[] = [];
	let failNext: string | null = null;
	const fake = new FakeApp({
		port: 23760,
		instanceId: v.inputs.instanceId,
		clientId: v.inputs.clientId,
		key: Buffer.from(v.keyDerivation.keyHex, 'hex'),
		route: (method, path, body, raw, headers) => {
			log.push(`${method} ${path}`);
			if (path === '/v1/workspaces') return { status: 200, body: { workspaces: [{ id: WS, name: 'Case', open: true }] } };
			if (path === '/v1/bundles') {
				const m = JSON.parse(body) as CaptureManifest;
				if (committed.has(m.bundleId)) return { status: 200, body: { status: 'duplicate', bundleId: m.bundleId, receivedAt: 't' } };
				if (!staged.has(m.bundleId)) staged.set(m.bundleId, { files: m.capture.files as Staged['files'], received: new Set() });
				const s = staged.get(m.bundleId)!;
				return { status: 200, body: { status: 'created', bundleId: m.bundleId, missing: Object.keys(s.files).filter(n => !s.received.has(n)) } };
			}
			const file = /^\/v1\/bundles\/([0-9a-f-]{36})\/files\/([a-z.]+)$/.exec(path);
			if (file) {
				const s = staged.get(file[1]);
				if (!s) return { status: 404, body: { error: 'unknown_bundle' } };
				const decl = s.files[file[2]];
				if (!decl || decl.size !== raw.length || decl.sha256 !== hex(raw)) return { status: 422, body: { error: 'invalid' } };
				uploads.push({ name: file[2], contentType: headers['content-type'], sha256: hex(raw) });
				s.received.add(file[2]);
				return { status: 200, body: { received: true } };
			}
			const commit = /^\/v1\/bundles\/([0-9a-f-]{36})\/commit$/.exec(path);
			if (commit) {
				if (failNext === 'commit') {
					failNext = null;
					return { status: 422, body: { error: 'invalid', detail: 'capture.files.page.mhtml: refused' } };
				}
				if (committed.has(commit[1])) return { status: 200, body: { status: 'duplicate', bundleId: commit[1], receivedAt: 't' } };
				const s = staged.get(commit[1]);
				if (!s) return { status: 404, body: { error: 'unknown_bundle' } };
				const missing = Object.keys(s.files).filter(n => !s.received.has(n));
				if (missing.length) return { status: 409, body: { error: 'incomplete', detail: missing } };
				staged.delete(commit[1]);
				committed.add(commit[1]);
				return { status: 200, body: { status: 'accepted', bundleId: commit[1], receivedAt: 't' } };
			}
			return { status: 404, body: { error: 'not_found' } };
		},
	});
	return { fake, staged, committed, log, uploads, failCommitOnce: () => { failNext = 'commit'; } };
}

function world(opts: { permission?: boolean; limits?: { items: number; bytes: number } } = {}) {
	const server = captureServer();
	const handlers = new Map<number, Handler>([[23760, server.fake.handler]]);
	/** Makes the next upload of `name` die mid-request, as a stopped worker's would. */
	const cutUpload = new Set<string>();
	const net = fakeNetwork(handlers);
	const fetch = async (url: string, init: RequestInit) => {
		const name = /\/files\/(.+)$/.exec(url)?.[1];
		if (name && cutUpload.delete(name)) throw new TypeError('network error: the worker was stopped');
		return net.fetch(url, init);
	};
	const record: PairingRecord = { clientId: v.inputs.clientId, key: v.keyDerivation.key, instanceId: v.inputs.instanceId, port: 23760, pairingPort: 23760, pairedAt: 1 };
	const storage = memoryKV({ [KEYS.pairing]: record, [KEYS.selectedWorkspace]: WS });
	const indexedDB = new IDBFactory();
	let clock = 1_000_000;
	/** A fresh worker over the same browser: new channel, new queue, same IndexedDB and storage. */
	function boot() {
		const channel = new Channel({ fetch, storage, now: () => Date.now(), randomBytes: counterBytes(clock) });
		const queue = new Queue({ indexedDB, now: () => clock, send: (m, ctx) => sendBundle(channel, m, ctx), limits: opts.limits });
		return { channel, queue };
	}
	const first = boot();
	const tab = stubApi();
	const serviceDeps = {
		channel: first.channel,
		queue: first.queue,
		storage,
		extVersion: '0.1.0',
		now: () => clock,
		capture: (tabId: number) => capturePage(tab.api, tabId),
		hasCapturePermission: async () => opts.permission ?? true,
	};
	const service = new Service(serviceDeps);
	return { ...server, ...first, service, serviceDeps, boot, cutUpload, indexedDB, advance: (ms: number) => { clock += ms; } };
}

async function onlyItem(queue: Queue): Promise<QueueItem> {
	const items = await queue.list();
	expect(items).toHaveLength(1);
	return items[0];
}

describe('capture through the queue', () => {
	it('creates, uploads each file as signed octet-stream, commits, then deletes the blobs', async () => {
		const w = world();
		const reply = await w.service.handle({ type: 'capture', tabId: 7, workspaceId: WS });
		expect(reply).toMatchObject({ ok: true, note: 'Page captured and queued.' });
		const item = await onlyItem(w.queue);
		expect(item.manifest.kind).toBe('capture');
		expect(validateManifest(item.manifest).ok).toBe(true);
		expect(await blobSizes(w.indexedDB, item.bundleId)).toEqual({ 'page.mhtml': Buffer.byteLength(MHTML), 'viewport.png': PNG.length });

		await w.queue.drain();
		expect(w.log.filter(l => l.startsWith('POST'))).toEqual([
			'POST /v1/bundles',
			`POST /v1/bundles/${item.bundleId}/files/page.mhtml`,
			`POST /v1/bundles/${item.bundleId}/files/viewport.png`,
			`POST /v1/bundles/${item.bundleId}/commit`,
		]);
		expect(w.uploads).toEqual([
			{ name: 'page.mhtml', contentType: 'application/octet-stream', sha256: hex(MHTML) },
			{ name: 'viewport.png', contentType: 'application/octet-stream', sha256: hex(PNG) },
		]);
		expect(w.committed.has(item.bundleId)).toBe(true);
		expect(await w.queue.list()).toEqual([]);
		expect(await blobSizes(w.indexedDB, item.bundleId)).toEqual({});
		expect((await w.service.state()).capture).toMatchObject({ phase: 'done', bundleId: item.bundleId });
	});

	it('resumes from the app\'s "missing" list after a restart, under the same bundleId', async () => {
		const w = world();
		await w.service.handle({ type: 'capture', tabId: 7 });
		const item = await onlyItem(w.queue);
		// page.mhtml arrives; the worker is stopped during viewport.png.
		w.cutUpload.add('viewport.png');
		await w.queue.drain();
		expect(w.staged.get(item.bundleId)!.received).toEqual(new Set(['page.mhtml']));
		expect(await onlyItem(w.queue)).toMatchObject({ bundleId: item.bundleId, state: 'queued', lastError: 'unreachable' });
		expect(await blobSizes(w.indexedDB, item.bundleId)).toHaveProperty('viewport.png');

		// A new worker, as after Chrome restarted it: nothing in memory survives.
		const restarted = w.boot();
		w.advance(60_000);
		await restarted.queue.drain();
		const creates = w.log.filter(l => l === 'POST /v1/bundles');
		expect(creates).toHaveLength(2);
		// Only what the app said was missing went again.
		expect(w.uploads.map(u => u.name)).toEqual(['page.mhtml', 'viewport.png']);
		expect(w.committed).toEqual(new Set([item.bundleId]));
		expect(await restarted.queue.list()).toEqual([]);
		expect(await blobSizes(w.indexedDB, item.bundleId)).toEqual({});
	});

	it('keeps the blobs through a permanent refusal, shows the item failed, and retry sends them', async () => {
		const w = world();
		await w.service.handle({ type: 'capture', tabId: 7 });
		const item = await onlyItem(w.queue);
		w.failCommitOnce();
		await w.queue.drain();
		expect(await onlyItem(w.queue)).toMatchObject({ state: 'failed', lastError: 'invalid' });
		expect(Object.keys(await blobSizes(w.indexedDB, item.bundleId))).toEqual(['page.mhtml', 'viewport.png']);
		const state = await w.service.state();
		expect(state.queue[0]).toMatchObject({ kind: 'capture', state: 'failed', label: 'Page: Profile' });
		expect(state.capture).toMatchObject({ phase: 'failed' });

		expect(await w.queue.retry(item.bundleId)).toBe(true);
		await w.queue.drain();
		expect(w.committed).toEqual(new Set([item.bundleId]));
		expect(await blobSizes(w.indexedDB, item.bundleId)).toEqual({});
	});

	it('keeps the blobs while the app is away, and counts "duplicate" as delivered', async () => {
		const w = world();
		await w.service.handle({ type: 'capture', tabId: 7 });
		const item = await onlyItem(w.queue);
		w.cutUpload.add('page.mhtml');
		await w.queue.drain();
		expect(Object.keys(await blobSizes(w.indexedDB, item.bundleId))).toHaveLength(2);
		// Committed meanwhile (say, by another copy of this item): the answer is duplicate.
		w.committed.add(item.bundleId);
		w.advance(60_000);
		await w.queue.drain();
		expect(await w.queue.list()).toEqual([]);
		expect(await blobSizes(w.indexedDB, item.bundleId)).toEqual({});
	});

	it('deletes the blobs with the item when the user deletes it', async () => {
		const w = world();
		await w.service.handle({ type: 'capture', tabId: 7 });
		const item = await onlyItem(w.queue);
		await w.service.handle({ type: 'queue.delete', bundleId: item.bundleId });
		expect(await blobSizes(w.indexedDB, item.bundleId)).toEqual({});
	});

	it('fails an item whose stored files are gone, rather than retrying forever', async () => {
		const w = world();
		await w.service.handle({ type: 'capture', tabId: 7 });
		const item = await onlyItem(w.queue);
		await deleteRaw(w.indexedDB, BLOBS, `${item.bundleId}/viewport.png`);
		await w.queue.drain();
		expect(await onlyItem(w.queue)).toMatchObject({ state: 'failed', lastError: 'blob_missing', lastErrorDetail: 'viewport.png' });
	});

	it('counts the files toward the 300 MB cap', async () => {
		const limits = { items: 100, bytes: 300 * 1024 * 1024 };
		const w = world({ limits });
		expect((await w.service.handle({ type: 'capture', tabId: 7 })).ok).toBe(true);
		const item = await onlyItem(w.queue);
		const manifestBytes = new TextEncoder().encode(JSON.stringify(item.manifest)).length;
		expect(item.size).toBe(manifestBytes + Buffer.byteLength(MHTML) + PNG.length);

		// Room for one more manifest, but not for one more capture's files.
		limits.bytes = 2 * item.size - 1;
		const again = await w.service.handle({ type: 'capture', tabId: 7 });
		expect(again).toMatchObject({ ok: false, error: 'queue_full', message: describeError('queue_full') });
		expect(await w.queue.list()).toHaveLength(1);
		const note = { v: 1 as const, bundleId: '0b7e7c1e-3f7a-4c56-9a3e-00000000000f', workspaceId: WS, kind: 'note' as const, page: { url: URL_A, title: '' }, clientTime: '2025-10-09T08:53:20.000Z', note: { text: 'fits' } };
		await w.queue.enqueue(note);
		expect(await w.queue.list()).toHaveLength(2);
	});
});

describe('the upload signature', () => {
	it('matches the shared octet-stream vector', async () => {
		const key = fromHex(v.keyDerivation.keyHex)!;
		for (const r of v.octetRequests as any[]) {
			const body = fromHex(r.bodyHex)!;
			expect(String(body.length)).toBe(r.contentLength);
			expect(await sha256Hex(body)).toBe(r.bodySha256);
			const s = requestStringToSign({ ...r });
			expect(s).toBe(r.stringToSign);
			expect(await hmacB64url(key, s)).toBe(r.signature);
		}
	});
});

describe('the service\'s capture status', () => {
	it('explains a capture Chrome refused, and queues nothing', async () => {
		const w = world();
		const service = new Service({ ...w.serviceDeps, capture: async () => { throw new CaptureError('capture_browser_page'); } });
		const reply = await service.handle({ type: 'capture', tabId: 7 });
		expect(reply).toMatchObject({ ok: false, error: 'capture_browser_page', message: describeError('capture_browser_page') });
		const state = await service.state();
		expect(state.capture).toMatchObject({ phase: 'failed' });
		expect(state.queue).toEqual([]);
	});

	it('shows uploading progress while the files go, and the notes on the item', async () => {
		const w = world();
		const tab = stubApi({ onSave: t => { t.active = false; } });
		const seen: string[] = [];
		const queue = new Queue({
			indexedDB: w.indexedDB,
			now: () => 2_000_000,
			send: (m, ctx) => sendBundle(w.channel, m, ctx && {
				file: ctx.file,
				progress: (sent, total) => {
					ctx.progress(sent, total);
					seen.push(`${sent}/${total}`);
				},
			}),
		});
		const service = new Service({ ...w.serviceDeps, queue, capture: id => capturePage(tab.api, id) });
		const reply = await service.handle({ type: 'capture', tabId: 7 });
		expect(reply.ok && reply.note).toMatch(/No screenshot/);
		const item = await onlyItem(queue);
		expect((await service.state()).queue[0].notes.join(' ')).toMatch(/No screenshot/);
		await queue.drain();
		const size = Buffer.byteLength(MHTML);
		expect(seen).toEqual([`0/${size}`, `${size}/${size}`]);
		expect(w.committed).toEqual(new Set([item.bundleId]));
		expect((await service.state()).capture).toMatchObject({ phase: 'done' });
	});
});

async function openDb(indexedDB: IDBFactory): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const r = indexedDB.open(DB_NAME);
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

/** The stored files of an item, name to size, read straight from the blobs store. */
async function blobSizes(indexedDB: IDBFactory, bundleId: string): Promise<Record<string, number>> {
	const db = await openDb(indexedDB);
	const store = db.transaction(BLOBS).objectStore(BLOBS);
	// All requested before any is awaited, so the read-only transaction stays open for them.
	const records = await Promise.all(CAPTURE_FILE_NAMES.map(name => new Promise<{ name: string; blob: Blob } | undefined>((resolve, reject) => {
		const r = store.get(`${bundleId}/${name}`);
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	})));
	db.close();
	const out: Record<string, number> = {};
	for (const record of records) if (record) out[record.name] = record.blob.size;
	return out;
}

async function deleteRaw(indexedDB: IDBFactory, store: string, key: string): Promise<void> {
	const db = await openDb(indexedDB);
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(store, 'readwrite');
		tx.objectStore(store).delete(key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	db.close();
}
