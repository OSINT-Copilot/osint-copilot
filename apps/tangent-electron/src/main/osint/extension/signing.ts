/**
 * The byte-exact strings each side signs, and the HMAC helpers over them.
 *
 * Every construction here is fixed by PROTOCOL.md and pinned by vectors/protocol-vectors.json,
 * which a second, independent implementation generated. Change a string here and the
 * extension stops talking to the app, so change the protocol version with it.
 *
 * Keys are raw bytes. Every string is UTF-8. Nonces, ids and secrets appear in the
 * strings as the base64url text that travels on the wire, not as decoded bytes.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';

/** base64url without padding. */
export function b64url(bytes: Buffer): string {
    return bytes.toString('base64url');
}

/**
 * Strict decode: rejects padding, the standard alphabet and non-canonical trailing bits,
 * so one byte string has exactly one textual form.
 */
export function fromB64url(text: string): Buffer | null {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
    const bytes = Buffer.from(text, 'base64url');
    return b64url(bytes) === text ? bytes : null;
}

export function sha256Hex(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex');
}

export function hmac(key: Buffer, message: string): Buffer {
    return createHmac('sha256', key).update(message, 'utf8').digest();
}

/** Constant-time check of a base64url MAC against the one we compute. */
export function verifyMac(key: Buffer, message: string, macB64url: string): boolean {
    const given = typeof macB64url === 'string' ? fromB64url(macB64url) : null;
    const expected = hmac(key, message);
    // timingSafeEqual throws on a length mismatch; the length of a MAC is public anyway.
    if (!given || given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
}

/** Constant-time string equality for secrets compared as text (e.g. pairingId). */
export function safeEqualText(a: string, b: string): boolean {
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
}

// --- request / response --------------------------------------------------------------

/**
 * The endpoint every request, response and hello proof is bound to: the address the
 * extension dialled, which the app knows as the port it is bound to. Without it, a process
 * squatting the extension's remembered port could relay to wherever the app really is and
 * every MAC would still check out, while the squatter read each bundle in passing.
 */
export function endpointFor(port: number): string {
    return `127.0.0.1:${port}`;
}

export interface RequestSigningParts {
    /** endpointFor(port): the port the extension addressed, never the Host header. */
    endpoint: string;
    method: string;
    /** The request-target exactly as sent: path plus query, no scheme or host. */
    pathWithQuery: string;
    ts: string;
    nonce: string;
    clientId: string;
    /** Decimal Content-Length; "0" when absent. */
    contentLength: string;
    bodySha256: string;
}

export function requestStringToSign(p: RequestSigningParts): string {
    return ['OC1', p.endpoint, p.method, p.pathWithQuery, p.ts, p.nonce, p.clientId, p.contentLength, p.bodySha256].join('\n');
}

export function responseStringToSign(endpoint: string, status: number, requestNonce: string, bodySha256: string): string {
    return ['OC1R', endpoint, String(status), requestNonce, bodySha256].join('\n');
}

export function signResponse(key: Buffer, endpoint: string, status: number, requestNonce: string, body: Buffer | string): string {
    return b64url(hmac(key, responseStringToSign(endpoint, status, requestNonce, sha256Hex(body))));
}

// --- pairing and hello ---------------------------------------------------------------

export function pairProofString(clientNonce: string): string {
    return `OCPAIR1\n${clientNonce}`;
}

export function pairServerProofString(clientNonce: string, serverNonce: string, clientId: string): string {
    return `OCPAIR1S\n${clientNonce}\n${serverNonce}\n${clientId}`;
}

export function keyDerivationString(clientNonce: string, serverNonce: string, clientId: string): string {
    return `oc-k1\n${clientNonce}\n${serverNonce}\n${clientId}`;
}

/**
 * K, the long-term per-client key. Derived rather than reusing pairSecret, because the
 * pairing secret was on screen and probably in clipboard history.
 */
export function deriveClientKey(pairSecret: Buffer, clientNonce: string, serverNonce: string, clientId: string): Buffer {
    return hmac(pairSecret, keyDerivationString(clientNonce, serverNonce, clientId));
}

export function helloProofString(endpoint: string, clientNonce: string, serverNonce: string, instanceId: string): string {
    return `OCHELLO1\n${endpoint}\n${clientNonce}\n${serverNonce}\n${instanceId}`;
}

/** Identifies the active pairing without revealing its secret: 32 hex chars of sha256. */
export function pairingIdFor(pairSecret: Buffer): string {
    return sha256Hex(pairSecret).slice(0, 32);
}

export function pairingString(port: number, instanceId: string, pairSecret: Buffer): string {
    return `ocpair1.${port}.${instanceId}.${b64url(pairSecret)}`;
}

/**
 * The only name a workspace has on the wire. Keyed, so the extension (or anything that
 * reads its storage) learns nothing about folder names or where cases live on disk.
 */
export function workspaceIdFor(workspaceIdKey: Buffer, realpath: string): string {
    return b64url(hmac(workspaceIdKey, realpath)).slice(0, 22);
}
