// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import type { KV } from '../src/sw/storage';

/** A Map-backed KV standing in for chrome.storage.local. */
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
