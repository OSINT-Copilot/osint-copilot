// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The app's shared test vectors, read in place so there is exactly one copy: a change on
 * the app side that the extension does not follow fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = new URL('../../tangent-electron/src/main/osint/extension/vectors/', import.meta.url);

function load(name: string): any {
	return JSON.parse(readFileSync(fileURLToPath(new URL(name, dir)), 'utf8'));
}

export const protocolVectors = load('protocol-vectors.json');
export const entityVectors = load('entity-vectors.json') as {
	entities: { note: string; entity: Record<string, unknown>; expect: 'accept' | 'reject'; value?: string }[];
	manifests: { note: string; manifest: Record<string, unknown>; expect: 'accept' | 'reject'; detail?: string; url?: string; text?: string; bundleId?: string }[];
};

/** A vector's hex field as bytes; null for anything but whole bytes of hex. */
export function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
	if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}
