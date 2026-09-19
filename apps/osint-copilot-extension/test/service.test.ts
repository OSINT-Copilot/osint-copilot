// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { Channel } from '../src/sw/channel';
import { Queue, sendBundle } from '../src/sw/queue';
import type { Highlights } from '../src/sw/highlights';
import { Service, type ServiceDeps } from '../src/sw/service';
import { KEYS, memoryKV, type PairingRecord } from '../src/sw/storage';
import { FakeApp, counterBytes, fakeNetwork, type Handler } from './fake-app';
import { protocolVectors as v } from './vectors';

const WS = [{ id: 'gtoz4Juogr-egTX3kAreCn', name: 'Case été', open: true }, { id: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'Old case', open: false }];
const PAGE = { url: 'https://example.com/profile', title: 'Profile' };

function world(online = true, extra: Partial<ServiceDeps> = {}) {
	const bundles: unknown[] = [];
	const fake = new FakeApp({
		port: 23760,
		instanceId: v.inputs.instanceId,
		clientId: v.inputs.clientId,
		key: Buffer.from(v.keyDerivation.keyHex, 'hex'),
		route: (method, path, body) => {
			if (method === 'GET' && path === '/v1/workspaces') return { status: 200, body: { workspaces: WS } };
			if (method === 'POST' && path === '/v1/bundles') {
				const m = JSON.parse(body);
				bundles.push(m);
				return { status: 200, body: { status: 'accepted', bundleId: m.bundleId, receivedAt: '2025-10-09T08:53:20.500Z' } };
			}
			return { status: 404, body: { error: 'not_found' } };
		},
	});
	const handlers = new Map<number, Handler>(online ? [[23760, fake.handler]] : []);
	const record: PairingRecord = { clientId: v.inputs.clientId, key: v.keyDerivation.key, instanceId: v.inputs.instanceId, port: 23760, pairingPort: 23760, pairedAt: 1 };
	const storage = memoryKV({ [KEYS.pairing]: record });
	const net = fakeNetwork(handlers);
	const channel = new Channel({ fetch: net.fetch, storage, now: () => Date.now(), randomBytes: counterBytes() });
	const queue = new Queue({ indexedDB: new IDBFactory(), now: () => Date.now(), send: m => sendBundle(channel, m) });
	const changes = { count: 0 };
	const service = new Service({ channel, queue, storage, extVersion: '0.1.0', now: () => 42, onChange: () => { changes.count++; }, ...extra });
	return { service, storage, bundles, handlers, fake, net, changes };
}

