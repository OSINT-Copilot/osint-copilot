// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../src/shared/protocol';
import { ChannelError, type Channel } from '../src/sw/channel';
import {
	DB_VERSION,
	MAX_BACKOFF_MS,
	MAX_ITEMS,
	Queue,
	QueueFullError,
	backoffMs,
	sendBundle,
	type QueueDeps,
	type QueueItem,
	type SendOutcome,
} from '../src/sw/queue';

const WS_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const WS_B = 'BBBBBBBBBBBBBBBBBBBBBB';

let seq = 0;
function note(text = 'hello', workspaceId = WS_A): Manifest {
	seq++;
	const tail = seq.toString(16).padStart(12, '0');
	return {
		v: 1,
		bundleId: `0b7e7c1e-3f7a-4c56-9a3e-${tail}`,
		workspaceId,
		kind: 'note',
		page: { url: 'https://example.com/', title: 'Example' },
		clientTime: '2025-10-09T08:53:20.000Z',
		note: { text },
	};
}

function setup(outcomes: SendOutcome[] | ((m: Manifest) => SendOutcome), extra: Partial<QueueDeps> = {}) {
	let clock = 1_000_000;
	const sent: Manifest[] = [];
	const indexedDB = new IDBFactory();
	const deps: QueueDeps = {
		indexedDB,
		now: () => clock,
		send: async m => {
			sent.push(structuredClone(m));
			if (typeof outcomes === 'function') return outcomes(m);
			return outcomes.shift() ?? { kind: 'delivered', status: 'accepted' };
		},
		...extra,
	};
	return {
		queue: new Queue(deps),
		deps,
		sent,
		advance: (ms: number) => { clock += ms; },
		now: () => clock,
	};
}

describe('caps', () => {
	it('refuses the 101st item and drops none of the first hundred', async () => {
		const { queue } = setup([]);
		const ids: string[] = [];
		for (let i = 0; i < MAX_ITEMS; i++) ids.push((await queue.enqueue(note(`n${i}`))).bundleId);
		await expect(queue.enqueue(note('one too many'))).rejects.toBeInstanceOf(QueueFullError);
		const kept = (await queue.list()).map(i => i.bundleId);
		expect(kept).toEqual(ids);
	});

	it('refuses an item that would pass the byte cap, keeping the old ones', async () => {
		const { queue } = setup([], { limits: { items: 100, bytes: 800 } });
		const first = await queue.enqueue(note('x'.repeat(200)));
		await expect(queue.enqueue(note('y'.repeat(400)))).rejects.toBeInstanceOf(QueueFullError);
		expect((await queue.list()).map(i => i.bundleId)).toEqual([first.bundleId]);
		// A smaller one still fits.
		await queue.enqueue(note('z'));
		expect(await queue.list()).toHaveLength(2);
	});

	it('refuses a manifest over the 256 KB request cap outright', async () => {
		const { queue } = setup([]);
		await expect(queue.enqueue(note('x'.repeat(300 * 1024)))).rejects.toThrow('too_large');
	});
});

