// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * What the service worker does for the side panel: pairing, the investigation list,
 * queueing items, page capture and the queue's actions. Wired to Chrome in index.ts; kept
 * free of chrome.* itself so the tests can drive it.
 */
import { describeError } from '../shared/errors';
import { buildManifest } from '../shared/manifest';
import type { CaptureStatus, PanelRequest, PanelState, QueueEntry, Reply } from '../shared/messages';
import { WORKSPACE_ID, type Manifest, type WorkspaceInfo } from '../shared/protocol';
import { CaptureError, type CapturedPage } from './capture';
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
	/** Captures a tab (capture.ts over Chrome). Without it, capture is refused. */
	capture?: (tabId: number) => Promise<CapturedPage>;
	/** Whether pageCapture and <all_urls> are granted. Only checked: asking needs a gesture. */
	hasCapturePermission?: () => Promise<boolean>;
	/** The active tab of the focused window, for a command that came without one. */
	activeTabId?: () => Promise<number | undefined>;
}

function mb(bytes: number): string {
	const n = bytes / (1024 * 1024);
	return n < 10 ? n.toFixed(1) : String(Math.round(n));
}

function label(manifest: Manifest): string {
	if (manifest.kind === 'capture') {
		const title = manifest.page.title || manifest.page.url;
		return `Page: ${title.length > 80 ? `${title.slice(0, 79)}…` : title}`;
	}
	if (manifest.kind === 'note') {
		const line = manifest.note.text.split('\n')[0];
		return line.length > 80 ? `${line.slice(0, 79)}…` : line;
	}
	if (manifest.kind === 'highlight.delete') return 'Delete a highlight';
	if (manifest.kind === 'highlight' || manifest.kind === 'highlight.update') {
		const quote = manifest.highlight.annotation.target.selector[0].exact.replace(/\s+/g, ' ').trim();
		const verb = manifest.kind === 'highlight' ? 'Highlight' : 'Edit highlight';
		return `${verb}: ${quote.length > 80 ? `${quote.slice(0, 79)}…` : quote}`;
	}
	if (manifest.kind !== 'entity') return manifest.kind;
	const e = manifest.entity;
	const kind = e.kind === 'wallet' ? `${e.chain} wallet` : e.kind;
	return `${kind}: ${e.value.length > 80 ? `${e.value.slice(0, 79)}…` : e.value}`;
}