describe('service', () => {
	it('lists investigations, picks the only open one, and sends a note straight through', async () => {
		const { service, bundles } = world();
		const opened = await service.handle({ type: 'panelOpened' });
		expect(opened.ok && opened.state).toMatchObject({ connection: 'connected', workspaces: WS, workspacesLive: true, selectedWorkspaceId: WS[0].id });

		const sent = await service.handle({ type: 'send', item: { kind: 'note', page: PAGE, note: { text: 'seen here' } } });
		expect(sent.ok).toBe(true);
		await service.refresh(false);
		expect(bundles).toHaveLength(1);
		expect(bundles[0]).toMatchObject({ v: 1, workspaceId: WS[0].id, kind: 'note', page: PAGE, note: { text: 'seen here' } });
		expect((bundles[0] as { bundleId: string }).bundleId).toMatch(/^[0-9a-f-]{36}$/);
		expect((await service.state()).queue).toEqual([]);
	});

	it('shows the cached list, marked offline, when the app is not running, and keeps items queued', async () => {
		const w = world();
		await w.service.handle({ type: 'panelOpened' });
		w.handlers.clear();
		const reply = await w.service.handle({ type: 'refresh' });
		expect(reply.ok && reply.state).toMatchObject({ connection: 'offline', workspaces: WS, workspacesLive: false, workspacesFetchedAt: 42 });

		const sent = await w.service.handle({ type: 'send', item: { kind: 'entity', page: PAGE, entity: { kind: 'email', value: 'a@example.com' } } });
		expect(sent.ok).toBe(true);
		await w.service.refresh(false);
		const state = await w.service.state();
		expect(state.queue).toHaveLength(1);
		expect(state.queue[0]).toMatchObject({ kind: 'entity', label: 'email: a@example.com', state: 'queued' });
	});

	it('refuses to queue without an investigation, or an item the app would refuse', async () => {
		const { service, storage } = world(false);
		const none = await service.handle({ type: 'send', item: { kind: 'note', page: PAGE, note: { text: 'x' } } });
		expect(none).toMatchObject({ ok: false, error: 'no_workspace' });
		await storage.set({ [KEYS.selectedWorkspace]: WS[0].id });
		const bad = await service.handle({ type: 'send', item: { kind: 'entity', page: PAGE, entity: { kind: 'ip', value: '999.1.1.1' } } });
		expect(bad).toMatchObject({ ok: false, error: 'invalid_item' });
		expect((await service.state()).queue).toEqual([]);
	});

	it('never puts the key or clientId in what the panel sees', async () => {
		const { service } = world();
		const reply = await service.handle({ type: 'panelOpened' });
		const text = JSON.stringify(reply);
		expect(text).not.toContain(v.keyDerivation.key);
		expect(text).not.toContain(v.inputs.clientId);
	});

	it('refuses a send when another window changed the investigation since this panel showed it', async () => {
		const { service, bundles, changes } = world();
		await service.handle({ type: 'panelOpened' });
		// Window 1 picks the other case; every panel is told.
		const before = changes.count;
		expect((await service.handle({ type: 'selectWorkspace', workspaceId: WS[1].id })).ok).toBe(true);
		expect(changes.count).toBeGreaterThan(before);
		// Window 2 still shows the first case.
		const stale = await service.handle({ type: 'send', item: { kind: 'note', page: PAGE, note: { text: 'x' } }, workspaceId: WS[0].id });
		expect(stale).toMatchObject({ ok: false, error: 'workspace_changed' });
		const fresh = await service.handle({ type: 'send', item: { kind: 'note', page: PAGE, note: { text: 'x' } }, workspaceId: WS[1].id });
		expect(fresh.ok).toBe(true);
		await service.refresh(false);
		expect(bundles.map(b => (b as { workspaceId: string }).workspaceId)).toEqual([WS[1].id]);
	});

	it('proves the app again on Refresh, but not every time a panel opens', async () => {
		const { service, net } = world();
		const hellos = () => net.calls.filter(c => c.endsWith('/v1/hello')).length;
		await service.handle({ type: 'panelOpened' });
		await service.handle({ type: 'panelOpened' });
		expect(hellos()).toBe(1);
		await service.handle({ type: 'refresh' });
		expect(hellos()).toBe(2);
	});

	it('has open pages show the chosen investigation\'s highlights, and none once unpaired', async () => {
		const refreshAll = vi.fn(async () => {});
		const { service } = world(true, { highlights: { refreshAll } as unknown as Highlights });
		await service.handle({ type: 'panelOpened' });
		await service.handle({ type: 'selectWorkspace', workspaceId: WS[1].id });
		expect(refreshAll).toHaveBeenCalledTimes(1);
		await service.handle({ type: 'unpair' });
		expect(refreshAll).toHaveBeenCalledTimes(2);
	});

	it('shows highlights again on a revisit only once the investigator allows it', async () => {
		let allowed = false;
		let permission = false;
		const setRevisit = vi.fn(async (allow: boolean) => {
			allowed = allow;
			return allowed && permission;
		});
		const { service } = world(true, { revisitAllowed: async () => allowed && permission, setRevisit });
		// Page capture's grant alone is not the investigator's choice.
		permission = true;
		expect((await service.state()).revisitHighlights).toBe(false);
		const on = await service.handle({ type: 'highlights.revisit', allow: true });
		expect(on).toMatchObject({ ok: true, state: { revisitHighlights: true } });
		const off = await service.handle({ type: 'highlights.revisit', allow: false });
		expect(off).toMatchObject({ ok: true, state: { revisitHighlights: false } });
		// Allowed, but Chrome's permission is missing: said so, not claimed.
		permission = false;
		expect(await service.handle({ type: 'highlights.revisit', allow: true })).toMatchObject({ ok: false, error: 'highlight_permission_needed' });
	});
});
