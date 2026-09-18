// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The app's acceptance rules (PROTOCOL.md §8), applied before an item is queued.
 *
 * The app validates again and is the authority. Checking here as well means an item the
 * app would refuse is refused in the side panel, where the investigator can still fix it,
 * rather than sitting in the queue as a failure after the page is gone. The shared
 * entity-vectors.json pins both implementations to the same verdicts and the same detail
 * strings. The rule is the app's: reject rather than repair. The only rewriting is removal
 * of control, separator and bidi characters, and of URL credentials.
 */
import { domainToAscii, isIpAddress, normalisePageUrl, isHttpUrl } from './url';
import { keccak256, sha256Sync } from './hashes';
import { toHex } from './b64url';
import {
	ENTITY_KINDS,
	LIMITS,
	PLATFORM,
	WALLET_CHAINS,
	WORKSPACE_ID,
	type EntityKind,
	type EntityPayload,
	type Manifest,
	type WalletChain,
} from './protocol';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; detail: string };

/** Every kind the protocol names; this version sends only the first two. */
const ALL_KINDS = ['note', 'entity', 'capture', 'highlight', 'highlight.update', 'highlight.delete'] as const;
const SUPPORTED_KINDS = ['note', 'entity'] as const;
export const KIND_NOT_SUPPORTED = 'kind not supported by this app version';

class Invalid extends Error {
	constructor(readonly detail: string) {
		super(detail);
	}
}

function fail(path: string, reason: string): never {
	throw new Invalid(`${path}: ${reason}`);
}

// --- text ----------------------------------------------------------------------------

/** C0, DEL, C1, U+2028/2029, and the bidi embeddings, overrides and isolates. */
const SINGLE_LINE_STRIP = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/** The same set less \n. */
const MULTI_LINE_STRIP = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function stripControlChars(text: string): string {
	return text.replace(SINGLE_LINE_STRIP, '');
}

export function stripControlCharsMultiline(text: string): string {
	return text.replace(/\r\n?/g, '\n').replace(MULTI_LINE_STRIP, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(obj: Record<string, unknown>, path: string, allowed: readonly string[]): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) fail(path ? `${path}.${key}` : key, 'unknown field');
	}
}

function text(value: unknown, path: string, max: number, opts: { multiline?: boolean; allowEmpty?: boolean } = {}): string {
	if (typeof value !== 'string') fail(path, 'must be a string');
	const cleaned = (opts.multiline ? stripControlCharsMultiline(value) : stripControlChars(value)).trim();
	if (!cleaned && !opts.allowEmpty) fail(path, 'must not be empty');
	if (cleaned.length > max) fail(path, `longer than ${max} characters`);
	return cleaned;
}

// --- wallets -------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_VERSIONS = new Set([0x00, 0x05, 0x6f, 0xc4]);

function base58Decode(value: string): Uint8Array | null {
	let n = 0n;
	for (const ch of value) {
		const digit = BASE58_ALPHABET.indexOf(ch);
		if (digit < 0) return null;
		n = n * 58n + BigInt(digit);
	}
	const bytes: number[] = [];
	while (n > 0n) {
		bytes.unshift(Number(n & 0xffn));
		n >>= 8n;
	}
	for (let i = 0; i < value.length && value[i] === '1'; i++) bytes.unshift(0);
	return new Uint8Array(bytes);
}

/** Legacy P2PKH/P2SH: version byte + hash160 + 4 bytes of double SHA-256. */
function isValidBase58Check(address: string): boolean {
	if (address.length < 26 || address.length > 35) return false;
	const bytes = base58Decode(address);
	if (!bytes || bytes.length !== 25 || !BASE58_VERSIONS.has(bytes[0])) return false;
	const checksum = sha256Sync(sha256Sync(bytes.subarray(0, 21))).subarray(0, 4);
	return checksum.every((b, i) => b === bytes[21 + i]);
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
	let chk = 1;
	for (const v of values) {
		const top = chk >>> 25;
		chk = ((chk & 0x1ffffff) << 5) ^ v;
		for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
	}
	return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
	const out: number[] = [];
	for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
	out.push(0);
	for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
	return out;
}

function convertBits(data: number[], from: number, to: number): number[] | null {
	let acc = 0;
	let bits = 0;
	const out: number[] = [];
	const maxv = (1 << to) - 1;
	for (const value of data) {
		acc = (acc << from) | value;
		bits += from;
		while (bits >= to) {
			bits -= to;
			out.push((acc >>> bits) & maxv);
		}
	}
	if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
	return out;
}

