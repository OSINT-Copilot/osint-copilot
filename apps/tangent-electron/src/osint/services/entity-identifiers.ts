/**
 * Normalised identifier keys for entities: `email:<addr>`, `phone:<digits>`, `domain:<host>`,
 * `wallet:<chain>:<address>`, `username:<name>`, `url:<url>`, `ip:<addr>`.
 *
 * Labels are not identity. Two people can share a name, and the same email address arrives
 * as "Alice@Example.com" from one page and "alice@example.com" from another. External
 * ingestion (the browser extension) matches on these keys instead, so an address sent
 * later lands on the entity the investigator already has rather than beside it.
 *
 * Pure logic -- no vault I/O.
 */

import type { Entity } from '../entities/types';

export type IdentifierKind = 'email' | 'phone' | 'domain' | 'wallet' | 'username' | 'url' | 'ip';

const KINDS: readonly IdentifierKind[] = ['email', 'phone', 'domain', 'wallet', 'username', 'url', 'ip'];

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

function normalizeUsername(raw: string): string | null {
    const v = raw.trim().replace(/^@+/, '').toLowerCase();
    return v && !/\s/.test(v) ? v : null;
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

const NORMALIZERS: Record<IdentifierKind, (raw: string) => string | null> = {
    email: normalizeEmail,
    phone: normalizePhone,
    domain: normalizeDomain,
    wallet: normalizeWallet,
    username: normalizeUsername,
    url: normalizeUrl,
    ip: normalizeIp,
};

/** `kind:value` with the value normalised, or null when it is not a usable identifier. */
export function identifierKey(kind: IdentifierKind, raw: unknown): string | null {
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
    return identifierKey(kind, key.slice(sep + 1));
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
    for (const [prop, kind] of identifierFieldsFor(entity)) {
        for (const v of valuesOf(props[prop])) {
            const key = identifierKey(kind, v);
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
