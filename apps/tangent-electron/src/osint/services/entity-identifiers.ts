/**
 * Normalised identifier keys for entities: `email:<addr>`, `phone:<digits>`, `domain:<host>`,
 * `wallet:<chain>:<address>`, `username:<name>` or `username:<platform>:<name>`, `url:<url>`,
 * `ip:<addr>`, `evidence:<sha256>`.
 *
 * Labels are not identity. Two people can share a name, and the same email address arrives
 * as "Alice@Example.com" from one page and "alice@example.com" from another. External
 * ingestion (the browser extension) matches on these keys instead, so an address sent
 * later lands on the entity the investigator already has rather than beside it.
 *
 * Pure logic -- no vault I/O.
 */

import type { Entity } from '../entities/types';

export type IdentifierKind = 'email' | 'phone' | 'domain' | 'wallet' | 'username' | 'url' | 'ip' | 'evidence';

const KINDS: readonly IdentifierKind[] = ['email', 'phone', 'domain', 'wallet', 'username', 'url', 'ip', 'evidence'];

function isKind(value: string): value is IdentifierKind {
    return (KINDS as readonly string[]).includes(value);
}

function normalizeEmail(raw: string): string | null {
    const v = raw.trim().replace(/^mailto:/i, '').trim().toLowerCase();
    const at = v.lastIndexOf('@');
    if (at <= 0 || at === v.length - 1 || /\s/.test(v)) return null;
    return v;
}

function normalizePhone(raw: string): string | null {
    const t = raw.trim().replace(/^tel:/i, '').trim();
    const digits = t.replace(/\D/g, '');
    // Too short to be a number anyone would match on; "1" or "12" would join unrelated notes.
    if (digits.length < 4) return null;
    return t.startsWith('+') ? `+${digits}` : digits;
}

function normalizeDomain(raw: string): string | null {
    let v = raw.trim().toLowerCase().replace(/\.+$/, '');
    if (!v || /[\s/@]/.test(v)) return null;
    // The URL parser applies IDNA, so "bücher.de" and "xn--bcher-kva.de" meet on one key.
    try {
        v = new URL(`http://${v}`).hostname;
    } catch {
        /* keep the lowercased form */
    }
    return v || null;
}

/**
 * A colon is refused because it separates the platform in `username:<platform>:<name>`: a
 * platform-less "github:john" would otherwise produce the very key a GitHub "john" has.
 */
function normalizeUsername(raw: string): string | null {
    const v = raw.trim().replace(/^@+/, '').toLowerCase();
    return v && !/[\s:]/.test(v) ? v : null;
}

/**
 * Hosts and names that are one platform under several spellings. Keys are compared after
 * lowercasing and dropping a leading `www.`.
 */
const PLATFORM_ALIASES: Record<string, string> = {
    'twitter': 'twitter',
    'x': 'twitter',
    'twitter.com': 'twitter',
    'mobile.twitter.com': 'twitter',
    'x.com': 'twitter',
    'github': 'github',
    'github.com': 'github',
    'gitlab': 'gitlab',
    'gitlab.com': 'gitlab',
    'telegram': 'telegram',
    't.me': 'telegram',
    'telegram.me': 'telegram',
    'telegram.org': 'telegram',
    'facebook': 'facebook',
    'facebook.com': 'facebook',
    'm.facebook.com': 'facebook',
    'fb.com': 'facebook',
    'instagram': 'instagram',
    'instagram.com': 'instagram',
    'linkedin': 'linkedin',
    'linkedin.com': 'linkedin',
    'reddit': 'reddit',
    'reddit.com': 'reddit',
    'old.reddit.com': 'reddit',
    'youtube': 'youtube',
    'youtube.com': 'youtube',
    'm.youtube.com': 'youtube',
    'youtu.be': 'youtube',
    'tiktok': 'tiktok',
    'tiktok.com': 'tiktok',
};

/**
 * One name per platform, so a username seen on "x.com" and one recorded by hand as
 * "Twitter" meet on the same key. Accepts a URL, a bare host or free text; unknown hosts
 * are kept as the host (without `www.`), unknown free text is reduced to [a-z0-9.-].
 * Returns null when nothing usable is left.
 */
