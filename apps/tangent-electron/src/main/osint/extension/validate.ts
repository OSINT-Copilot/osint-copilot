/**
 * Acceptance checks for what the extension sends.
 *
 * Hand-written because neither zod nor ajv is a dependency. The rule throughout is
 * reject, don't repair: a field that is too long, the wrong type or fails its kind's
 * check comes back as 422 with the field's path, instead of being truncated or coerced
 * into something the investigator never selected. The only rewriting is removal of
 * characters that have no business in the vault -- control characters and line/paragraph
 * separators, which break front matter, and bidi embeddings, overrides and isolates, which
 * make text display as something other than what it is -- and URL credentials.
 * Zero-width characters stay: ZWJ and ZWNJ are part of emoji and of Persian and Indic
 * spelling, and removing them would change what the investigator selected.
 *
 * Validation only: identifier keys (lowercasing, punycode, digit-only phones) are the
 * renderer's job, via src/osint/services/entity-identifiers.ts, so there is one
 * definition of "the same entity".
 *
 * Passing here does not make a value safe to put anywhere. A username is any 1-64
 * non-space characters ('../../x', '[[Note]]', '---' and '|' all pass), and an email may
 * carry brackets and quotes. Whatever writes to the vault must never use entity.value (or
 * page.title, or context) as a path segment, or in wikilink or front-matter text without
 * the escaping those formats need.
 */
import * as net from 'net';
import { domainToASCII } from 'url';
import {
    ALL_KINDS,
    CAPTURE_FILE_CAPS,
    CAPTURE_FILE_NAMES,
    ENTITY_KINDS,
    REQUIRED_CAPTURE_FILE,
    SHA256_HEX,
    LIMITS,
    WALLET_CHAINS,
    type CaptureFileDecl,
    type CaptureFiles,
    type EntityKind,
    type EntityPayload,
    type HighlightAnnotation,
    type Manifest,
    type RangeSelector,
    type TextQuoteSelector,
    type WalletChain,
    type XPathPoint,
} from './protocol';
import { isValidEthAddress } from './keccak';
import { isValidBtcAddress } from './wallet-checks';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; detail: string };

class Invalid extends Error {
    constructor(readonly detail: string) {
        super(detail);
    }
}

function fail(path: string, reason: string): never {
    throw new Invalid(`${path}: ${reason}`);
}

// --- text ----------------------------------------------------------------------------

/**
 * C0, DEL, C1, U+2028/2029 (which JSON allows raw and YAML/JS treat as newlines), and the
 * bidi embeddings, overrides and isolates U+202A-202E and U+2066-2069.
 */
const SINGLE_LINE_STRIP = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/** The same set less \n. */
const MULTI_LINE_STRIP = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function stripControlChars(text: string): string {
    return text.replace(SINGLE_LINE_STRIP, '');
}

/** Keeps \n (after folding \r\n and lone \r into it); strips every other control character. */
export function stripControlCharsMultiline(text: string): string {
    return text.replace(/\r\n?/g, '\n').replace(MULTI_LINE_STRIP, '');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(obj: Record<string, unknown>, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(obj)) {
        if (!allowed.includes(key)) fail(path ? `${path}.${key}` : key, 'unknown field');
    }
}

function text(
    value: unknown,
    path: string,
    max: number,
    opts: { multiline?: boolean; allowEmpty?: boolean } = {},
): string {
    if (typeof value !== 'string') fail(path, 'must be a string');
    const cleaned = (opts.multiline ? stripControlCharsMultiline(value) : stripControlChars(value)).trim();
    if (!cleaned && !opts.allowEmpty) fail(path, 'must not be empty');
    if (cleaned.length > max) fail(path, `longer than ${max} characters`);
    return cleaned;
}

// --- URLs ----------------------------------------------------------------------------

/**
 * An http(s) URL with any username/password removed. Credentials in a page URL are
 * someone's login; they must not travel into a case file that gets shared.
 */
export function normalisePageUrl(raw: string): string | null {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    return url.href;
}

// --- entities ------------------------------------------------------------------------