/**
 * SegWit (BIP-173/350), hrp bc or tb. v0 must carry the bech32 constant and a 20- or
 * 32-byte program; v1+ must carry bech32m, which exists because v0's checksum let a
 * mutated v1 address through.
 */
function isValidSegwitAddress(address: string): boolean {
	if (address.length > 90) return false;
	if (address !== address.toLowerCase() && address !== address.toUpperCase()) return false;
	const lower = address.toLowerCase();
	const sep = lower.lastIndexOf('1');
	if (sep < 1 || sep + 7 > lower.length) return false;
	const hrp = lower.slice(0, sep);
	if (hrp !== 'bc' && hrp !== 'tb') return false;
	const data: number[] = [];
	for (const ch of lower.slice(sep + 1)) {
		const v = BECH32_CHARSET.indexOf(ch);
		if (v < 0) return false;
		data.push(v);
	}
	const witnessVersion = data[0];
	if (witnessVersion > 16) return false;
	const expected = witnessVersion === 0 ? BECH32_CONST : BECH32M_CONST;
	if (polymod([...hrpExpand(hrp), ...data]) !== expected) return false;
	const program = convertBits(data.slice(1, -6), 5, 8);
	if (!program || program.length < 2 || program.length > 40) return false;
	return witnessVersion !== 0 || program.length === 20 || program.length === 32;
}

export function isValidBtcAddress(address: string): boolean {
	return isValidBase58Check(address) || isValidSegwitAddress(address);
}

/** Single-case addresses claim no checksum; a mixed-case one must match EIP-55. */
export function isValidEthAddress(address: string): boolean {
	if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
	const body = address.slice(2);
	const lower = body.toLowerCase();
	if (body === lower || body === body.toUpperCase()) return true;
	const hash = toHex(keccak256(new TextEncoder().encode(lower)));
	for (let i = 0; i < 40; i++) {
		const upper = parseInt(hash[i], 16) >= 8;
		if (/[a-f]/i.test(body[i]) && (body[i] === body[i].toUpperCase()) !== upper) return false;
	}
	return true;
}

// --- entities ------------------------------------------------------------------------

