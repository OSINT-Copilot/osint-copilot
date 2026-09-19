/**
 * Outbound request guard -- main process only.
 *
 * The port creates this risk: moving requestUrl into main gives it unrestricted
 * network access, while the enricher domain allowlist lives in renderer code that is
 * now the untrusted side. Enricher URL templates are LLM- and user-authored, so the
 * allowlist is re-enforced here, and private address space is refused after DNS
 * resolution (a public hostname can resolve to 169.254.169.254).
 */
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export class BlockedRequestError extends Error {}

/** Matches the renderer-side check, which stays as a fast fail and a clear message. */
export function hostAllowed(hostname: string, allowed: string[]): boolean {
    const host = hostname.toLowerCase();
    return allowed.some((entry) => {
        const pattern = entry.trim().toLowerCase().replace(/^\*\./, '');
        if (!pattern) return false;
        return host === pattern || host.endsWith(`.${pattern}`);
    });
}

export function isPrivateAddress(address: string): boolean {
    const version = isIP(address);
    if (version === 4) {
        const [a, b] = address.split('.').map(Number);
        return (
            a === 0 || a === 10 || a === 127 ||
            (a === 169 && b === 254) ||              // link-local, incl. cloud metadata
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127) ||    // CGNAT
            a >= 224                                  // multicast / reserved
        );
    }
    if (version === 6) {
        const bytes = expandIpv6(address);
        // isIP said 6, so this should not happen -- but refusing an address we cannot
        // reason about is the only safe direction for a guard.
        if (!bytes) return true;

        // ::/128 and ::1/128
        if (bytes.every((b) => b === 0)) return true;
        if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;

        // fe80::/10 link-local, fc00::/7 unique-local
        if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
        if ((bytes[0] & 0xfe) === 0xfc) return true;

        // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) both carry an IPv4 address
        // in the last four bytes, so the IPv4 rules decide.
        //
        // This has to work on BYTES, not on the text: `new URL()` normalises
        // "::ffff:169.254.169.254" to "::ffff:a9fe:a9fe", so a regex looking for a dotted
        // quad never matched the form the parser actually produces -- and cloud metadata
        // was reachable through it.
        const mappedPrefix = bytes.slice(0, 10).every((b) => b === 0)
            && bytes[10] === 0xff && bytes[11] === 0xff;
        const nat64Prefix = bytes[0] === 0x00 && bytes[1] === 0x64
            && bytes[2] === 0xff && bytes[3] === 0x9b
            && bytes.slice(4, 12).every((b) => b === 0);
        if (mappedPrefix || nat64Prefix) {
            return isPrivateAddress(bytes.slice(12).join('.'));
        }
        return false;
    }
    return false;
}

/** An IPv6 address as its 16 bytes, or null if it cannot be read. */
export function expandIpv6(address: string): number[] | null {
    // A zone index ("fe80::1%eth0") is not part of the address.
    let text = address.toLowerCase().split('%')[0];

    // A trailing dotted quad ("::ffff:1.2.3.4") becomes two hex groups.
    const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (dotted) {
        const quad = [dotted[2], dotted[3], dotted[4], dotted[5]].map(Number);
        if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        const hi = ((quad[0] << 8) | quad[1]).toString(16);
        const lo = ((quad[2] << 8) | quad[3]).toString(16);
        text = `${dotted[1]}${hi}:${lo}`;
    }

    const halves = text.split('::');
    if (halves.length > 2) return null;

    const toGroups = (part: string): number[] | null => {
        if (!part) return [];
        const out: number[] = [];
        for (const piece of part.split(':')) {
            if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
            out.push(parseInt(piece, 16));
        }
        return out;
    };

    const head = toGroups(halves[0]);
    const tail = halves.length === 2 ? toGroups(halves[1]) : [];
    if (!head || !tail) return null;

    const groups = halves.length === 2
        ? [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail]
        : head;
    if (groups.length !== 8 || groups.some((g) => g < 0 || g > 0xffff)) return null;

    const bytes: number[] = [];
    for (const group of groups) { bytes.push((group >> 8) & 0xff, group & 0xff); }
    return bytes;
}

