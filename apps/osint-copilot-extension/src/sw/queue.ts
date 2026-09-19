// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The durable send queue: IndexedDB database 'oc', object stores 'queue' (one record per
 * item) and 'blobs' (a capture's files, keyed "<bundleId>/<name>").
 *
 * Every item is queued before it is sent, so a closed app, a sleeping laptop or a service
 * worker Chrome stopped mid-request loses nothing. The rules:
 *
 * - Caps of 100 items and 300 MB, a capture's files included. When full, new items are
 *   refused with a message; old ones are never dropped to make room, because an item the
 *   user sent is evidence.
 * - A retry reuses the item's bundleId, the app's idempotency key, so an item whose reply
 *   was lost is not filed twice; "duplicate" counts as delivered.
 * - Transient failures back off exponentially, to at most ten minutes.
 * - Permanent refusals (unknown investigation, invalid) stop retrying and wait in 'failed'
 *   for the user to send them to another investigation or delete them.
 * - A capture goes in three steps (create, each file, commit; PROTOCOL.md §7.4-7.6). A
 *   retry starts again at create, whose reply lists only the files the app still lacks,
 *   so an upload cut off by a crash or a restart resumes rather than restarts. The files
 *   stay in 'blobs' until the app answers accepted or duplicate, and through a failure,
 *   so a retry has them; only delivery or the user's Delete removes them.
 *
 * Chrome stops an idle service worker after about 30 s and this extension does not ask
 * for the alarms permission, so a timer only covers retries while the worker is alive;
 * drain() also runs at worker start, on enqueue, when the side panel opens and on every
 * user action.
 */
import { CAPTURE_FILE_NAMES, MAX_CONTROL_BODY, type CaptureFileName, type Manifest } from '../shared/protocol';
import { isRecord } from '../shared/validate';
import { ChannelError, errorCodeOf, type Channel } from './channel';
import { done, req } from './idb';

export const DB_NAME = 'oc';
export const DB_VERSION = 2;
export const STORE = 'queue';
export const BLOBS = 'blobs';
export const MAX_ITEMS = 100;
const MAX_BYTES = 300 * 1024 * 1024;
const BASE_BACKOFF_MS = 5_000;
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
	/** UTF-8 bytes of the manifest as sent, plus a capture's files: what counts against the 300 MB cap. */
	size: number;
	/** Said about the item when it was made, e.g. why a capture has no screenshot. */
	notes?: string[];
}

/** One stored file of a capture. */
interface BlobRecord {
	bundleId: string;
	name: CaptureFileName;
	blob: Blob;
}

function blobKey(bundleId: string, name: string): string {
	return `${bundleId}/${name}`;
}

/** What send() gets beyond the manifest: a capture's files, and a way to report progress. */
export interface SendContext {
	/** The stored bytes of one file, or undefined if the store has lost it. */
	file(name: CaptureFileName): Promise<Uint8Array<ArrayBuffer> | undefined>;
	/** Bytes of this attempt's uploads sent so far, of the total it has to send. */
	progress(sent: number, total: number): void;
}

export interface Progress {
	sent: number;
	total: number;
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
	send: (manifest: Manifest, ctx?: SendContext) => Promise<SendOutcome>;
	/** Wakes drain() for the next due retry while the worker lives. */
	schedule?: (delayMs: number, run: () => void) => void;
	onChange?: () => void;
	/** The caps, overridable so tests can reach them without 300 MB of fixtures. */
	limits?: { items: number; bytes: number };
}