export function isEmail(value: string): boolean {
	if (/\s/.test(value)) return false;
	const parts = value.split('@');
	if (parts.length !== 2 || !parts[0]) return false;
	const domain = parts[1];
	return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

export function isDomain(value: string): boolean {
	// Anything URL-shaped belongs to the url kind; the host parser would quietly drop a path.
	if (/[\s/\\?#@:]/.test(value)) return false;
	const ascii = domainToAscii(value);
	if (!ascii || !ascii.includes('.') || ascii.length > 253) return false;
	const labels = ascii.replace(/\.$/, '').split('.');
	return labels.length > 1 && labels.every(l => l.length > 0 && l.length <= 63);
}

export function isPhone(value: string): boolean {
	if (!/^\+?[0-9 ().-]+$/.test(value)) return false;
	const digits = value.replace(/\D/g, '').length;
	return digits >= 4 && digits <= 20;
}

function isWallet(value: string, chain: WalletChain): boolean {
	switch (chain) {
		case 'btc': return isValidBtcAddress(value);
		case 'eth': return isValidEthAddress(value);
		case 'other': return /^[A-Za-z0-9:_-]{8,128}$/.test(value);
	}
}

/** Null when `value` passes the check for `kind`, else the reason, worded as the app's. */
export function checkEntityValue(kind: EntityKind, value: string, chain?: WalletChain): string | null {
	switch (kind) {
		case 'email': return isEmail(value) ? null : 'not an email address';
		case 'domain': return isDomain(value) ? null : 'not a domain name';
		case 'url': return isHttpUrl(value) ? null : 'not an http(s) URL';
		case 'ip': return isIpAddress(value) ? null : 'not an IPv4 or IPv6 address';
		case 'phone': return isPhone(value) ? null : 'not a phone number (4-20 digits, optional leading +)';
		case 'username': return value.length <= 64 && !/\s/.test(value) ? null : 'not a username (1-64 characters, no spaces)';
		case 'wallet':
			if (!chain) return 'wallet needs a chain';
			return isWallet(value, chain) ? null : `not a valid ${chain} address`;
	}
}

function entity(value: unknown): EntityPayload {
	if (!isRecord(value)) fail('entity', 'must be an object');
	onlyKeys(value, 'entity', ['kind', 'value', 'chain', 'platform', 'context']);

	const kind = value.kind;
	if (typeof kind !== 'string' || !(ENTITY_KINDS as readonly string[]).includes(kind)) {
		fail('entity.kind', `must be one of ${ENTITY_KINDS.join(', ')}`);
	}
	const out: EntityPayload = { kind: kind as EntityKind, value: text(value.value, 'entity.value', LIMITS.entityValue) };

	if (value.chain !== undefined) {
		if (out.kind !== 'wallet') fail('entity.chain', 'only allowed for wallets');
		if (typeof value.chain !== 'string' || !(WALLET_CHAINS as readonly string[]).includes(value.chain)) {
			fail('entity.chain', `must be one of ${WALLET_CHAINS.join(', ')}`);
		}
		out.chain = value.chain as WalletChain;
	} else if (out.kind === 'wallet') {
		fail('entity.chain', 'required for wallets');
	}

	if (value.platform !== undefined) {
		if (out.kind !== 'username') fail('entity.platform', 'only allowed for usernames');
		if (typeof value.platform !== 'string' || !PLATFORM.test(value.platform)) {
			fail('entity.platform', 'must be 1-40 characters of a-z 0-9 . -');
		}
		out.platform = value.platform;
	}

	if (value.context !== undefined) {
		out.context = text(value.context, 'entity.context', LIMITS.entityContext, { allowEmpty: true });
	}

	const problem = checkEntityValue(out.kind, out.value, out.chain);
	if (problem) fail('entity.value', problem);
	return out;
}

// --- manifest ------------------------------------------------------------------------

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function manifest(value: unknown): Manifest {
	if (!isRecord(value)) fail('manifest', 'must be a JSON object');
	if (value.v !== 1) fail('v', 'must be 1');

	if (typeof value.kind !== 'string' || !(ALL_KINDS as readonly string[]).includes(value.kind)) {
		fail('kind', `must be one of ${ALL_KINDS.join(', ')}`);
	}
	if (!(SUPPORTED_KINDS as readonly string[]).includes(value.kind)) throw new Invalid(KIND_NOT_SUPPORTED);
	const kind = value.kind as Manifest['kind'];
	onlyKeys(value, '', ['v', 'bundleId', 'workspaceId', 'kind', 'page', 'clientTime', kind]);

	if (typeof value.bundleId !== 'string' || !UUID_V4.test(value.bundleId.toLowerCase())) fail('bundleId', 'must be a UUID v4');
	if (typeof value.workspaceId !== 'string' || !WORKSPACE_ID.test(value.workspaceId)) {
		fail('workspaceId', 'must be a workspace id from /v1/workspaces');
	}

	if (!isRecord(value.page)) fail('page', 'must be an object');
	onlyKeys(value.page, 'page', ['url', 'title']);
	if (typeof value.page.url !== 'string') fail('page.url', 'must be a string');
	const rawUrl = stripControlChars(value.page.url).trim();
	if (rawUrl.length > LIMITS.pageUrl) fail('page.url', `longer than ${LIMITS.pageUrl} characters`);
	const url = normalisePageUrl(rawUrl);
	if (!url) fail('page.url', 'must be an http(s) URL');
	if (url.length > LIMITS.pageUrl) fail('page.url', `longer than ${LIMITS.pageUrl} characters`);
	const title = text(value.page.title, 'page.title', LIMITS.pageTitle, { allowEmpty: true });

	const clientTime = text(value.clientTime, 'clientTime', LIMITS.clientTime);
	if (!ISO_TIME.test(clientTime) || Number.isNaN(Date.parse(clientTime))) fail('clientTime', 'must be an ISO 8601 time');

	const base = {
		v: 1 as const,
		bundleId: value.bundleId.toLowerCase(),
		workspaceId: value.workspaceId,
		page: { url, title },
		clientTime,
	};

	if (kind === 'note') {
		const note = value.note;
		if (!isRecord(note)) fail('note', 'must be an object');
		onlyKeys(note, 'note', ['text']);
		return { ...base, kind, note: { text: text(note.text, 'note.text', LIMITS.noteText, { multiline: true }) } };
	}
	return { ...base, kind, entity: entity(value.entity) };
}

function run<T>(fn: () => T): ValidationResult<T> {
	try {
		return { ok: true, value: fn() };
	} catch (err) {
		if (err instanceof Invalid) return { ok: false, detail: err.detail };
		throw err;
	}
}

export function validateManifest(value: unknown): ValidationResult<Manifest> {
	return run(() => manifest(value));
}

export function validateEntity(value: unknown): ValidationResult<EntityPayload> {
	return run(() => entity(value));
}
