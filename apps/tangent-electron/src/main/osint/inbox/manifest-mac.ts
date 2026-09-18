/**
 * The MAC main puts on every bundle it stores, and the check it makes before handing a
 * bundle to the renderer.
 *
 * A bundle in `.osint-inbox/pending/` says "the paired extension sent this at this time".
 * The renderer cannot write there (vault.ts refuses the folder), but other things can: a
 * sync client, another process as this user, a restore from backup. The MAC is keyed with
 * the store's manifestKey, which never leaves main, so a bundle that did not come through
 * the server fails the check and is quarantined instead of applied with extension
 * provenance it never had.
 *
 * No electron import.
 */
import { b64url, hmac, verifyMac } from '../extension/signing';
import type { Manifest } from '../extension/protocol';

/** What main adds to a manifest when it stores one. */
export interface ServerStamp {
    /** ISO 8601, main's clock at the moment the request arrived. */
    receivedAt: string;
    clientId: string;
    origin: string;
    extVersion: string;
}

export type StoredManifest = Manifest & { server: ServerStamp; mac: string };

/**
 * JSON with object keys sorted recursively (by UTF-16 code unit, as Array.prototype.sort
 * does) and no whitespace. Arrays keep their order. The one serialisation the MAC is
 * computed over, so a file re-indented or re-ordered by some tool still verifies, and one
 * whose values changed does not.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        const text = JSON.stringify(value);
        // undefined, functions and symbols have no JSON form; nothing we MAC carries them.
        if (text === undefined) throw new TypeError('canonicalJson: value has no JSON form');
        return text;
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter(k => record[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

function withoutMac(stored: Record<string, unknown>): Record<string, unknown> {
    const { mac: _mac, ...rest } = stored;
    return rest;
}

/** The stored form: the validated manifest, main's stamp, and a MAC over both. */
export function sealManifest(manifestKey: Buffer, manifest: Manifest, server: ServerStamp): StoredManifest {
    const body = { ...manifest, server };
    return { ...body, mac: b64url(hmac(manifestKey, canonicalJson(body))) };
}

/** Constant-time check of a parsed manifest.json. False for anything malformed. */
export function verifySealedManifest(manifestKey: Buffer, stored: unknown): boolean {
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return false;
    const mac = (stored as Record<string, unknown>).mac;
    if (typeof mac !== 'string') return false;
    let text: string;
    try {
        text = canonicalJson(withoutMac(stored as Record<string, unknown>));
    } catch {
        return false;
    }
    return verifyMac(manifestKey, text, mac);
}