function isEmail(value: string): boolean {
    if (/\s/.test(value)) return false;
    const parts = value.split('@');
    if (parts.length !== 2 || !parts[0]) return false;
    const domain = parts[1];
    return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

function isDomain(value: string): boolean {
    // domainToASCII quietly drops everything after a '/' or '?', so "a.com/x" would pass
    // as "a.com". Anything URL-shaped belongs to the url kind.
    if (/[\s/\\?#@:]/.test(value)) return false;
    const ascii = domainToASCII(value);
    if (!ascii || !ascii.includes('.') || ascii.length > 253) return false;
    const labels = ascii.replace(/\.$/, '').split('.');
    return labels.length > 1 && labels.every(l => l.length > 0 && l.length <= 63);
}

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function isPhone(value: string): boolean {
    // Separators people type; '+' only as the first character. Not a claim of valid E.164.
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

const PLATFORM = /^[a-z0-9.-]{1,40}$/;

/** Returns null when `value` passes the check for `kind`, else the reason. */
export function checkEntityValue(kind: EntityKind, value: string, chain?: WalletChain): string | null {
    switch (kind) {
        case 'email': return isEmail(value) ? null : 'not an email address';
        case 'domain': return isDomain(value) ? null : 'not a domain name';
        case 'url': return isHttpUrl(value) ? null : 'not an http(s) URL';
        // isIPv6 also takes a zone id ('fe80::1%eth0'), which names an interface on the
        // sender's machine, not an address.
        case 'ip': return net.isIPv4(value) || (net.isIPv6(value) && !value.includes('%')) ? null : 'not an IPv4 or IPv6 address';
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
    const out: EntityPayload = {
        kind: kind as EntityKind,
        value: text(value.value, 'entity.value', LIMITS.entityValue),
    };

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

/**
 * The files a capture declares up front. Declaring them is what lets the server reserve
 * their bytes against the budget before any arrive, and refuse an upload whose length or
 * digest differs from what was promised without reading it.
 */
function capture(value: unknown): { files: CaptureFiles } {
    if (!isRecord(value)) fail('capture', 'must be an object');
    onlyKeys(value, 'capture', ['files']);
    const files = value.files;
    if (!isRecord(files)) fail('capture.files', 'must be an object');
    onlyKeys(files, 'capture.files', CAPTURE_FILE_NAMES);
    if (files[REQUIRED_CAPTURE_FILE] === undefined) fail(`capture.files.${REQUIRED_CAPTURE_FILE}`, 'required');
    const out: Partial<CaptureFiles> = {};
    // In the fixed order, so the cleaned form (and its canonical JSON) does not depend on
    // the order the extension wrote them in.
    for (const name of CAPTURE_FILE_NAMES) {
        if (files[name] === undefined) continue;
        out[name] = captureFile(files[name], `capture.files.${name}`, CAPTURE_FILE_CAPS[name]);
    }
    return { files: out as CaptureFiles };
}

// --- times and ids -------------------------------------------------------------------

/** An ISO 8601 date-time with a zone, as toISOString writes it; Date.parse alone takes '1' or 'March 7'. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{22}$/;

function isoTime(value: unknown, path: string): string {
    const time = text(value, path, LIMITS.clientTime);
    if (!ISO_TIME.test(time) || Number.isNaN(Date.parse(time))) fail(path, 'must be an ISO 8601 time');
    return time;
}

// --- highlights ----------------------------------------------------------------------

/** An element path as the extension writes it: `/html[1]/body[1]/div[3]`, elements only. */
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

/**
 * Page text, checked but never cleaned: the quote and its context must match the page to
 * the code unit, or the highlight can never be found again. They are only ever written
 * into the vault as JSON, or shown inert, so leaving them as the page had them is safe.
 */
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
    // Offsets count UTF-16 code units of the text model, and the quote is that slice, so a
    // position that does not span exactly the quote was not made from it.
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
        // The investigator's own words: cleaned like note.text. Omit body for no note.
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
    const kind = value.kind as Manifest['kind'];
    // Every highlight kind carries its payload under `highlight`.
    const payloadKey = kind.startsWith('highlight') ? 'highlight' : kind;
    onlyKeys(value, '', ['v', 'bundleId', 'workspaceId', 'kind', 'page', 'clientTime', payloadKey]);

    if (typeof value.bundleId !== 'string' || !UUID_V4.test(value.bundleId.toLowerCase())) {
        fail('bundleId', 'must be a UUID v4');
    }
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
        // The page an item is filed under is the page the highlight is on.
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

/** The parsed JSON body of POST /v1/bundles, checked and cleaned. */
export function validateManifest(value: unknown): ValidationResult<Manifest> {
    return run(() => manifest(value));
}

/** One entity payload on its own; the shared entity vectors exercise this directly. */
export function validateEntity(value: unknown): ValidationResult<EntityPayload> {
    return run(() => entity(value));
}
