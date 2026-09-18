// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The durable send queue: IndexedDB database 'oc', object store 'queue'.
 *
 * Every item is queued before it is sent, so a closed app, a sleeping laptop or a service
 * worker Chrome stopped mid-request loses nothing. The rules:
 *
 * - Caps of 100 items and 300 MB. When full, new items are refused with a message; old
 *   ones are never dropped to make room, because an item the user sent is evidence.
 * - A retry reuses the item's bundleId, the app's idempotency key, so an item whose reply
 *   was lost is not filed twice; "duplicate" counts as delivered.
 * - Transient failures back off exponentially, to at most ten minutes.
 * - Permanent refusals (unknown investigation, invalid) stop retrying and wait in 'failed'
 *   for the user to send them to another investigation or delete them.
 *
 * Chrome stops an idle service worker after about 30 s and this extension does not ask
 * for the alarms permission, so a timer only covers retries while the worker is alive;
 * drain() also runs at worker start, on enqueue, when the side panel opens and on every
 * user action.
 */
import { MAX_CONTROL_BODY, type Manifest } from '../shared/protocol';
import { ChannelError, errorCodeOf, type Channel } from './channel';

export const DB_NAME = 'oc';
export const STORE = 'queue';
export const MAX_ITEMS = 100;
export const MAX_BYTES = 300 * 1024 * 1024;
export const BASE_BACKOFF_MS = 5_000;
export const MAX_BACKOFF_MS = 10 * 60_000;

export type ItemState = 'queued' | 'sending' | 'failed';

export interface QueueItem {
	bundleId: string;
	createdAt: number;
	workspaceId: string;
	manifest: Manifest;
	state: ItemState;
	attempts: number;
	lastError: string | null;
	lastErrorDetail?: string;
	nextAttemptAt: number;
	/** UTF-8 bytes of the manifest as sent, counted against the 300 MB cap. */
	size: number;
}

export type SendOutcome =
	| { kind: 'delivered'; status: 'accepted' | 'duplicate' }
	/** Try again later; `stopPass` also ends this pass, since the next item would fail the same way. */
	| { kind: 'transient'; error: string; detail?: string; stopPass?: boolean }
	| { kind: 'permanent'; error: string; detail?: string };

export class QueueFullError extends Error {
	constructor() {
		super('queue_full');
	}
}

export class ItemTooLargeError extends Error {
	constructor() {
		super('too_large');
	}
}

export interface QueueDeps {
	indexedDB: IDBFactory;
	now: () => number;
	send: (manifest: Manifest) => Promise<SendOutcome>;
	/** Wakes drain() for the next due retry while the worker lives. */
	schedule?: (delayMs: number, run: () => void) => void;
	onChange?: () => void;
	/** The caps, overridable so tests can reach them without 300 MB of fixtures. */
	limits?: { items: number; bytes: number };
}

export function backoffMs(attempts: number): number {
	return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

/** Codes that no retry can fix: the same bundle to the same place gets the same answer. */
const PERMANENT = new Set(['unknown_workspace', 'invalid', 'bad_json', 'too_large', 'hash_mismatch', 'not_found', 'method_not_allowed', 'bad_proto']);

/** Transient refusals that apply to every item, not just this one. */
const APP_WIDE = new Set(['rate_limited', 'unlicensed', 'clock_skew', 'internal']);

/** POST /v1/bundles through the channel, with the reply sorted into a queue outcome. */
export async function sendBundle(channel: Channel, manifest: Manifest): Promise<SendOutcome> {
	let res;
	try {
		res = await channel.request('POST', '/v1/bundles', manifest);
	} catch (err) {
		const code = err instanceof ChannelError ? err.code : 'unreachable';
		return { kind: 'transient', error: code, stopPass: code !== 'bad_response' };
	}
	const body = res.body as Record<string, unknown> | null;
	if (res.status === 200 && body && (body.status === 'accepted' || body.status === 'duplicate') && body.bundleId === manifest.bundleId) {
		return { kind: 'delivered', status: body.status };
	}
	const error = errorCodeOf(body) ?? 'bad_response';
	const detail = body && typeof body.detail === 'string' ? body.detail : undefined;
	if (PERMANENT.has(error)) return { kind: 'permanent', error, detail };
	return { kind: 'transient', error, detail, stopPass: APP_WIDE.has(error) };
}

function req<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
	});
}

