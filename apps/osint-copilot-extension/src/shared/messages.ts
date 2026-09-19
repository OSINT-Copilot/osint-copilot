// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Messages between the side panel and the service worker.
 *
 * The service worker is the only part that holds the key or touches the network; the
 * panel asks it for things. Nothing in a reply is secret: no key, no clientId, no port.
 */
import type { EntityPayload, ManifestPage, WorkspaceInfo } from './protocol';
import type { HighlightList } from '../sw/highlights';

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
	| { type: 'capture'; tabId: number; workspaceId?: string }
	/** The highlights on the tab's page, in the chosen investigation. */
	| { type: 'highlights'; tabId: number }
	/** Highlights the selection in the tab. */
	| { type: 'highlight.create'; tabId: number; workspaceId?: string }
	| { type: 'highlight.note'; tabId: number; id: string; note: string }
	| { type: 'highlight.delete'; tabId: number; id: string }
	| { type: 'highlight.findAgain'; tabId: number; id: string }
	| { type: 'highlight.show'; tabId: number; id: string }
	/** Shows the page's highlights, for the tab's address as it is now: the investigator asked. */
	| { type: 'highlight.showHere'; tabId: number }
	/**
	 * Allows or stops showing highlights again on a revisit. The panel asks Chrome for the
	 * permission itself, from the button's click; the worker only records the choice.
	 */
	| { type: 'highlights.revisit'; allow: boolean }
	/** Deletes every highlight kept in this browser; the investigations keep theirs. */
	| { type: 'highlights.clearLocal' };

export const PANEL_REQUEST_TYPES: readonly PanelRequest['type'][] = [
	'state', 'panelOpened', 'refresh', 'pair', 'unpair', 'selectWorkspace', 'send', 'queue.retry', 'queue.delete', 'capture',
	'highlights', 'highlight.create', 'highlight.note', 'highlight.delete', 'highlight.findAgain', 'highlight.show',
	'highlight.showHere', 'highlights.revisit', 'highlights.clearLocal',
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
	/** Highlights are shown again on a revisit: allowed in the panel, and the permission granted. */
	revisitHighlights: boolean;
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
	| { ok: true; state: PanelState; note?: string; highlights?: HighlightList }
	| { ok: false; error: string; message: string; state?: PanelState };

/** Broadcast by the service worker when anything in PanelState may have changed. */
export const CHANGED = 'oc.changed';

/** Broadcast when the investigator clicks a highlight on a page: {type, tabId, id}. */
export const HIGHLIGHT_CLICKED = 'oc.highlightClicked';

/**
 * Reading pages, for highlights on a revisit, asked for from the panel. Page capture asks
 * for it too; granting it for capture does not turn revisits on.
 */
export const HIGHLIGHT_PERMISSIONS: chrome.permissions.Permissions = { origins: ['<all_urls>'] };

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