describe('delivery', () => {
	it('removes an accepted item', async () => {
		const { queue, sent } = setup([{ kind: 'delivered', status: 'accepted' }]);
		const item = await queue.enqueue(note());
		await queue.drain();
		expect(sent.map(m => m.bundleId)).toEqual([item.bundleId]);
		expect(await queue.list()).toEqual([]);
	});

	it('retries with the same bundleId after a lost reply, and counts duplicate as delivered', async () => {
		const { queue, sent, advance } = setup([
			{ kind: 'transient', error: 'unverified', stopPass: true },
			{ kind: 'delivered', status: 'duplicate' },
		]);
		const item = await queue.enqueue(note());
		await queue.drain();
		const waiting = (await queue.list())[0];
		expect(waiting).toMatchObject({ state: 'queued', attempts: 1, lastError: 'unverified' });

		advance(backoffMs(1));
		await queue.drain();
		expect(sent.map(m => m.bundleId)).toEqual([item.bundleId, item.bundleId]);
		expect(sent[1]).toEqual(sent[0]);
		expect(await queue.list()).toEqual([]);
	});

	it('backs off exponentially up to ten minutes, and honours it unless forced', async () => {
		expect([1, 2, 3, 4].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
		expect(backoffMs(8)).toBe(MAX_BACKOFF_MS);
		expect(backoffMs(50)).toBe(MAX_BACKOFF_MS);

		const { queue, sent, advance, now } = setup(() => ({ kind: 'transient', error: 'unreachable', stopPass: true }));
		await queue.enqueue(note());
		await queue.drain();
		await queue.drain();
		expect(sent).toHaveLength(1);
		expect((await queue.list())[0].nextAttemptAt).toBe(now() + 5_000);

		advance(4_999);
		await queue.drain();
		expect(sent).toHaveLength(1);
		advance(1);
		await queue.drain();
		expect(sent).toHaveLength(2);
		expect((await queue.list())[0].nextAttemptAt).toBe(now() + 10_000);

		// The user is looking: send now.
		await queue.drain({ force: true });
		expect(sent).toHaveLength(3);
	});

	it('moves a permanent refusal to failed and stops retrying it', async () => {
		const { queue, sent, advance } = setup([{ kind: 'permanent', error: 'unknown_workspace' }]);
		await queue.enqueue(note());
		await queue.drain();
		expect((await queue.list())[0]).toMatchObject({ state: 'failed', lastError: 'unknown_workspace', attempts: 1 });
		advance(MAX_BACKOFF_MS * 10);
		await queue.drain({ force: true });
		expect(sent).toHaveLength(1);
	});

	it('retries a failed item to another investigation under the same bundleId', async () => {
		const { queue, sent } = setup([{ kind: 'permanent', error: 'unknown_workspace' }, { kind: 'delivered', status: 'accepted' }]);
		const item = await queue.enqueue(note());
		await queue.drain();
		expect(await queue.retry(item.bundleId, WS_B)).toBe(true);
		await queue.drain();
		expect(sent.map(m => [m.bundleId, m.workspaceId])).toEqual([[item.bundleId, WS_A], [item.bundleId, WS_B]]);
		expect(await queue.list()).toEqual([]);
	});

	it('will not move an item that is still queued, whose first send may have arrived', async () => {
		const { queue, sent } = setup([{ kind: 'transient', error: 'unverified' }]);
		const item = await queue.enqueue(note());
		await queue.drain();
		// The app may have stored it before the reply was lost; only the same place is safe.
		expect(await queue.retry(item.bundleId, WS_B)).toBe(false);
		expect((await queue.get(item.bundleId))!.workspaceId).toBe(WS_A);
		expect(await queue.retry(item.bundleId)).toBe(true);
		await queue.drain();
		expect(sent.map(m => m.workspaceId)).toEqual([WS_A, WS_A]);
	});

	it('does not retry or retarget an item that is being sent', async () => {
		let release!: () => void;
		const gate = new Promise<void>(r => { release = r; });
		const { queue } = setup([], {
			send: async () => {
				await gate;
				return { kind: 'transient', error: 'unverified' };
			},
		});
		const item = await queue.enqueue(note());
		const draining = queue.drain();
		while ((await queue.get(item.bundleId))!.state !== 'sending') await new Promise(r => setTimeout(r, 1));
		expect(await queue.retry(item.bundleId)).toBe(false);
		expect(await queue.retry(item.bundleId, WS_B)).toBe(false);
		release();
		await draining;
		expect((await queue.get(item.bundleId))!).toMatchObject({ state: 'queued', workspaceId: WS_A, manifest: { workspaceId: WS_A } });
	});

	it('deletes an item on request', async () => {
		const { queue } = setup([{ kind: 'permanent', error: 'invalid', detail: 'note.text: must not be empty' }]);
		const item = await queue.enqueue(note());
		await queue.drain();
		await queue.remove(item.bundleId);
		expect(await queue.list()).toEqual([]);
	});

	it('stops a pass when the app is unreachable instead of failing every item the same way', async () => {
		const { queue, sent } = setup([{ kind: 'transient', error: 'unreachable', stopPass: true }]);
		await queue.enqueue(note('one'));
		await queue.enqueue(note('two'));
		await queue.drain();
		expect(sent).toHaveLength(1);
	});

	it('keeps going past a refusal that concerns one item only', async () => {
		const { queue, sent } = setup([{ kind: 'transient', error: 'budget_exceeded' }, { kind: 'delivered', status: 'accepted' }]);
		await queue.enqueue(note('one'));
		await queue.enqueue(note('two', WS_B));
		await queue.drain();
		expect(sent).toHaveLength(2);
		expect(await queue.list()).toHaveLength(1);
	});

	it('resends an item a stopped worker left in "sending"', async () => {
		const { queue, deps, sent } = setup([]);
		const item = await queue.enqueue(note());
		// Simulate the worker dying mid-send: the item is stuck in 'sending'.
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const r = deps.indexedDB.open('oc', DB_VERSION);
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => reject(r.error);
		});
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction('queue', 'readwrite');
			tx.objectStore('queue').put({ ...item, state: 'sending' } satisfies QueueItem);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		const restarted = new Queue(deps);
		await restarted.drain();
		expect(sent.map(m => m.bundleId)).toEqual([item.bundleId]);
		expect(await restarted.list()).toEqual([]);
	});

	it('runs one pass at a time; a call during a pass is served by another round', async () => {
		let release!: () => void;
		const gate = new Promise<void>(r => { release = r; });
		let calls = 0;
		const { queue, sent } = setup([], {
			send: async m => {
				calls++;
				if (calls === 1) await gate;
				sent.push(m);
				return { kind: 'delivered', status: 'accepted' };
			},
		});
		await queue.enqueue(note('one'));
		const first = queue.drain();
		await queue.enqueue(note('two'));
		const second = queue.drain();
		release();
		await Promise.all([first, second]);
		expect(sent.map(m => (m as Extract<Manifest, { kind: 'note' }>).note.text)).toEqual(['one', 'two']);
	});
});

