// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * What the service worker does for the side panel: pairing, the investigation list,
 * queueing items and the queue's actions. Wired to Chrome in index.ts; kept free of
 * chrome.* itself so the tests can drive it.
 */
import { describeError } from '../shared/errors';
import { buildManifest } from '../shared/manifest';
import type { PanelRequest, PanelState, QueueEntry, Reply } from '../shared/messages';
import { WORKSPACE_ID, type Manifest, type WorkspaceInfo } from '../shared/protocol';
import type { Channel } from './channel';
import { ItemTooLargeError, QueueFullError, type Queue, type QueueItem } from './queue';
import { KEYS, type KV, type WorkspaceCache } from './storage';

export interface ServiceDeps {
	channel: Channel;
	queue: Queue;
	storage: KV;
	extVersion: string;
	now: () => number;
	/** Tells every open panel that what they show may be stale. */
	onChange?: () => void;
}

function label(manifest: Manifest): string {
	if (manifest.kind === 'note') {
		const line = manifest.note.text.split('\n')[0];
		return line.length > 80 ? `${line.slice(0, 79)}…` : line;
	}
	const e = manifest.entity;
	const kind = e.kind === 'wallet' ? `${e.chain} wallet` : e.kind;
	return `${kind}: ${e.value.length > 80 ? `${e.value.slice(0, 79)}…` : e.value}`;
}

function toEntry(item: QueueItem): QueueEntry {
	return {
		bundleId: item.bundleId,
		kind: item.manifest.kind,
		label: label(item.manifest),
		workspaceId: item.workspaceId,
		state: item.state,
		attempts: item.attempts,
		problem: item.lastError ? describeError(item.lastError, item.lastErrorDetail) : null,
		nextAttemptAt: item.nextAttemptAt,
		createdAt: item.createdAt,
	};
}

function isWorkspaceList(body: unknown): body is { workspaces: WorkspaceInfo[] } {
	if (typeof body !== 'object' || body === null) return false;
	const list = (body as { workspaces?: unknown }).workspaces;
	return Array.isArray(list) && list.every(w =>
		typeof w === 'object' && w !== null
		&& typeof w.id === 'string' && WORKSPACE_ID.test(w.id)
		&& typeof w.name === 'string' && typeof w.open === 'boolean');
}

export class Service {
	private workspacesLive = false;

	constructor(private readonly deps: ServiceDeps) {}

	async state(): Promise<PanelState> {
		const { channel, storage, queue } = this.deps;
		const pairing = await channel.pairing();
		const cache = await storage.get<WorkspaceCache>(KEYS.workspaces);
		const selected = (await storage.get<string>(KEYS.selectedWorkspace)) ?? null;
		const connected = channel.connectedPort !== null;
		return {
			paired: pairing ? { instanceId: pairing.instanceId, pairedAt: pairing.pairedAt } : null,
			connection: !pairing ? 'unpaired' : connected ? 'connected' : 'offline',
			problem: pairing && !connected ? describeError(channel.lastProblem ?? 'unreachable') : null,
			appVersion: connected ? channel.appVersion : null,
			workspaces: cache?.list ?? [],
			workspacesLive: connected && this.workspacesLive,
			workspacesFetchedAt: cache?.fetchedAt ?? null,
			selectedWorkspaceId: selected,
			queue: (await queue.list()).map(toEntry),
		};
	}

	/**
	 * Proves the app again, refreshes the investigation list and sends what is due. Fails
	 * quietly: offline is a state the panel shows, not an error.
	 */
	async refresh(force: boolean, reprove = false): Promise<void> {
		const { channel } = this.deps;
		if (!(await channel.pairing())) return;
		if (reprove) channel.reset();
		try {
			await channel.connect();
			await this.fetchWorkspaces();
		} catch {
			this.workspacesLive = false;
		}
		await this.deps.queue.drain({ force });
	}