/** Statuses that carry a Location the client is expected to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Follow redirects ourselves so every hop goes through the guard.
 *
 * `fetch` defaults to redirect: 'follow', which meant the guard only ever saw the URL the
 * caller passed. A public host that 302s to 169.254.169.254 -- or to localhost, or to an
 * internal service -- was followed with no check at all. That is the standard SSRF bypass,
 * and it is directly reachable now that canvas link previews fetch URLs the analyst merely
 * pasted, where the page on the other end is adversary-controlled by assumption.
 *
 * The allowlist is re-applied per hop too, so an allowlisted enricher host cannot redirect
 * its way off the allowlist.
 */
const MAX_REDIRECTS = 5;

export interface GuardedFetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
}

/**
 * Headers that must never survive a hop to a different origin.
 *
 * `request()` resolves secrets into Authorization or a caller-named header before
 * this runs. Following a redirect with those still attached would hand a live credential
 * to whatever host the first one nominated -- which, for a link the analyst merely pasted,
 * is a host chosen by someone else.
 */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

function stripCredentials(
    headers: Record<string, string> | undefined,
    extra: string[],
): Record<string, string> | undefined {
    if (!headers) return headers;
    const sensitive = new Set([...CREDENTIAL_HEADERS, ...extra.map((h) => h.toLowerCase())]);
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (!sensitive.has(key.toLowerCase())) kept[key] = value;
    }
    return kept;
}

export async function guardedFetch(
    initialUrl: string,
    init: GuardedFetchInit,
    allowedDomains?: string[],
    credentialHeaders: string[] = [],
): Promise<Response> {
    let url = initialUrl;
    let method = init.method ?? 'GET';
    let body = init.body;
    let headers = init.headers;
    const origin = new URL(initialUrl).origin;

    for (let hop = 0; ; hop++) {
        await assertRequestAllowed(url, allowedDomains);

        const response = await fetch(url, {
            method,
            headers,
            body: body as BodyInit | undefined,
            signal: init.signal,
            // The point of the whole function: see each hop instead of being handed the
            // final response after fetch silently followed them.
            redirect: 'manual',
        });

        if (!REDIRECT_STATUSES.has(response.status)) return response;

        const location = response.headers.get('location');
        // A 3xx with no Location is the caller's answer, not a redirect.
        if (!location) return response;

        if (hop >= MAX_REDIRECTS) {
            throw new BlockedRequestError(`Too many redirects (>${MAX_REDIRECTS}) from ${initialUrl}`);
        }

        let next: URL;
        try {
            // Relative Locations are legal and common.
            next = new URL(location, url);
        } catch {
            throw new BlockedRequestError(`Malformed redirect target "${location}" from ${url}`);
        }

        // Per fetch semantics: 303 always becomes GET, and 301/302 become GET for anything
        // that was not already GET/HEAD. Carrying a body to a redirected target would also
        // hand it to a host the caller never named.
        if (response.status === 303 || (method !== 'GET' && method !== 'HEAD'
            && (response.status === 301 || response.status === 302))) {
            method = 'GET';
            body = undefined;
        }

        // Crossing origins drops the credentials, the way a browser does.
        if (next.origin !== origin) {
            headers = stripCredentials(headers, credentialHeaders);
        }
        url = next.toString();
    }
}

export async function assertRequestAllowed(url: string, allowedDomains?: string[]): Promise<void> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new BlockedRequestError(`Malformed URL: ${url}`);
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new BlockedRequestError(`Refused non-HTTP scheme: ${parsed.protocol}`);
    }

    if (allowedDomains?.length && !hostAllowed(parsed.hostname, allowedDomains)) {
        throw new BlockedRequestError(
            `Host "${parsed.hostname}" is not in this enricher's allowedDomains.`,
        );
    }

    // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), and isIP() rejects
    // that form -- so every IPv6 literal fell through to the DNS branch, where the lookup
    // failed and the catch below ALLOWED it. http://[::1]/ and http://[fd00::1]/ were
    // reachable. Strip the brackets before asking.
    const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;

    if (isIP(hostname)) {
        if (isPrivateAddress(hostname)) {
            throw new BlockedRequestError(`Refused request to private address ${hostname}`);
        }
        return;
    }

    let addresses: { address: string }[];
    try {
        addresses = await lookup(hostname, { all: true });
    } catch {
        // A name that does not resolve cannot be connected to either, so letting the
        // request surface the DNS error is safe -- but only because every literal form is
        // handled above. If that stops being true, this becomes an allow-by-default.
        return;
    }
    for (const { address } of addresses) {
        if (isPrivateAddress(address)) {
            throw new BlockedRequestError(
                `Refused: "${parsed.hostname}" resolves to private address ${address}`,
            );
        }
    }
}
