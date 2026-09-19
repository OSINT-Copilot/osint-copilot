// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Messages between the side panel and the service worker.
 *
 * The service worker is the only part that holds the key or touches the network; the
 * panel asks it for things. Nothing in a reply is secret: no key, no clientId, no port.
 */
import type { EntityPayload, ManifestPage, WorkspaceInfo } from './protocol';

export type ItemRequest =
	| { kind: 'note'; page: ManifestPage; note: { text: string } }
	| { kind: 'entity'; page: ManifestPage; entity: EntityPayload };

export type PanelRequest =
	| { type: 'state' }
	| { type: 'panelOpened' }
	| { type: 'refresh' }
	| { type: 'pair'; pairingString: string }
	| { type: 'unpair' }
	| { type: 'selectWorkspace'; workspaceId: string }
	/** workspaceId: the investigation the panel shows; refused if the stored choice differs. */
	| { type: 'send'; item: ItemRequest; workspaceId?: string }
	| { type: 'queue.retry'; bundleId: string; workspaceId?: string }
	| { type: 'queue.delete'; bundleId: string }
	/**
	 * Capture the tab. The panel asks for the permissions itself, from the button's click;
	 * the worker only checks they are there.
	 */
	| { type: 'capture'; tabId: number; workspaceId?: string };

export const PANEL_REQUEST_TYPES: readonly PanelRequest['type'][] = [
	'state', 'panelOpened', 'refresh', 'pair', 'unpair', 'selectWorkspace', 'send', 'queue.retry', 'queue.delete', 'capture',
];

export interface QueueEntry {
	bundleId: string;
	kind: 'note' | 'entity' | 'capture' | 'highlight' | 'highlight.update' | 'highlight.delete';
	/** A short, human description: the note's first line, the entity's kind and value, or the page. */
	label: string;
	/** Bytes held for the item, a capture's files included. */
	size: number;
	/** A capture's upload while it is being sent: bytes of this attempt sent, of its total. */
	progress: { sent: number; total: number } | null;
	/** What was said when the item was made, e.g. why a capture has no screenshot. */
	notes: string[];
	workspaceId: string;
	state: 'queued' | 'sending' | 'failed';
	attempts: number;
	/** Plain-language text for the last failure, if any. */
	problem: string | null;
	nextAttemptAt: number;
	createdAt: number;
}

export interface PanelState {
	paired: { instanceId: string; pairedAt: number } | null;
	connection: 'unpaired' | 'connected' | 'offline';
	/** Why the app is not reachable, in plain language, when it is not. */
	problem: string | null;
	appVersion: string | null;
	workspaces: WorkspaceInfo[];
	/** False when the list is the last one fetched, shown because the app is not reachable. */
	workspacesLive: boolean;
	workspacesFetchedAt: number | null;
	selectedWorkspaceId: string | null;
	queue: QueueEntry[];
	/** The latest page capture this worker made or tried, for the panel's progress line. */
	capture: CaptureStatus | null;
}

export interface CaptureStatus {
	phase: 'preparing' | 'queued' | 'uploading' | 'done' | 'failed';
	/** Plain language, ready to show. */
	message: string;
	bundleId: string | null;
	progress: { sent: number; total: number } | null;
	at: number;
}

export type Reply =
	| { ok: true; state: PanelState; note?: string }
	| { ok: false; error: string; message: string; state?: PanelState };

/** Broadcast by the service worker when anything in PanelState may have changed. */
export const CHANGED = 'oc.changed';

/** The context-menu click, as the panel reads it from storage.session. */
export const PENDING_SELECTION = 'pendingSelection';

export interface PendingSelection {
	text: string;
	url: string;
	title: string;
	tabId: number | null;
	at: number;
}

/**
 * What page capture asks for, together, the first time: reading any page (<all_urls>)
 * and saving it (pageCapture). Both are optional in the manifest, so nothing is granted
 * at install.
 */
export const CAPTURE_PERMISSIONS: chrome.permissions.Permissions = {
	permissions: ['pageCapture'],
	origins: ['<all_urls>'],
};
