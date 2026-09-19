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
	CAPTURE_FILE_CAPS,
	CAPTURE_FILE_NAMES,
	ENTITY_KINDS,
	REQUIRED_CAPTURE_FILE,
	SHA256_HEX,
	type CaptureFileDecl,
	type CaptureFiles,
	LIMITS,
	PLATFORM,
	WALLET_CHAINS,
	WORKSPACE_ID,
	type EntityKind,
	type EntityPayload,
	type HighlightAnnotation,
	type Manifest,
	type RangeSelector,
	type TextQuoteSelector,
	type WalletChain,
	type XPathPoint,
} from './protocol';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; detail: string };

/** Every kind the protocol names, all of which this version sends. */
const ALL_KINDS = ['note', 'entity', 'capture', 'highlight', 'highlight.update', 'highlight.delete'] as const;
const SUPPORTED_KINDS = ALL_KINDS;
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

// --- captures ------------------------------------------------------------------------

function captureFile(value: unknown, path: string, cap: number): CaptureFileDecl {
	if (!isRecord(value)) fail(path, 'must be an object');
	onlyKeys(value, path, ['size', 'sha256']);
	const size = value.size;
	if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) fail(`${path}.size`, 'must be a whole number of bytes, at least 1');
	if (size > cap) fail(`${path}.size`, `larger than ${cap} bytes`);
	if (typeof value.sha256 !== 'string' || !SHA256_HEX.test(value.sha256)) fail(`${path}.sha256`, 'must be 64 lowercase hex characters');
	return { size, sha256: value.sha256 };
}

/** The files a capture declares before sending them (§8.3), in the app's fixed order. */
function capture(value: unknown): { files: CaptureFiles } {
	if (!isRecord(value)) fail('capture', 'must be an object');
	onlyKeys(value, 'capture', ['files']);
	const files = value.files;
	if (!isRecord(files)) fail('capture.files', 'must be an object');
	onlyKeys(files, 'capture.files', CAPTURE_FILE_NAMES);
	if (files[REQUIRED_CAPTURE_FILE] === undefined) fail(`capture.files.${REQUIRED_CAPTURE_FILE}`, 'required');
	const out: Partial<CaptureFiles> = {};
	for (const name of CAPTURE_FILE_NAMES) {
		if (files[name] === undefined) continue;
		out[name] = captureFile(files[name], `capture.files.${name}`, CAPTURE_FILE_CAPS[name]);
	}
	return { files: out as CaptureFiles };
}

// --- times and ids -------------------------------------------------------------------

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isoTime(value: unknown, path: string): string {
	const time = text(value, path, LIMITS.clientTime);
	if (!ISO_TIME.test(time) || Number.isNaN(Date.parse(time))) fail(path, 'must be an ISO 8601 time');
	return time;
}

// --- highlights (§8.4) ---------------------------------------------------------------

/** An element path: `/html[1]/body[1]/div[3]`, elements only. */
const XPATH = /^(\/[A-Za-z][A-Za-z0-9._-]*\[[1-9][0-9]{0,5}\])+$/;

function annotationId(value: unknown, path: string): string {
	if (typeof value !== 'string') fail(path, 'must be a string');
	const lower = value.toLowerCase();
	if (!lower.startsWith('urn:uuid:') || !UUID_V4.test(lower.slice('urn:uuid:'.length))) {
		fail(path, 'must be urn:uuid: and a UUID v4');
	}
	return lower;
}

function offset(value: unknown, path: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(path, 'must be a whole number, at least 0');
	return value;
}

/** Page text, checked but never cleaned: it must match the page to the code unit. */
function pageText(value: unknown, path: string, max: number, opts: { allowEmpty?: boolean } = {}): string {
	if (typeof value !== 'string') fail(path, 'must be a string');
	if (!opts.allowEmpty && !value.trim()) fail(path, 'must not be empty or only whitespace');
	if (value.length > max) fail(path, `longer than ${max} characters`);
	return value;
}

function onlyType(obj: Record<string, unknown>, path: string, type: string): void {
	if (obj.type !== type) fail(`${path}.type`, `must be ${type}`);
}

function positionSelector(value: unknown, path: string): { type: 'TextPositionSelector'; start: number; end: number } {
	if (!isRecord(value)) fail(path, 'must be an object');
	onlyKeys(value, path, ['type', 'start', 'end']);
	onlyType(value, path, 'TextPositionSelector');
	return { type: 'TextPositionSelector', start: offset(value.start, `${path}.start`), end: offset(value.end, `${path}.end`) };
}

function xpathPoint(value: unknown, path: string): XPathPoint {
	if (!isRecord(value)) fail(path, 'must be an object');
	onlyKeys(value, path, ['type', 'value', 'refinedBy']);
	onlyType(value, path, 'XPathSelector');
	if (typeof value.value !== 'string' || value.value.length > LIMITS.xpath || !XPATH.test(value.value)) {
		fail(`${path}.value`, `must be an element path such as /html[1]/body[1]/p[2], at most ${LIMITS.xpath} characters`);
	}
	const refinedBy = positionSelector(value.refinedBy, `${path}.refinedBy`);
	if (refinedBy.start !== refinedBy.end) fail(`${path}.refinedBy`, 'must be a point (start equal to end)');
	return { type: 'XPathSelector', value: value.value, refinedBy };
}