export function normalizePlatform(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    let v = raw.trim().toLowerCase();
    if (!v) return null;
    if (v.includes('://')) {
        try {
            v = new URL(v).hostname;
        } catch {
            /* treat it as text */
        }
    } else {
        // A bare "example.com:8080" is the host; the port must not fuse into its name.
        v = v.replace(/:\d+$/, '');
    }
    v = v.replace(/^www\./, '').replace(/\.+$/, '');
    if (PLATFORM_ALIASES[v]) return PLATFORM_ALIASES[v];
    v = v.replace(/[^a-z0-9.-]/g, '').replace(/^www\./, '').replace(/^[.-]+|[.-]+$/g, '');
    if (!v) return null;
    return PLATFORM_ALIASES[v] ?? v;
}

/**
 * `username:<platform>:<name>` when the platform is known, else `username:<name>`. The two
 * forms never match each other: a GitHub "john" must not merge into a Twitter "john", nor
 * into a "john" whose platform nobody recorded.
 */
export function usernameIdentifierKey(name: unknown, platform?: unknown): string | null {
    if (typeof name !== 'string' && typeof name !== 'number') return null;
    const user = normalizeUsername(String(name));
    if (!user) return null;
    const where = normalizePlatform(platform);
    return where ? `username:${where}:${user}` : `username:${user}`;
}

function normalizeUrl(raw: string): string | null {
    const t = raw.trim();
    try {
        const u = new URL(t);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        // A fragment never reaches the server, so it does not make a different page.
        u.hash = '';
        return u.toString();
    } catch {
        return null;
    }
}

/**
 * IPv4 is parsed as plain decimal by hand: the WHATWG URL parser reads a leading zero as
 * octal, so "010.0.0.1" would become 8.0.0.1 there while every OSINT source means 10.0.0.1.
 */
function normalizeIp(raw: string): string | null {
    const t = raw.trim();
    const v4 = t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const octets = v4.slice(1).map((o) => Number.parseInt(o, 10));
        return octets.every((o) => o <= 255) ? octets.join('.') : null;
    }
    if (!t.includes(':')) return null;
    try {
        // The URL parser prints IPv6 in canonical compressed lowercase form.
        const host = new URL(`http://[${t.replace(/^\[|\]$/g, '')}]`).hostname;
        return host.replace(/^\[|\]$/g, '');
    } catch {
        return null;
    }
}

/**
 * Hex (EVM-style) addresses are case-insensitive, so they are lowercased; anything else
 * (base58, bech32 mixed forms) is kept as written because case is part of the address.
 */
function normalizeWallet(raw: string): string | null {
    const sep = raw.indexOf(':');
    if (sep < 0) return null;
    const chain = raw.slice(0, sep).trim().toLowerCase() || 'unknown';
    let address = raw.slice(sep + 1).trim();
    if (!address || /\s/.test(address)) return null;
    if (/^0x[0-9a-f]+$/i.test(address)) address = address.toLowerCase();
    return `${chain}:${address}`;
}

/**
 * A captured page is identified by its archive's bytes: the same archive captured twice is
 * one piece of evidence, whatever it was titled. Only a whole SHA-256 in hex is a key.
 */
function normalizeSha256(raw: string): string | null {
    const v = raw.trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(v) ? v : null;
}

const NORMALIZERS: Record<IdentifierKind, (raw: string) => string | null> = {
    email: normalizeEmail,
    phone: normalizePhone,
    domain: normalizeDomain,
    wallet: normalizeWallet,
    username: normalizeUsername,
    url: normalizeUrl,
    ip: normalizeIp,
    evidence: normalizeSha256,
};

/**
 * `kind:value` with the value normalised, or null when it is not a usable identifier.
 * `platform` is only read for usernames (see usernameIdentifierKey).
 */
export function identifierKey(kind: IdentifierKind, raw: unknown, platform?: unknown): string | null {
    if (kind === 'username') return usernameIdentifierKey(raw, platform);
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const value = NORMALIZERS[kind](String(raw));
    return value ? `${kind}:${value}` : null;
}

