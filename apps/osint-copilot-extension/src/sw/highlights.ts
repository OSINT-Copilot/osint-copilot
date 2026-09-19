// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Highlights, on the service worker's side: making one from the selection, editing its
 * note, deleting it, and telling a page's content script which highlights are its own.
 *
 * Each highlight is kept here, per investigation and page, so it can be painted again on
 * the next visit without asking the app (asking on every page load would hand the app
 * the investigator's whole browsing history). Each change is also queued for the app,
 * which files it in the investigation's vault: that copy is the record, this one is what
 * makes the page light up.
 *
 * Free of chrome.*: index.ts supplies the tab, injection and stylesheet calls, so tests
 * can drive all of this.
 */
import { buildManifest } from '../shared/manifest';
import type { ContentCommand, ContentHighlight, DescribeReply, HighlightNames, HighlightStatus } from '../shared/highlights';
import { highlightCss, isHighlightNames } from '../shared/highlights';
import { normalisePageUrl } from '../shared/url';
import type { HighlightAnnotation, HighlightManifest, Manifest } from '../shared/protocol';
import { ItemTooLargeError, QueueFullError, type Queue } from './queue';
import { KEYS, type KV } from './storage';

export const HIGHLIGHTS_DB = 'oc-highlights';
export const HIGHLIGHTS_DB_VERSION = 1;
const STORE = 'highlights';

export interface HighlightRecord {
	/** The annotation's id, urn:uuid:... */
	id: string;
	workspaceId: string;
	/** The page, as an http(s) URL without credentials or fragment: what a revisit is matched on. */
	pageKey: string;
	pageUrl: string;
	title: string;
	annotation: HighlightAnnotation;
}

/** The page a URL is, for highlights: credentials and fragment removed; null if not http(s). */
export function pageKeyOf(url: string): string | null {
	const clean = normalisePageUrl(url);
	if (!clean) return null;
	const u = new URL(clean);
	u.hash = '';
	return u.href;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

/**
 * Its own database, not a store in the queue's: a schema change here can never touch
 * items waiting to be sent, and clearing one does not clear the other.
 */
export class HighlightStore {
	private db: Promise<IDBDatabase> | null = null;

	constructor(private readonly indexedDB: IDBFactory) {}

	private open(): Promise<IDBDatabase> {
		this.db ??= new Promise((resolve, reject) => {
			const request = this.indexedDB.open(HIGHLIGHTS_DB, HIGHLIGHTS_DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE)) {
					db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('page', ['workspaceId', 'pageKey']);
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return this.db;
	}

	async forPage(workspaceId: string, pageKey: string): Promise<HighlightRecord[]> {
		const db = await this.open();
		const all = await req(db.transaction(STORE).objectStore(STORE).index('page').getAll([workspaceId, pageKey]) as IDBRequest<HighlightRecord[]>);
		return all.sort((a, b) => a.annotation.created.localeCompare(b.annotation.created));
	}

	async get(id: string): Promise<HighlightRecord | undefined> {
		const db = await this.open();
		return req(db.transaction(STORE).objectStore(STORE).get(id) as IDBRequest<HighlightRecord | undefined>);
	}

	async put(record: HighlightRecord): Promise<void> {
		const db = await this.open();
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).put(record);
		await done(tx);
	}

	async delete(id: string): Promise<void> {
		const db = await this.open();
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).delete(id);
		await done(tx);
	}
}

/** What the worker needs from Chrome for highlights. */
export interface HighlightTabs {
	/** The tab's URL and title, or null when this extension may not read them. */
	page(tabId: number): Promise<{ url: string; title: string } | null>;
	/** Injects the content script into the tab's top frame if it is not there; false if not allowed. */
	inject(tabId: number): Promise<boolean>;
	/** Sends a command to the tab's top-frame content script. */
	send<T>(tabId: number, command: ContentCommand): Promise<T>;
	/** Adds the ::highlight() stylesheet to the tab's top frame, with origin USER. */
	insertCss(tabId: number, css: string): Promise<void>;
}

export interface HighlightDeps {
	store: HighlightStore;
	queue: Queue;
	storage: KV;
	paired(): Promise<boolean>;
	tabs: HighlightTabs;
	now(): number;
	uuid?(): string;
	/** Tells open panels to ask again. */
	onChange?(): void;
	/** A highlight was clicked on a page: open panels scroll to it. */
	onClicked?(tabId: number, id: string): void;
}

export interface HighlightItem {
	id: string;
	exact: string;
	note: string;
	/** Unknown until the page's content script has reported. */
	status: HighlightStatus | 'unknown';
	created: string;
}

export interface HighlightList {
	tabId: number;
	page: { url: string; title: string } | null;
	items: HighlightItem[];
}

export type HighlightResult =
	| { ok: true; list: HighlightList; note?: string }
	| { ok: false; error: string; detail?: string };

const DESCRIBE_ERRORS: Record<Exclude<DescribeReply, { ok: true }>['reason'], string> = {
	'no-selection': 'highlight_no_selection',
	empty: 'highlight_no_selection',
	'too-long': 'highlight_too_long',
	'not-in-page': 'highlight_no_selection',
	'hidden-text': 'highlight_hidden_text',
};

export class Highlights {
	/** What each tab's content script last reported, by highlight id. Progress, not data. */
	private readonly statuses = new Map<number, Map<string, HighlightStatus>>();
	/** Tabs the content script was injected into (or tried), until it reports or the tab goes. */
	private readonly injected = new Set<number>();

	constructor(private readonly deps: HighlightDeps) {}

	private async workspace(): Promise<string | null> {
		return (await this.deps.storage.get<string>(KEYS.selectedWorkspace)) ?? null;
	}

	/** The highlights on a tab's page, in the selected investigation, for the panel. */
	async list(tabId: number): Promise<HighlightList> {
		const page = await this.deps.tabs.page(tabId);
		const workspaceId = await this.workspace();
		const key = page ? pageKeyOf(page.url) : null;
		if (!page || !key || !workspaceId) return { tabId, page, items: [] };
		// A tab open since before the permission was granted has no content script yet, so
		// its highlights are not painted: inject once. Quietly refused without permission.
		if (!this.statuses.has(tabId) && !this.injected.has(tabId)) {
			this.injected.add(tabId);
			await this.deps.tabs.inject(tabId);
		}
		const reported = this.statuses.get(tabId);
		const records = await this.deps.store.forPage(workspaceId, key);
		return {
			tabId,
			page,
			items: records.map((r) => ({
				id: r.id,
				exact: r.annotation.target.selector[0].exact,
				note: r.annotation.body?.value ?? '',
				status: reported?.get(r.id) ?? 'unknown',
				created: r.annotation.created,
			})),
		};
	}

	private async enqueue(manifest: Manifest): Promise<string | null> {
		try {
			await this.deps.queue.enqueue(manifest);
		} catch (err) {
			if (err instanceof QueueFullError) return 'queue_full';
			if (err instanceof ItemTooLargeError) return 'too_large';
			throw err;
		}
		void this.deps.queue.drain();
		return null;
	}

	/** A modified time later than `previous`, even within the same millisecond. */
	private stamp(previous?: string): string {
		let t = this.deps.now();
		if (previous) t = Math.max(t, Date.parse(previous) + 1);
		return new Date(t).toISOString();
	}

	/** Makes a highlight of the selection in the tab, files it for the app, and paints it. */
	async create(tabId: number, workspaceIdShown?: string): Promise<HighlightResult> {
		if (!(await this.deps.paired())) return { ok: false, error: 'not_paired' };
		const workspaceId = await this.workspace();
		if (!workspaceId) return { ok: false, error: 'no_workspace' };
		if (workspaceIdShown !== undefined && workspaceIdShown !== workspaceId) return { ok: false, error: 'workspace_changed' };
		const page = await this.deps.tabs.page(tabId);
		const pageKey = page ? pageKeyOf(page.url) : null;
		if (!page || !pageKey) return { ok: false, error: 'highlight_no_page' };
		if (!(await this.deps.tabs.inject(tabId))) return { ok: false, error: 'highlight_no_access' };

		let described: DescribeReply;
		try {
			described = await this.deps.tabs.send<DescribeReply>(tabId, { type: 'content.describeSelection' });
		} catch {
			return { ok: false, error: 'highlight_no_access' };
		}
		if (!described?.ok) return { ok: false, error: DESCRIBE_ERRORS[described?.reason ?? 'no-selection'] ?? 'highlight_no_selection' };

		const now = this.stamp();
		const annotation: HighlightAnnotation = {
			id: `urn:uuid:${(this.deps.uuid ?? (() => crypto.randomUUID()))()}`,
			textModel: 'v1',
			created: now,
			modified: now,
			target: { source: pageKey, selector: described.selectors },
		};
		const built = buildManifest({ kind: 'highlight', workspaceId, page, highlight: { annotation } });
		if (!built.ok) return { ok: false, error: 'invalid_item', detail: built.detail };
		const failed = await this.enqueue(built.value);
		if (failed) return { ok: false, error: failed };
		// Kept as the app will hold it: the manifest's cleaned annotation.
		const stored = (built.value as HighlightManifest).highlight.annotation;
		await this.deps.store.put({ id: stored.id, workspaceId, pageKey, pageUrl: page.url, title: page.title, annotation: stored });

		try {
			const reply = await this.deps.tabs.send<{ status?: HighlightStatus }>(tabId, {
				type: 'content.add', highlight: { id: stored.id, selectors: stored.target.selector },
			});
			if (reply?.status) this.record(tabId, stored.id, reply.status);
		} catch {
			// Filed all the same; it is painted on the next visit.
		}
		this.deps.onChange?.();
		return { ok: true, list: await this.list(tabId), note: 'Highlighted.' };
	}

	/** Sets or clears a highlight's note, and queues the edit for the app. */
	async setNote(id: string, note: string, tabId?: number): Promise<HighlightResult> {
		const record = await this.deps.store.get(id);
		if (!record) return { ok: false, error: 'highlight_gone' };
		const text = note.trim();
		const annotation: HighlightAnnotation = {
			...record.annotation,
			modified: this.stamp(record.annotation.modified),
		};
		if (text) annotation.body = { type: 'TextualBody', purpose: 'commenting', value: text };
		else delete annotation.body;
		const built = buildManifest({
			kind: 'highlight.update', workspaceId: record.workspaceId,
			page: { url: record.pageUrl, title: record.title }, highlight: { annotation },
		});
		if (!built.ok) return { ok: false, error: 'invalid_item', detail: built.detail };
		const failed = await this.enqueue(built.value);
		if (failed) return { ok: false, error: failed };
		await this.deps.store.put({ ...record, annotation: (built.value as HighlightManifest).highlight.annotation });
		this.deps.onChange?.();
		return { ok: true, list: tabId === undefined ? { tabId: -1, page: null, items: [] } : await this.list(tabId), note: 'Note saved.' };
	}

	/** Deletes a highlight here and queues the delete for the app, which keeps a tombstone. */
	async remove(id: string, tabId?: number): Promise<HighlightResult> {
		const record = await this.deps.store.get(id);
		if (!record) return { ok: false, error: 'highlight_gone' };
		const built = buildManifest({
			kind: 'highlight.delete', workspaceId: record.workspaceId,
			page: { url: record.pageUrl, title: record.title },
			highlight: { annotationId: id, modified: this.stamp(record.annotation.modified) },
		});
		if (!built.ok) return { ok: false, error: 'invalid_item', detail: built.detail };
		const failed = await this.enqueue(built.value);
		if (failed) return { ok: false, error: failed };
		await this.deps.store.delete(id);
		if (tabId !== undefined) {
			this.statuses.get(tabId)?.delete(id);
			await this.deps.tabs.send(tabId, { type: 'content.remove', id }).catch(() => {});
		}
		this.deps.onChange?.();
		return { ok: true, list: tabId === undefined ? { tabId: -1, page: null, items: [] } : await this.list(tabId), note: 'Highlight deleted.' };
	}

	/** Asks the page to look for a highlight again (after the page changed), and scroll to it. */
	async findAgain(tabId: number, id: string): Promise<HighlightResult> {
		try {
			const reply = await this.deps.tabs.send<{ status?: HighlightStatus }>(tabId, { type: 'content.findAgain', id });
			if (reply?.status) this.record(tabId, id, reply.status);
		} catch {
			return { ok: false, error: 'highlight_no_access' };
		}
		this.deps.onChange?.();
		return { ok: true, list: await this.list(tabId) };
	}

	async scrollTo(tabId: number, id: string): Promise<void> {
		await this.deps.tabs.send(tabId, { type: 'content.scrollTo', id }).catch(() => {});
	}

	// ------------------------------------------------------------------ the content script

	/**
	 * A page's content script asking for its highlights. The page is Chrome's word for
	 * the sender, never the message's: page code can reach the DOM the content script
	 * reads, but not the sender Chrome reports. The stylesheet goes in first, so nothing
	 * paints unstyled.
	 */
	async contentReady(tabId: number, senderUrl: string, names: HighlightNames | null): Promise<{ highlights: ContentHighlight[] }> {
		this.statuses.delete(tabId);
		// A new page in the tab: the next panel look may need to inject again.
		this.injected.delete(tabId);
		if (names && isHighlightNames(names)) await this.deps.tabs.insertCss(tabId, highlightCss(names)).catch(() => {});
		const workspaceId = await this.workspace();
		const key = pageKeyOf(senderUrl);
		if (!workspaceId || !key) return { highlights: [] };
		const records = await this.deps.store.forPage(workspaceId, key);
		this.deps.onChange?.();
		return { highlights: records.map((r) => ({ id: r.id, selectors: r.annotation.target.selector })) };
	}

	contentReport(tabId: number, statuses: Array<{ id: string; status: HighlightStatus }>): void {
		const map = new Map<string, HighlightStatus>();
		for (const s of statuses) {
			if (typeof s?.id === 'string' && (s.status === 'exact' || s.status === 'fuzzy' || s.status === 'orphan')) map.set(s.id, s.status);
		}
		this.statuses.set(tabId, map);
		this.deps.onChange?.();
	}

	contentClicked(tabId: number, id: string): void {
		if (typeof id === 'string') this.deps.onClicked?.(tabId, id);
	}

	tabClosed(tabId: number): void {
		this.statuses.delete(tabId);
		this.injected.delete(tabId);
	}

	private record(tabId: number, id: string, status: HighlightStatus): void {
		let map = this.statuses.get(tabId);
		if (!map) this.statuses.set(tabId, (map = new Map()));
		map.set(id, status);
	}
}