export class Queue {
	private db: Promise<IDBDatabase> | null = null;
	private draining: Promise<void> | null = null;
	private again = false;
	private forceAgain = false;
	/** When the pending retry timer fires, if one is set. */
	private timerDue: number | null = null;

	constructor(private readonly deps: QueueDeps) {}

	private open(): Promise<IDBDatabase> {
		this.db ??= new Promise((resolve, reject) => {
			const request = this.deps.indexedDB.open(DB_NAME, 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE)) {
					db.createObjectStore(STORE, { keyPath: 'bundleId' }).createIndex('createdAt', 'createdAt');
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return this.db;
	}

	async list(): Promise<QueueItem[]> {
		const db = await this.open();
		const items = await req(db.transaction(STORE).objectStore(STORE).getAll() as IDBRequest<QueueItem[]>);
		return items.sort((a, b) => a.createdAt - b.createdAt);
	}

	async get(bundleId: string): Promise<QueueItem | undefined> {
		const db = await this.open();
		return req(db.transaction(STORE).objectStore(STORE).get(bundleId) as IDBRequest<QueueItem | undefined>);
	}

	private async put(item: QueueItem): Promise<void> {
		const db = await this.open();
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).put(item);
		await done(tx);
	}

	/**
	 * Adds an item, or refuses it when the queue is at a cap. The count, the size and the
	 * insert happen in one transaction, so two quick sends cannot both slip under the cap.
	 */
	async enqueue(manifest: Manifest): Promise<QueueItem> {
		const size = new TextEncoder().encode(JSON.stringify(manifest)).length;
		if (size > MAX_CONTROL_BODY) throw new ItemTooLargeError();
		const now = this.deps.now();
		const item: QueueItem = {
			bundleId: manifest.bundleId,
			createdAt: now,
			workspaceId: manifest.workspaceId,
			manifest,
			state: 'queued',
			attempts: 0,
			lastError: null,
			nextAttemptAt: now,
			size,
		};
		const db = await this.open();
		const tx = db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		const finished = done(tx);
		let full = false;
		const all = store.getAll() as IDBRequest<QueueItem[]>;
		all.onsuccess = () => {
			const items = all.result;
			const bytes = items.reduce((sum, i) => sum + (i.size ?? 0), 0);
			const limits = this.deps.limits ?? { items: MAX_ITEMS, bytes: MAX_BYTES };
			if (items.length >= limits.items || bytes + size > limits.bytes) {
				full = true;
				return;
			}
			store.add(item);
		};
		await finished;
		if (full) throw new QueueFullError();
		this.deps.onChange?.();
		return item;
	}

	async remove(bundleId: string): Promise<void> {
		const db = await this.open();
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).delete(bundleId);
		await done(tx);
		this.deps.onChange?.();
	}

	/**
	 * Sends an item again now, keeping its bundleId. With `workspaceId`, it goes to that
	 * investigation instead, and only from 'failed': the app refused it without storing
	 * anything, so the same bundleId cannot collide with an earlier copy there. An item
	 * still queued may already be stored where it was going (a lost reply), and moving it
	 * would file it in both investigations, since each inbox dedupes only against itself.
	 *
	 * The check and the write share one transaction, so a drain pass cannot mark the item
	 * 'sending' in between and have that overwritten.
	 */
	async retry(bundleId: string, workspaceId?: string): Promise<boolean> {
		const db = await this.open();
		const tx = db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		const finished = done(tx);
		let changed = false;
		const got = store.get(bundleId) as IDBRequest<QueueItem | undefined>;
		got.onsuccess = () => {
			const item = got.result;
			if (!item || item.state === 'sending') return;
			if (workspaceId !== undefined && item.state !== 'failed') return;
			const manifest = workspaceId ? { ...item.manifest, workspaceId } : item.manifest;
			store.put({
				...item,
				manifest,
				workspaceId: manifest.workspaceId,
				state: 'queued',
				lastError: null,
				lastErrorDetail: undefined,
				nextAttemptAt: this.deps.now(),
			} satisfies QueueItem);
			changed = true;
		};
		await finished;
		if (changed) this.deps.onChange?.();
		return changed;
	}