	private async fetchWorkspaces(): Promise<void> {
		const { channel, storage } = this.deps;
		const res = await channel.request('GET', '/v1/workspaces');
		if (res.status !== 200 || !isWorkspaceList(res.body)) {
			this.workspacesLive = false;
			return;
		}
		const list = res.body.workspaces.map(w => ({ id: w.id, name: w.name, open: w.open }));
		await storage.set({ [KEYS.workspaces]: { list, fetchedAt: this.deps.now() } satisfies WorkspaceCache });
		this.workspacesLive = true;
		// With nothing chosen yet and exactly one investigation open, that is the obvious one.
		const selected = await storage.get<string>(KEYS.selectedWorkspace);
		const open = list.filter(w => w.open);
		if (!selected && open.length === 1) await storage.set({ [KEYS.selectedWorkspace]: open[0].id });
	}

	async handle(request: PanelRequest): Promise<Reply> {
		const { channel, queue, storage } = this.deps;
		switch (request.type) {
			case 'state':
				return { ok: true, state: await this.state() };

			// Opening a panel does not prove the app again: every reply is verified anyway,
			// and hello is limited to 10 a minute, which several windows' panels and worker
			// restarts could reach. The Refresh button does, for when the user doubts it.
			case 'panelOpened':
				await this.refresh(true);
				return { ok: true, state: await this.state() };

			case 'refresh':
				await this.refresh(true, true);
				return { ok: true, state: await this.state() };

			case 'pair': {
				if (typeof request.pairingString !== 'string') return this.fail('malformed_pairing');
				const result = await channel.pair(request.pairingString, this.deps.extVersion);
				if (!result.ok) return this.fail(result.error, result.detail);
				try {
					if (result.connected) await this.fetchWorkspaces();
				} catch {
					this.workspacesLive = false;
				}
				void queue.drain({ force: true });
				return { ok: true, state: await this.state(), note: `Paired with OSINT Copilot (instance ${result.instanceId}).` };
			}

			case 'unpair':
				await channel.unpair();
				this.workspacesLive = false;
				return { ok: true, state: await this.state() };

			case 'selectWorkspace': {
				if (typeof request.workspaceId !== 'string' || !WORKSPACE_ID.test(request.workspaceId)) return this.fail('no_workspace');
				await storage.set({ [KEYS.selectedWorkspace]: request.workspaceId });
				// Panels in other windows must show the new choice before they send.
				this.deps.onChange?.();
				void queue.drain({ force: true });
				return { ok: true, state: await this.state() };
			}

			case 'send': {
				if (!(await channel.pairing())) return this.fail('not_paired');
				const workspaceId = await storage.get<string>(KEYS.selectedWorkspace);
				if (!workspaceId) return this.fail('no_workspace');
				// The panel names the investigation it shows. If another window changed the
				// choice since, sending would file the item where this user did not look.
				if (request.workspaceId !== undefined && request.workspaceId !== workspaceId) return this.fail('workspace_changed');
				const item = request.item;
				if (!item || typeof item !== 'object' || !item.page || typeof item.page.url !== 'string') return this.fail('no_page');
				const built = buildManifest(item.kind === 'note'
					? { kind: 'note', workspaceId, page: item.page, note: item.note }
					: { kind: 'entity', workspaceId, page: item.page, entity: item.entity });
				if (!built.ok) return this.fail('invalid_item', built.detail);
				try {
					await queue.enqueue(built.value);
				} catch (err) {
					if (err instanceof QueueFullError) return this.fail('queue_full');
					if (err instanceof ItemTooLargeError) return this.fail('too_large');
					throw err;
				}
				// Not awaited: the item is safe in the queue, and the panel shows it go.
				void queue.drain();
				return { ok: true, state: await this.state(), note: 'Queued.' };
			}

			case 'queue.retry': {
				const target = request.workspaceId;
				if (target !== undefined && (typeof target !== 'string' || !WORKSPACE_ID.test(target))) return this.fail('no_workspace');
				if (!(await queue.retry(request.bundleId, target))) {
					return this.fail((await queue.get(request.bundleId)) ? 'item_busy' : 'item_gone');
				}
				void queue.drain({ force: true });
				return { ok: true, state: await this.state() };
			}

			case 'queue.delete':
				await queue.remove(request.bundleId);
				return { ok: true, state: await this.state() };
		}
	}

	private async fail(error: string, detail?: string): Promise<Reply> {
		return { ok: false, error, message: describeError(error, detail), state: await this.state() };
	}
}
