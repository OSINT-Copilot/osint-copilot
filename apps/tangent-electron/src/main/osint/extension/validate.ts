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
    ENTITY_KINDS,
    LIMITS,
    SUPPORTED_KINDS,
    WALLET_CHAINS,
    type EntityKind,
    type EntityPayload,
    type Manifest,
    type WalletChain,
} from './protocol';
import { isValidEthAddress } from './keccak';
import { isValidBtcAddress } from './wallet-checks';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; detail: string };

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

function isRecord(value: unknown): value is Record<string, unknown> {
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

// --- manifest ------------------------------------------------------------------------

/** An ISO 8601 date-time with a zone, as toISOString writes it; Date.parse alone takes '1' or 'March 7'. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{22}$/;

function manifest(value: unknown): Manifest {
    if (!isRecord(value)) fail('manifest', 'must be a JSON object');
    if (value.v !== 1) fail('v', 'must be 1');

    if (typeof value.kind !== 'string' || !(ALL_KINDS as readonly string[]).includes(value.kind)) {
        fail('kind', `must be one of ${ALL_KINDS.join(', ')}`);
    }
    if (!(SUPPORTED_KINDS as readonly string[]).includes(value.kind)) {
        throw new Invalid(KIND_NOT_SUPPORTED);
    }
    const kind = value.kind as Manifest['kind'];
    onlyKeys(value, '', ['v', 'bundleId', 'workspaceId', 'kind', 'page', 'clientTime', kind]);

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

/** The parsed JSON body of POST /v1/bundles, checked and cleaned. */
export function validateManifest(value: unknown): ValidationResult<Manifest> {
    return run(() => manifest(value));
}

/** One entity payload on its own; the shared entity vectors exercise this directly. */
export function validateEntity(value: unknown): ValidationResult<EntityPayload> {
    return run(() => entity(value));
}
