// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * base64url without padding (PROTOCOL.md §3), and bytes as lowercase hex.
 *
 * Hand-rolled rather than via atob/btoa so that decoding is strict: padding, the standard
 * alphabet's '+' and '/', and non-canonical trailing bits are all refused, and one byte
 * string has exactly one textual form -- the property the app's decoder has too.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = new Map([...ALPHABET].map((ch, i) => [ch, i]));

export function toB64url(bytes: Uint8Array): string {
	let out = '';
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
		out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
	}
	const rest = bytes.length - i;
	if (rest === 1) {
		const n = bytes[i] << 16;
		out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63];
	} else if (rest === 2) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
		out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
	}
	return out;
}

/** Null for anything but canonical, unpadded base64url. */
export function fromB64url(text: string): Uint8Array<ArrayBuffer> | null {
	if (typeof text !== 'string' || text.length % 4 === 1) return null;
	const out = new Uint8Array(Math.floor((text.length * 6) / 8));
	let acc = 0;
	let bits = 0;
	let o = 0;
	for (const ch of text) {
		const v = LOOKUP.get(ch);
		if (v === undefined) return null;
		acc = ((acc << 6) | v) & 0xffffff;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[o++] = (acc >> bits) & 0xff;
		}
	}
	// Leftover bits must be zero, or two texts would decode to one byte string.
	if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
	return out;
}

export function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}