export function backoffMs(attempts: number): number {
	return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Codes that no retry can fix: the same bundle to the same place gets the same answer.
 * hash_mismatch is here because the bytes signed are the bytes stored: a mismatch means
 * the stored copy changed, and resending it gives the same answer. unknown_bundle,
 * conflict and incomplete are not: the next attempt creates the capture again (its
 * staging may have been swept) and sends what is missing.
 */
const PERMANENT = new Set(['unknown_workspace', 'invalid', 'bad_json', 'too_large', 'hash_mismatch', 'not_found', 'method_not_allowed', 'bad_proto', 'blob_missing']);

/** Transient refusals that apply to every item, not just this one. */
const APP_WIDE = new Set(['rate_limited', 'unlicensed', 'clock_skew', 'internal']);

type Reply = { status: number; body: unknown };

/** Sends one signed step; a request that got no trustworthy answer becomes a queue outcome. */
async function step(run: () => Promise<Reply>): Promise<Reply | SendOutcome> {
	try {
		return await run();
	} catch (err) {
		const code = err instanceof ChannelError ? err.code : 'unreachable';
		return { kind: 'transient', error: code, stopPass: code !== 'bad_response' };
	}
}

function isOutcome(value: Reply | SendOutcome): value is SendOutcome {
	return 'kind' in value;
}

function refusal(body: unknown): SendOutcome {
	const record = isRecord(body) ? body : null;
	const error = errorCodeOf(body) ?? 'bad_response';
	const detail = record && typeof record.detail === 'string' ? record.detail
		: record && Array.isArray(record.detail) ? record.detail.filter(d => typeof d === 'string').join(', ')
		: undefined;
	if (PERMANENT.has(error)) return { kind: 'permanent', error, detail };
	return { kind: 'transient', error, detail, stopPass: APP_WIDE.has(error) };
}

/** A receipt for this bundle: accepted or duplicate, naming it. */
function receipt(res: Reply, bundleId: string): SendOutcome | null {
	const body = isRecord(res.body) ? res.body : null;
	if (res.status === 200 && body && (body.status === 'accepted' || body.status === 'duplicate') && body.bundleId === bundleId) {
		return { kind: 'delivered', status: body.status };
	}
	return null;
}

/**
 * POST /v1/bundles through the channel, with the reply sorted into a queue outcome. A
 * capture continues with its missing files and the commit.
 */
export async function sendBundle(channel: Channel, manifest: Manifest, ctx?: SendContext): Promise<SendOutcome> {
	const res = await step(() => channel.request('POST', '/v1/bundles', manifest));
	if (isOutcome(res)) return res;
	const delivered = receipt(res, manifest.bundleId);
	if (delivered) return delivered;
	const body = isRecord(res.body) ? res.body : null;
	if (manifest.kind === 'capture' && res.status === 200 && body?.status === 'created' && body.bundleId === manifest.bundleId) {
		return sendCaptureFiles(channel, manifest, body.missing, ctx);
	}
	return refusal(res.body);
}

async function sendCaptureFiles(channel: Channel, manifest: Extract<Manifest, { kind: 'capture' }>, missing: unknown, ctx?: SendContext): Promise<SendOutcome> {
	const declared = manifest.capture.files as Partial<Record<CaptureFileName, { size: number }>>;
	// Only names we declared, in the protocol's order: the list came from the app, but a
	// name it made up would otherwise become part of a request path.
	const names = Array.isArray(missing) ? CAPTURE_FILE_NAMES.filter(n => missing.includes(n) && declared[n]) : null;
	if (!names) return { kind: 'transient', error: 'bad_response' };
	const total = names.reduce((sum, n) => sum + declared[n]!.size, 0);
	let sent = 0;
	ctx?.progress(sent, total);
	for (const name of names) {
		const bytes = await ctx?.file(name);
		// The stored file is gone (site data cleared): nothing a retry can restore.
		if (!bytes) return { kind: 'permanent', error: 'blob_missing', detail: name };
		const up = await step(() => channel.upload(`/v1/bundles/${manifest.bundleId}/files/${name}`, bytes));
		if (isOutcome(up)) return up;
		if (!(up.status === 200 && isRecord(up.body) && up.body.received === true)) return refusal(up.body);
		sent += bytes.length;
		ctx?.progress(sent, total);
	}
	const commit = await step(() => channel.request('POST', `/v1/bundles/${manifest.bundleId}/commit`, {}));
	if (isOutcome(commit)) return commit;
	return receipt(commit, manifest.bundleId) ?? refusal(commit.body);
}

export class Queue {
	private db: Promise<IDBDatabase> | null = null;
	/** Upload progress of the item being sent, for the panel. Not stored: it is only true while we send. */
	private readonly uploads = new Map<string, Progress>();
	private draining: Promise<void> | null = null;
	private again = false;
	private forceAgain = false;
	/** When the pending retry timer fires, if one is set. */
	private timerDue: number | null = null;

	constructor(private readonly deps: QueueDeps) {}

	private open(): Promise<IDBDatabase> {
		this.db ??= new Promise((resolve, reject) => {
			const request = this.deps.indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE)) {
					db.createObjectStore(STORE, { keyPath: 'bundleId' }).createIndex('createdAt', 'createdAt');
				}
				if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
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

	progress(bundleId: string): Progress | undefined {
		return this.uploads.get(bundleId);
	}

	private async readBlob(bundleId: string, name: CaptureFileName): Promise<Uint8Array<ArrayBuffer> | undefined> {
		const db = await this.open();
		const record = await req(db.transaction(BLOBS).objectStore(BLOBS).get(blobKey(bundleId, name)) as IDBRequest<BlobRecord | undefined>);
		return record ? new Uint8Array(await record.blob.arrayBuffer()) : undefined;
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
	async enqueue(manifest: Manifest, files: Partial<Record<CaptureFileName, Blob>> = {}, notes?: string[]): Promise<QueueItem> {
		const manifestSize = new TextEncoder().encode(JSON.stringify(manifest)).length;
		if (manifestSize > MAX_CONTROL_BODY) throw new ItemTooLargeError();
		const blobs = Object.entries(files) as [CaptureFileName, Blob][];
		const size = blobs.reduce((sum, [, b]) => sum + b.size, manifestSize);
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
			...(notes?.length ? { notes } : {}),
		};
		const db = await this.open();
		// Item and files in one transaction: a capture is queued whole or not at all.
		const tx = db.transaction([STORE, BLOBS], 'readwrite');
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
			const blobStore = tx.objectStore(BLOBS);
			for (const [name, blob] of blobs) {
				blobStore.put({ bundleId: item.bundleId, name, blob } satisfies BlobRecord, blobKey(item.bundleId, name));
			}
		};
		await finished;
		if (full) throw new QueueFullError();
		this.deps.onChange?.();
		return item;
	}

	/** Deletes an item and its files together: on delivery, or at the user's Delete. */
	async remove(bundleId: string): Promise<void> {
		const db = await this.open();
		const tx = db.transaction([STORE, BLOBS], 'readwrite');
		tx.objectStore(STORE).delete(bundleId);
		// By name, not by key range: the names are fixed, and IDBKeyRange is a global that
		// not every IndexedDB this runs over (the tests' fake-indexeddb) provides.
		for (const name of CAPTURE_FILE_NAMES) tx.objectStore(BLOBS).delete(blobKey(bundleId, name));
		await done(tx);
		this.uploads.delete(bundleId);
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
			const ctx: SendContext = {
				file: name => this.readBlob(item.bundleId, name),
				progress: (sent, total) => {
					this.uploads.set(item.bundleId, { sent, total });
					this.deps.onChange?.();
				},
			};
			try {
				outcome = current.manifest.kind === 'capture'
					? await this.deps.send(current.manifest, ctx)
					: await this.deps.send(current.manifest);
			} catch (err) {
				outcome = { kind: 'transient', error: 'unreachable', detail: String(err), stopPass: true };
			} finally {
				this.uploads.delete(item.bundleId);
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
