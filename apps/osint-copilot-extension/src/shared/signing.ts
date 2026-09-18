// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The byte-exact strings the extension signs and checks, over WebCrypto.
 *
 * Each construction is fixed by PROTOCOL.md and pinned by protocol-vectors.json, which an
 * independent Python implementation generated; the tests reproduce every one of them. Keys
 * are raw bytes, strings are UTF-8, and nonces, ids and digests appear as their wire text.
 */
import { fromB64url, toB64url, toHex } from './b64url';

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
	return encoder.encode(text);
}

export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
	return toHex(await sha256(typeof data === 'string' ? utf8(data) : data));
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function importHmacKey(key: Uint8Array): Promise<CryptoKey> {
	// A copy, so the CryptoKey never aliases a buffer someone later zeroes or reuses.
	return crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
	const k = await importHmacKey(key);
	return new Uint8Array(await crypto.subtle.sign('HMAC', k, utf8(message)));
}

export async function hmacB64url(key: Uint8Array, message: string): Promise<string> {
	return toB64url(await hmac(key, message));
}

/**
 * Checks a base64url MAC. subtle.verify compares in constant time, so a timing side
 * channel cannot walk a forger toward a valid signature one byte at a time.
 */
export async function verifyMac(key: Uint8Array, message: string, macB64url: unknown): Promise<boolean> {
	if (typeof macB64url !== 'string') return false;
	const given = fromB64url(macB64url);
	if (!given || given.length !== 32) return false;
	const k = await importHmacKey(key);
	return crypto.subtle.verify('HMAC', k, new Uint8Array(given), utf8(message));
}

// --- strings to sign -----------------------------------------------------------------

export interface RequestSigningParts {
	endpoint: string;
	method: string;
	pathWithQuery: string;
	ts: string;
	nonce: string;
	clientId: string;
	contentLength: string;
	bodySha256: string;
}

export function requestStringToSign(p: RequestSigningParts): string {
	return ['OC1', p.endpoint, p.method, p.pathWithQuery, p.ts, p.nonce, p.clientId, p.contentLength, p.bodySha256].join('\n');
}

export function responseStringToSign(endpoint: string, status: number, requestNonce: string, bodySha256: string): string {
	return ['OC1R', endpoint, String(status), requestNonce, bodySha256].join('\n');
}

export function pairProofString(clientNonce: string): string {
	return `OCPAIR1\n${clientNonce}`;
}

export function pairServerProofString(clientNonce: string, serverNonce: string, clientId: string): string {
	return `OCPAIR1S\n${clientNonce}\n${serverNonce}\n${clientId}`;
}

export function keyDerivationString(clientNonce: string, serverNonce: string, clientId: string): string {
	return `oc-k1\n${clientNonce}\n${serverNonce}\n${clientId}`;
}

export function helloProofString(endpoint: string, clientNonce: string, serverNonce: string, instanceId: string): string {
	return `OCHELLO1\n${endpoint}\n${clientNonce}\n${serverNonce}\n${instanceId}`;
}

/** The first 32 hex characters of sha256(pairSecret): names the pairing without revealing it. */
export async function pairingIdFor(pairSecret: Uint8Array<ArrayBuffer>): Promise<string> {
	return (await sha256Hex(pairSecret)).slice(0, 32);
}