function selectors(value: unknown): HighlightAnnotation['target']['selector'] {
	const path = 'highlight.annotation.target.selector';
	if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
		fail(path, 'must be [TextQuoteSelector, TextPositionSelector] with an optional RangeSelector after them');
	}
	const q = value[0];
	const qPath = `${path}[0]`;
	if (!isRecord(q)) fail(qPath, 'must be an object');
	onlyKeys(q, qPath, ['type', 'exact', 'prefix', 'suffix']);
	onlyType(q, qPath, 'TextQuoteSelector');
	const quote: TextQuoteSelector = {
		type: 'TextQuoteSelector',
		exact: pageText(q.exact, `${qPath}.exact`, LIMITS.quoteExact),
		prefix: pageText(q.prefix, `${qPath}.prefix`, LIMITS.quoteContext, { allowEmpty: true }),
		suffix: pageText(q.suffix, `${qPath}.suffix`, LIMITS.quoteContext, { allowEmpty: true }),
	};
	const position = positionSelector(value[1], `${path}[1]`);
	if (position.end - position.start !== quote.exact.length) {
		fail(`${path}[1]`, 'end - start must equal the length of the quote');
	}
	if (value.length === 2) return [quote, position];
	const r = value[2];
	const rPath = `${path}[2]`;
	if (!isRecord(r)) fail(rPath, 'must be an object');
	onlyKeys(r, rPath, ['type', 'startSelector', 'endSelector']);
	onlyType(r, rPath, 'RangeSelector');
	const range: RangeSelector = {
		type: 'RangeSelector',
		startSelector: xpathPoint(r.startSelector, `${rPath}.startSelector`),
		endSelector: xpathPoint(r.endSelector, `${rPath}.endSelector`),
	};
	return [quote, position, range];
}

function annotation(value: unknown): HighlightAnnotation {
	const path = 'highlight.annotation';
	if (!isRecord(value)) fail(path, 'must be an object');
	onlyKeys(value, path, ['id', 'textModel', 'created', 'modified', 'target', 'body']);
	if (value.textModel !== 'v1') fail(`${path}.textModel`, 'must be v1');
	const target = value.target;
	if (!isRecord(target)) fail(`${path}.target`, 'must be an object');
	onlyKeys(target, `${path}.target`, ['source', 'selector']);
	if (typeof target.source !== 'string') fail(`${path}.target.source`, 'must be a string');
	const source = normalisePageUrl(stripControlChars(target.source).trim());
	if (!source) fail(`${path}.target.source`, 'must be an http(s) URL');
	const sourceUrl = new URL(source);
	sourceUrl.hash = '';
	if (sourceUrl.href.length > LIMITS.pageUrl) fail(`${path}.target.source`, `longer than ${LIMITS.pageUrl} characters`);
	const created = isoTime(value.created, `${path}.created`);
	const modified = isoTime(value.modified, `${path}.modified`);
	if (Date.parse(modified) < Date.parse(created)) fail(`${path}.modified`, 'earlier than created');
	const out: HighlightAnnotation = {
		id: annotationId(value.id, `${path}.id`),
		textModel: 'v1',
		created,
		modified,
		target: { source: sourceUrl.href, selector: selectors(target.selector) },
	};
	if (value.body !== undefined) {
		const body = value.body;
		if (!isRecord(body)) fail(`${path}.body`, 'must be an object');
		onlyKeys(body, `${path}.body`, ['type', 'purpose', 'value']);
		onlyType(body, `${path}.body`, 'TextualBody');
		if (body.purpose !== 'commenting') fail(`${path}.body.purpose`, 'must be commenting');
		out.body = {
			type: 'TextualBody',
			purpose: 'commenting',
			value: text(body.value, `${path}.body.value`, LIMITS.highlightNote, { multiline: true }),
		};
	}
	return out;
}

function highlightDelete(value: unknown): { annotationId: string; modified: string } {
	if (!isRecord(value)) fail('highlight', 'must be an object');
	onlyKeys(value, 'highlight', ['annotationId', 'modified']);
	return {
		annotationId: annotationId(value.annotationId, 'highlight.annotationId'),
		modified: isoTime(value.modified, 'highlight.modified'),
	};
}

// --- manifest ------------------------------------------------------------------------

function manifest(value: unknown): Manifest {
	if (!isRecord(value)) fail('manifest', 'must be a JSON object');
	if (value.v !== 1) fail('v', 'must be 1');

	if (typeof value.kind !== 'string' || !(ALL_KINDS as readonly string[]).includes(value.kind)) {
		fail('kind', `must be one of ${ALL_KINDS.join(', ')}`);
	}
	if (!(SUPPORTED_KINDS as readonly string[]).includes(value.kind)) throw new Invalid(KIND_NOT_SUPPORTED);
	const kind = value.kind as Manifest['kind'];
	// Every highlight kind carries its payload under `highlight`.
	const payloadKey = kind.startsWith('highlight') ? 'highlight' : kind;
	onlyKeys(value, '', ['v', 'bundleId', 'workspaceId', 'kind', 'page', 'clientTime', payloadKey]);

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

	const clientTime = isoTime(value.clientTime, 'clientTime');

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
	if (kind === 'capture') return { ...base, kind, capture: capture(value.capture) };
	if (kind === 'highlight.delete') return { ...base, kind, highlight: highlightDelete(value.highlight) };
	if (kind === 'highlight' || kind === 'highlight.update') {
		const h = value.highlight;
		if (!isRecord(h)) fail('highlight', 'must be an object');
		onlyKeys(h, 'highlight', ['annotation']);
		const a = annotation(h.annotation);
		const pageUrl = new URL(url);
		pageUrl.hash = '';
		if (pageUrl.href !== a.target.source) fail('highlight.annotation.target.source', 'must be page.url without its fragment');
		return { ...base, kind, highlight: { annotation: a } };
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
