// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * chrome.storage.local, behind a small interface the channel and the tests share.
 *
 * The pairing record (clientId and the key K) lives only here: never in storage.sync,
 * which would copy it to every browser the user signs into, and never in storage.session
 * or a message a content script can receive. restrictToTrustedContexts() pins
 * storage.local to extension pages and the service worker, so a content script (which
 * runs beside hostile page code) cannot read it even if a later phase adds one.
 */
import type { WorkspaceInfo } from '../shared/protocol';

export interface KV {
	get<T>(key: string): Promise<T | undefined>;
	set(values: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
}

export const KEYS = {
	pairing: 'pairing',
	workspaces: 'workspaces',
	selectedWorkspace: 'selectedWorkspaceId',
} as const;

/** What pairing leaves behind. pairSecret is not in it: it is discarded once K is derived. */
export interface PairingRecord {
	clientId: string;
	/** K, base64url of 32 raw bytes. */
	key: string;
	instanceId: string;
	/** The port hello last verified, else the one from the pairing string. */
	port: number;
	/** The port the pairing string named, tried second during discovery. */
	pairingPort: number;
	pairedAt: number;
}

export interface WorkspaceCache {
	list: WorkspaceInfo[];
	fetchedAt: number;
}

export function chromeLocal(): KV {
	const area = chrome.storage.local;
	return {
		async get<T>(key: string) {
			const got = await area.get(key);
			return got[key] as T | undefined;
		},
		set: values => area.set(values),
		remove: keys => area.remove(keys),
	};
}

/**
 * Called once at service-worker start, before anything is stored. storage.local is open
 * to content scripts by default; this is what closes it. Phase 1 injects only the
 * one-line selection reader, but a failure here would leave K readable by any content
 * script a later phase adds, so it is logged rather than swallowed.
 */
export function restrictToTrustedContexts(): void {
	void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(err => {
		console.error('OSINT Copilot: could not restrict storage.local to trusted contexts', err);
	});
}

/** A Map-backed KV for tests and for anything that must not touch real storage. */
export function memoryKV(initial: Record<string, unknown> = {}): KV & { data: Map<string, unknown> } {
	const data = new Map(Object.entries(initial));
	return {
		data,
		async get<T>(key: string) {
			return structuredClone(data.get(key)) as T | undefined;
		},
		async set(values) {
			for (const [k, v] of Object.entries(values)) data.set(k, structuredClone(v));
		},
		async remove(keys) {
			for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
		},
	};
}
