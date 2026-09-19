// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Synchronous SHA-256 and Keccak-256 for the wallet checksums in validate.ts.
 *
 * WebCrypto has SHA-256 but only asynchronously, and no Keccak at all (Ethereum's EIP-55
 * uses the original Keccak padding, 0x01, which FIPS SHA3-256 does not). The side panel
 * reclassifies as the user types, so these run synchronously on a few dozen bytes;
 * clarity wins over speed. Nothing here is used for authentication: the protocol's MACs
 * go through WebCrypto (signing.ts).
 */

// --- SHA-256 (FIPS 180-4) ------------------------------------------------------------

const K256 = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
	return (x >>> n) | (x << (32 - n));
}

export function sha256Sync(data: Uint8Array): Uint8Array {
	const bitLength = data.length * 8;
	const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
	padded.set(data);
	padded[data.length] = 0x80;
	const view = new DataView(padded.buffer);
	// Messages here are tiny; the high 32 bits of the length are always zero.
	view.setUint32(padded.length - 4, bitLength >>> 0);
	view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));

	const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const w = new Uint32Array(64);
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 64; i++) {
			const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
			const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		h[0] += a; h[1] += b; h[2] += c; h[3] += d;
		h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
	}
	const out = new Uint8Array(32);
	const outView = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
	return out;
}

// --- Keccak-256 (original padding) ---------------------------------------------------

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS: readonly bigint[] = [
	0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
	0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
	0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
	0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
	0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
	0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rotation offsets, indexed x + 5y. */
const ROTATIONS: readonly number[] = [
	0, 1, 62, 28, 27,
	36, 44, 6, 55, 20,
	3, 10, 43, 25, 39,
	41, 45, 15, 21, 8,
	18, 2, 61, 56, 14,
];

function rotl64(lane: bigint, n: number): bigint {
	if (n === 0) return lane;
	const s = BigInt(n);
	return ((lane << s) | (lane >> (64n - s))) & MASK;
}

function keccakF(a: bigint[]): void {
	const c = new Array<bigint>(5);
	const b = new Array<bigint>(25);
	for (let round = 0; round < 24; round++) {
		for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
		for (let x = 0; x < 5; x++) {
			const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
			for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
		}
		for (let x = 0; x < 5; x++) {
			for (let y = 0; y < 5; y++) {
				b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(a[x + 5 * y], ROTATIONS[x + 5 * y]);
			}
		}
		for (let y = 0; y < 25; y += 5) {
			for (let x = 0; x < 5; x++) {
				a[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
			}
		}
		a[0] ^= ROUND_CONSTANTS[round];
	}
}

const RATE_BYTES = 136;

export function keccak256(data: Uint8Array): Uint8Array {
	const padded = new Uint8Array((Math.floor(data.length / RATE_BYTES) + 1) * RATE_BYTES);
	padded.set(data);
	padded[data.length] ^= 0x01;
	padded[padded.length - 1] ^= 0x80;
	const view = new DataView(padded.buffer);

	const state = new Array<bigint>(25).fill(0n);
	for (let off = 0; off < padded.length; off += RATE_BYTES) {
		for (let i = 0; i < RATE_BYTES / 8; i++) state[i] ^= view.getBigUint64(off + i * 8, true);
		keccakF(state);
	}
	const out = new Uint8Array(32);
	const outView = new DataView(out.buffer);
	for (let i = 0; i < 4; i++) outView.setBigUint64(i * 8, state[i], true);
	return out;
}