	/**
	 * Sends every due item, oldest first, one at a time. `force` ignores backoff, for when
	 * the user is looking (the panel opened, or they pressed something). Concurrent calls
	 * join the running pass, which then goes round once more.
	 */
	drain(opts: { force?: boolean } = {}): Promise<void> {
		if (this.draining) {
			this.again = true;
			this.forceAgain ||= !!opts.force;
			return this.draining;
		}
		this.draining = (async () => {
			try {
				let force = !!opts.force;
				let first = true;
				do {
					this.again = false;
					await this.pass(force, first);
					first = false;
					force = this.forceAgain;
					this.forceAgain = false;
				} while (this.again);
			} finally {
				this.draining = null;
			}
			await this.scheduleNext();
		})();
		return this.draining;
	}

	private async pass(force: boolean, recover: boolean): Promise<void> {
		const items = await this.list();
		if (recover) {
			// Only one pass runs at a time, so a 'sending' item here was cut off when a
			// previous worker was stopped mid-request. Its bundleId makes resending safe.
			for (const item of items.filter(i => i.state === 'sending')) {
				item.state = 'queued';
				await this.put(item);
			}
		}
		for (const item of items) {
			if (item.state !== 'queued') continue;
			if (!force && item.nextAttemptAt > this.deps.now()) continue;
			// Re-read: the user may have deleted or retargeted it while we were sending another.
			const current = await this.get(item.bundleId);
			if (!current || current.state !== 'queued') continue;
			await this.put({ ...current, state: 'sending' });
			this.deps.onChange?.();

			let outcome: SendOutcome;
			try {
				outcome = await this.deps.send(current.manifest);
			} catch (err) {
				outcome = { kind: 'transient', error: 'unreachable', detail: String(err), stopPass: true };
			}
			const after = await this.get(item.bundleId);
			if (!after) continue;

			if (outcome.kind === 'delivered') {
				await this.remove(item.bundleId);
				continue;
			}
			const attempts = after.attempts + 1;
			if (outcome.kind === 'permanent') {
				await this.put({ ...after, state: 'failed', attempts, lastError: outcome.error, lastErrorDetail: outcome.detail });
			} else {
				await this.put({
					...after,
					state: 'queued',
					attempts,
					lastError: outcome.error,
					lastErrorDetail: outcome.detail,
					nextAttemptAt: this.deps.now() + backoffMs(attempts),
				});
			}
			this.deps.onChange?.();
			if (outcome.kind === 'transient' && outcome.stopPass) break;
		}
	}

	private async scheduleNext(): Promise<void> {
		if (!this.deps.schedule) return;
		const queued = (await this.list()).filter(i => i.state === 'queued');
		if (!queued.length) return;
		const next = Math.max(Math.min(...queued.map(i => i.nextAttemptAt)), this.deps.now());
		// A timer already due by then covers it. An earlier item needs its own wake-up, or a
		// 5 s backoff would wait behind another item's 10-minute one. The later timer still
		// fires, and its drain finds nothing due: harmless, so it is not cancelled.
		if (this.timerDue !== null && this.timerDue <= next) return;
		this.timerDue = next;
		this.deps.schedule(next - this.deps.now(), () => {
			if (this.timerDue === next) this.timerDue = null;
			void this.drain();
		});
	}
}