describe('sendBundle', () => {
	const manifest = note();
	function stub(result: { status: number; body: unknown } | Error): Channel {
		return { request: async () => { if (result instanceof Error) throw result; return result; } } as unknown as Channel;
	}

	it.each([
		['accepted', { status: 200, body: { status: 'accepted', bundleId: manifest.bundleId, receivedAt: 't' } }, { kind: 'delivered', status: 'accepted' }],
		['duplicate', { status: 200, body: { status: 'duplicate', bundleId: manifest.bundleId, receivedAt: 't' } }, { kind: 'delivered', status: 'duplicate' }],
		['unknown_workspace', { status: 404, body: { error: 'unknown_workspace' } }, { kind: 'permanent', error: 'unknown_workspace', detail: undefined }],
		['invalid', { status: 422, body: { error: 'invalid', detail: 'page.url: must be an http(s) URL' } }, { kind: 'permanent', error: 'invalid', detail: 'page.url: must be an http(s) URL' }],
		['rate_limited', { status: 429, body: { error: 'rate_limited' } }, { kind: 'transient', error: 'rate_limited', detail: undefined, stopPass: true }],
		['unlicensed', { status: 403, body: { error: 'unlicensed' } }, { kind: 'transient', error: 'unlicensed', detail: undefined, stopPass: true }],
		['budget_exceeded', { status: 507, body: { error: 'budget_exceeded' } }, { kind: 'transient', error: 'budget_exceeded', detail: undefined, stopPass: false }],
		['another bundle\'s receipt', { status: 200, body: { status: 'accepted', bundleId: 'other', receivedAt: 't' } }, { kind: 'transient', error: 'bad_response', detail: undefined, stopPass: false }],
	] as const)('%s', async (_n, reply, expected) => {
		expect(await sendBundle(stub(reply), manifest)).toEqual(expected);
	});

	it('treats an unverifiable reply as transient, to retry with the same bundleId', async () => {
		expect(await sendBundle(stub(new ChannelError('unverified')), manifest)).toEqual({ kind: 'transient', error: 'unverified', stopPass: true });
	});
});

describe('retry timer', () => {
	it('wakes earlier for an item due before the timer already set', async () => {
		const { queue, deps } = setup(() => ({ kind: 'transient', error: 'unreachable' }));
		const slow = await queue.enqueue(note('slow'));
		// Push the first item's backoff to the ten-minute cap.
		for (let i = 0; i < 12; i++) await queue.drain({ force: true });
		expect((await queue.get(slow.bundleId))!.attempts).toBe(12);

		// A worker with a timer, over the same database.
		const timers: number[] = [];
		const timed = new Queue({ ...deps, schedule: delay => { timers.push(delay); } });
		await timed.drain();
		expect(timers).toEqual([MAX_BACKOFF_MS]);

		await timed.enqueue(note('fast'));
		await timed.drain();
		// The new item's 5 s backoff gets its own wake-up, not the ten-minute one.
		expect(timers).toEqual([MAX_BACKOFF_MS, backoffMs(1)]);
		// And a later drain with nothing earlier due sets no more.
		await timed.drain();
		expect(timers).toHaveLength(2);
	});
});
