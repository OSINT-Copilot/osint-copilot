/**
 * Test helper: the extension's half of the protocol, which the app never runs. The app
 * is the server: it verifies request MACs and mints pairing strings, but signs no
 * request and parses no pairing string. The shipped client has its own copies in
 * apps/osint-copilot-extension/src/shared.
 */
import { b64url, fromB64url, hmac, requestStringToSign, type RequestSigningParts } from './signing';

export function signRequest(key: Buffer, parts: RequestSigningParts): string {
    return b64url(hmac(key, requestStringToSign(parts)));
}

export function parsePairingString(text: string): { port: number; instanceId: string; pairSecret: Buffer } | null {
    const m = /^ocpair1\.(\d{1,5})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(text.trim());
    if (!m) return null;
    const port = Number(m[1]);
    const pairSecret = fromB64url(m[3]);
    if (port < 1 || port > 65535 || !pairSecret || pairSecret.length !== 32) return null;
    return { port, instanceId: m[2], pairSecret };
}