function toEntry(item: QueueItem, queue: Queue): QueueEntry {
	return {
		bundleId: item.bundleId,
		kind: item.manifest.kind,
		label: label(item.manifest),
		size: item.size,
		progress: item.state === 'sending' ? queue.progress(item.bundleId) ?? null : null,
		notes: item.notes ?? [],
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
	/** The latest capture, as the panel shows it. Held in memory: it is progress, not data. */
	private captureStatus: CaptureStatus | null = null;
	private capturing = false;

	constructor(private readonly deps: ServiceDeps) {}

	async state(): Promise<PanelState> {
		const { channel, storage, queue } = this.deps;
		const pairing = await channel.pairing();
		const cache = await storage.get<WorkspaceCache>(KEYS.workspaces);
		const selected = (await storage.get<string>(KEYS.selectedWorkspace)) ?? null;
		const connected = channel.connectedPort !== null;
		const items = await queue.list();
		return {
			paired: pairing ? { instanceId: pairing.instanceId, pairedAt: pairing.pairedAt } : null,
			connection: !pairing ? 'unpaired' : connected ? 'connected' : 'offline',
			problem: pairing && !connected ? describeError(channel.lastProblem ?? 'unreachable') : null,
			appVersion: connected ? channel.appVersion : null,
			workspaces: cache?.list ?? [],
			workspacesLive: connected && this.workspacesLive,
			workspacesFetchedAt: cache?.fetchedAt ?? null,
			selectedWorkspaceId: selected,
			queue: items.map(item => toEntry(item, queue)),
			capture: this.captureView(items),
		};
	}

	/** The capture status, brought up to date with what has become of its queue item. */
	private captureView(items: QueueItem[]): CaptureStatus | null {
		const status = this.captureStatus;
		if (!status || !status.bundleId || status.phase === 'done' || status.phase === 'failed') return status;
		const item = items.find(i => i.bundleId === status.bundleId);
		let next: CaptureStatus;
		if (!item) {
			next = { ...status, phase: 'done', message: 'Page capture delivered to OSINT Copilot.', progress: null };
		} else if (item.state === 'failed') {
			next = { ...status, phase: 'failed', message: `Page capture not sent: ${item.lastError ? describeError(item.lastError, item.lastErrorDetail) : 'refused'}`, progress: null };
		} else if (item.state === 'sending') {
			const progress = this.deps.queue.progress(item.bundleId) ?? null;
			const message = progress ? `Uploading the page capture: ${mb(progress.sent)} of ${mb(progress.total)} MB.` : 'Sending the page capture…';
			return { ...status, phase: 'uploading', message, progress };
		} else {
			const why = item.lastError ? ` ${describeError(item.lastError, item.lastErrorDetail)}` : '';
			return { ...status, phase: 'queued', message: `Page capture queued; it is sent when OSINT Copilot takes it.${why}`, progress: null };
		}
		// Settled: kept as it is now, so it no longer depends on the queue.
		this.captureStatus = next;
		return next;
	}

	private setCapture(phase: CaptureStatus['phase'], message: string, bundleId: string | null = null): void {
		this.captureStatus = { phase, message, bundleId, progress: null, at: this.deps.now() };
		this.deps.onChange?.();
	}

	/**
	 * Called when the user refused the capture permissions at the menu or the command:
	 * nothing is captured, and the panel says so.
	 */
	captureRefused(): void {
		this.setCapture('failed', describeError('capture_permission_refused'));
	}

	/**
	 * Captures a tab and queues it. The permissions must already be granted; this never
	 * asks, because asking needs a user gesture that a message from the panel or a later
	 * turn of the worker does not carry.
	 */
	async capture(tabId: number | undefined, workspaceIdShown?: string): Promise<Reply> {
		const { channel, queue, storage } = this.deps;
		const failCapture = async (error: string, detail?: string): Promise<Reply> => {
			this.setCapture('failed', `Page not captured: ${describeError(error, detail)}`);
			return this.fail(error, detail);
		};
		if (!this.deps.capture) return failCapture('capture_failed', 'not available');
		if (!(await channel.pairing())) return failCapture('not_paired');
		const workspaceId = await storage.get<string>(KEYS.selectedWorkspace);
		if (!workspaceId) return failCapture('no_workspace');
		if (workspaceIdShown !== undefined && workspaceIdShown !== workspaceId) return failCapture('workspace_changed');
		if (!(await this.deps.hasCapturePermission?.())) return failCapture('capture_permission_needed');
		const target = tabId ?? await this.deps.activeTabId?.();
		if (target === undefined) return failCapture('capture_tab_gone');
		// One at a time: two archives at once double the memory for no gain, and the
		// status line can only speak of one.
		if (this.capturing) return this.fail('capture_busy');
		this.capturing = true;
		try {
			this.setCapture('preparing', 'Capturing the page…');
			let captured: CapturedPage;
			try {
				captured = await this.deps.capture(target);
			} catch (err) {
				if (err instanceof CaptureError) return failCapture(err.code, err.detail);
				return failCapture('capture_failed', err instanceof Error ? err.message : String(err));
			}
			const built = buildManifest({ kind: 'capture', workspaceId, page: captured.page, capture: { files: captured.decls } });
			if (!built.ok) return failCapture('invalid_item', built.detail);
			try {
				await queue.enqueue(built.value, captured.files, captured.notes);
			} catch (err) {
				if (err instanceof QueueFullError) return failCapture('queue_full');
				if (err instanceof ItemTooLargeError) return failCapture('too_large');
				throw err;
			}
			this.setCapture('queued', 'Page captured and queued.', built.value.bundleId);
			void queue.drain();
			const note = ['Page captured and queued.', ...captured.notes].join(' ');
			return { ok: true, state: await this.state(), note };
		} finally {
			this.capturing = false;
		}
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

			case 'capture':
				if (typeof request.tabId !== 'number' || !Number.isInteger(request.tabId) || request.tabId < 0) return this.fail('capture_tab_gone');
				return this.capture(request.tabId, request.workspaceId);

			case 'queue.delete':
				await queue.remove(request.bundleId);
				// Gone from the queue by the user's hand, not delivered: the status must not say it was.
				if (this.captureStatus?.bundleId === request.bundleId) this.captureStatus = null;
				return { ok: true, state: await this.state() };
		}
	}

	private async fail(error: string, detail?: string): Promise<Reply> {
		return { ok: false, error, message: describeError(error, detail), state: await this.state() };
	}
}