/**
 * Normalise a caller-supplied key such as "email:Alice@Example.com". Anything without a
 * known kind prefix is rejected rather than guessed at.
 */
export function normalizeIdentifierKey(key: string): string | null {
    const sep = key.indexOf(':');
    if (sep <= 0) return null;
    const kind = key.slice(0, sep).trim().toLowerCase();
    if (!isKind(kind)) return null;
    const rest = key.slice(sep + 1);
    if (kind === 'username') {
        const at = rest.lastIndexOf(':');
        return at >= 0
            ? (normalizePlatform(rest.slice(0, at)) ? usernameIdentifierKey(rest.slice(at + 1), rest.slice(0, at)) : null)
            : usernameIdentifierKey(rest);
    }
    return identifierKey(kind, rest);
}

/** FTM properties can be multi-valued; every string in an array is an identifier too. */
function valuesOf(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [value];
}

/** The schema an entity is stored under: FTM schema when set, else its (legacy) type. */
function schemaOf(entity: Pick<Entity, 'type' | 'ftmSchema'>): string {
    return String(entity.ftmSchema || entity.type);
}

/**
 * Which properties of which schemas are identifiers. Legacy notes are covered on purpose:
 * the old Email and Phone types were stored as LegalEntity (address / number), and
 * Username as UserAccount, so an investigator's existing vault still matches.
 *
 * Only LegalEntity itself contributes email/phone, not Person or Company: a person who
 * owns an address is not the address, and appending an address's sources to the person
 * would misattribute them.
 */
function identifierFieldsFor(entity: Pick<Entity, 'type' | 'ftmSchema'>): Array<[string, IdentifierKind]> {
    const type = String(entity.type);
    switch (schemaOf(entity)) {
        case 'EmailAddr':
            return [['value', 'email']];
        case 'LegalEntity': {
            const fields: Array<[string, IdentifierKind]> = [['email', 'email'], ['phone', 'phone']];
            if (type === 'Email') fields.push(['address', 'email']);
            if (type === 'Phone') fields.push(['number', 'phone']);
            return fields;
        }
        case 'UserAccount':
        case 'OnlineAccount':
        case 'Username':
            return [['username', 'username']];
        case 'Domain':
            return [['name', 'domain'], ['value', 'domain']];
        case 'Url':
            return [['value', 'url']];
        case 'Ipv4Addr':
        case 'Ipv6Addr':
            return [['value', 'ip']];
        case 'Email':
            return [['address', 'email']];
        case 'Phone':
            return [['number', 'phone']];
        default:
            return [];
    }
}

/** Every normalised identifier key the entity's properties carry, without duplicates. */
export function identifierKeysForEntity(
    entity: Pick<Entity, 'type' | 'ftmSchema' | 'properties'>,
): string[] {
    const keys = new Set<string>();
    const props = entity.properties ?? {};
    // Legacy Username notes call it platform; FTM UserAccount calls it service.
    const platform = [...valuesOf(props.platform), ...valuesOf(props.service)]
        .map(normalizePlatform)
        .find((p) => p !== null) ?? null;
    for (const [prop, kind] of identifierFieldsFor(entity)) {
        for (const v of valuesOf(props[prop])) {
            const key = identifierKey(kind, v, platform);
            if (key) keys.add(key);
        }
    }
    // Evidence is a legacy type stored under the FTM schema Document, which Website, Image
    // and Text share: only the type says which Documents are captures.
    if (String(entity.type) === 'Evidence') {
        for (const v of valuesOf(props.sha256)) {
            const key = identifierKey('evidence', v);
            if (key) keys.add(key);
        }
    }
    if (schemaOf(entity) === 'CryptoWallet') {
        const chain = valuesOf(props.currencySymbol).find((c) => typeof c === 'string');
        for (const address of valuesOf(props.publicKey)) {
            if (typeof address !== 'string') continue;
            const key = identifierKey('wallet', `${typeof chain === 'string' ? chain : ''}:${address}`);
            if (key) keys.add(key);
        }
    }
    return [...keys];
}
