import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    guardedFetch, assertRequestAllowed, isPrivateAddress, hostAllowed, expandIpv6,
    BlockedRequestError,
} from '../../main/osint/node/net-guard';

/**
 * IP literals throughout, so `assertRequestAllowed` takes its `isIP` branch and never
 * touches DNS. 93.184.216.34 and 23.1.1.1 are public; anything in the private ranges is
 * refused before a request is made.
 */
const PUBLIC = 'http://93.184.216.34/start';
const OTHER_PUBLIC = 'http://23.1.1.1/next';
const METADATA = 'http://169.254.169.254/latest/meta-data/';

interface Hop { status: number; location?: string; }

/** Stubs global fetch with a scripted sequence, recording what was requested. */
function scriptFetch(hops: Hop[]) {
    const calls: {
        url: string; method: string; redirect: string; body: unknown;
        headers: Record<string, string>;
    }[] = [];
    let i = 0;
    const stub = vi.fn(async (url: string, init: Record<string, unknown>) => {
        calls.push({
            url: String(url),
            method: String(init?.method ?? 'GET'),
            redirect: String(init?.redirect),
            body: init?.body,
            headers: { ...((init?.headers as Record<string, string>) ?? {}) },
        });
        const hop = hops[Math.min(i, hops.length - 1)];
        i += 1;
        const headers = new Headers();
        if (hop.location) headers.set('location', hop.location);
        return { status: hop.status, headers } as unknown as Response;
    });
    vi.stubGlobal('fetch', stub);
    return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('guardedFetch redirect handling', () => {
    it('refuses a redirect into link-local address space', async () => {
        // The classic SSRF bypass: the URL the analyst pasted is public and passes the
        // guard, and the page they do not control redirects to cloud metadata. Before the
        // guard ran per hop, fetch followed this silently.
        const calls = scriptFetch([{ status: 302, location: METADATA }]);
        await expect(guardedFetch(PUBLIC, {})).rejects.toThrow(BlockedRequestError);
        // The first hop was made; the redirect target never was.
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(PUBLIC);
    });

    it('refuses a redirect to loopback and to other private ranges', async () => {
        for (const target of [
            'http://127.0.0.1:8080/admin',
            'http://10.0.0.5/internal',
            'http://192.168.1.1/router',
            'http://172.16.0.1/',
            'http://[::1]/',
            'http://[fd00::1]/',
            'http://[fe80::1]/',
        ]) {
            const calls = scriptFetch([{ status: 301, location: target }]);
            await expect(guardedFetch(PUBLIC, {}), target).rejects.toThrow(BlockedRequestError);
            // Asserting the request was never MADE, not merely that something threw.
            // The earlier version of this test passed on the redirect cap while happily
            // connecting to [::1] on every hop -- it performed the SSRF it claimed to stop.
            expect(calls.map((c) => c.url), target).toEqual([PUBLIC]);
            vi.unstubAllGlobals();
        }
    });

    it('refuses IPv6 literals directly, brackets and all', async () => {
        // URL.hostname keeps the brackets and isIP() rejects that form, so these fell
        // through to the DNS branch, whose failure path allowed the request.
        for (const url of ['http://[::1]/', 'http://[fd00::1]/x', 'http://[::ffff:169.254.169.254]/']) {
            await expect(assertRequestAllowed(url), url).rejects.toThrow(BlockedRequestError);
        }
    });

    it('still allows a public IPv6 literal', async () => {
        await expect(assertRequestAllowed('http://[2606:4700::1]/')).resolves.toBeUndefined();
    });

    it('never lets fetch follow redirects on its own', async () => {
        // If redirect were left at its default, every hop would be invisible to the guard.
        const calls = scriptFetch([{ status: 200 }]);
        await guardedFetch(PUBLIC, {});
        expect(calls[0].redirect).toBe('manual');
    });

    it('follows a redirect between public hosts, checking each', async () => {
        const calls = scriptFetch([
            { status: 302, location: OTHER_PUBLIC },
            { status: 200 },
        ]);
        const response = await guardedFetch(PUBLIC, {});
        expect(response.status).toBe(200);
        expect(calls.map((c) => c.url)).toEqual([PUBLIC, OTHER_PUBLIC]);
    });

    it('resolves a relative Location against the current hop', async () => {
        const calls = scriptFetch([
            { status: 302, location: '/moved/here' },
            { status: 200 },
        ]);
        await guardedFetch(PUBLIC, {});
        expect(calls[1].url).toBe('http://93.184.216.34/moved/here');
    });

    it('stops rather than looping forever', async () => {
        // A self-referential redirect would otherwise spin until something else broke.
        scriptFetch([{ status: 302, location: OTHER_PUBLIC }, { status: 302, location: PUBLIC }]);
        await expect(guardedFetch(PUBLIC, {})).rejects.toThrow(/Too many redirects/);
    });

    it('drops the body and becomes GET on a 303, per fetch semantics', async () => {
        // Carrying a POST body onto a redirect target hands it to a host the caller never
        // named -- which for an authenticated enricher could mean leaking a payload.
        const calls = scriptFetch([{ status: 303, location: OTHER_PUBLIC }, { status: 200 }]);
        await guardedFetch(PUBLIC, { method: 'POST', body: 'secret=1' });
        expect(calls[0].method).toBe('POST');
        expect(calls[1].method).toBe('GET');
        expect(calls[1].body).toBeUndefined();
    });

    it('keeps the method on a 307, which is what 307 means', async () => {
        const calls = scriptFetch([{ status: 307, location: OTHER_PUBLIC }, { status: 200 }]);
        await guardedFetch(PUBLIC, { method: 'POST', body: 'keep=1' });
        expect(calls[1].method).toBe('POST');
        expect(calls[1].body).toBe('keep=1');
    });

    it('treats a 3xx with no Location as the final response', async () => {
        const response = await (scriptFetch([{ status: 304 }]), guardedFetch(PUBLIC, {}));
        expect(response.status).toBe(304);
    });

    it('re-applies the allowlist to every hop', async () => {
        // Otherwise an allowlisted enricher host could redirect its way off the allowlist.
        scriptFetch([{ status: 302, location: OTHER_PUBLIC }, { status: 200 }]);
        await expect(guardedFetch(PUBLIC, {}, ['93.184.216.34']))
            .rejects.toThrow(/not in this enricher's allowedDomains/);
    });

    it('drops credentials when a redirect crosses origins', async () => {
        // request() injects resolved secrets into these headers. Following a
        // redirect with them attached hands a live credential to a host the caller never
        // named -- which, for a pasted link, is a host chosen by someone else.
        const calls = scriptFetch([{ status: 302, location: OTHER_PUBLIC }, { status: 200 }]);
        await guardedFetch(PUBLIC, {
            headers: { Authorization: 'Bearer secret', 'X-API-Key': 'k', Accept: 'text/html' },
        }, undefined, ['X-API-Key']);

        expect(calls[0].headers).toHaveProperty('Authorization');
        expect(calls[1].headers).not.toHaveProperty('Authorization');
        expect(calls[1].headers).not.toHaveProperty('X-API-Key');
        // Non-credential headers still travel.
        expect(calls[1].headers).toHaveProperty('Accept');
    });

    it('keeps credentials on a same-origin redirect', async () => {
        const calls = scriptFetch([
            { status: 302, location: 'http://93.184.216.34/elsewhere' },
            { status: 200 },
        ]);
        await guardedFetch(PUBLIC, { headers: { Authorization: 'Bearer secret' } });
        expect(calls[1].headers).toHaveProperty('Authorization');
    });

    it('refuses a redirect to a non-HTTP scheme', async () => {
        for (const target of ['file:///etc/passwd', 'data:text/html,<script>', 'javascript:alert(1)']) {
            scriptFetch([{ status: 302, location: target }]);
            await expect(guardedFetch(PUBLIC, {})).rejects.toThrow(BlockedRequestError);
            vi.unstubAllGlobals();
        }
    });
});

describe('assertRequestAllowed', () => {
    it('refuses private literals up front', async () => {
        for (const url of [METADATA, 'http://127.0.0.1/', 'http://10.1.2.3/']) {
            await expect(assertRequestAllowed(url)).rejects.toThrow(BlockedRequestError);
        }
    });

    it('allows a public literal', async () => {
        await expect(assertRequestAllowed(PUBLIC)).resolves.toBeUndefined();
    });
});

describe('IPv6 forms', () => {
    it('refuses IPv4-mapped metadata in every spelling, including the normalised one', async () => {
        // new URL() rewrites "::ffff:169.254.169.254" as "::ffff:a9fe:a9fe", so a check
        // that looked for a dotted quad never saw the form the parser produces.
        for (const address of [
            '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',
            '::ffff:127.0.0.1', '::ffff:7f00:1',
            '::ffff:10.0.0.1', '::ffff:a00:1',
            '64:ff9b::169.254.169.254', '64:ff9b::a9fe:a9fe',
        ]) {
            expect(isPrivateAddress(address), address).toBe(true);
        }
        for (const url of ['http://[::ffff:169.254.169.254]/', 'http://[::ffff:a9fe:a9fe]/']) {
            await expect(assertRequestAllowed(url), url).rejects.toThrow(BlockedRequestError);
        }
    });

    it('expands compressed, zoned and mixed notation to the same bytes', () => {
        expect(expandIpv6('::1')?.slice(-2)).toEqual([0, 1]);
        expect(expandIpv6('fe80::1%eth0')?.[0]).toBe(0xfe);
        expect(expandIpv6('2001:db8::1')?.slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
        expect(expandIpv6('::ffff:1.2.3.4')?.slice(-4)).toEqual([1, 2, 3, 4]);
        expect(expandIpv6('0:0:0:0:0:0:0:1')).toEqual(expandIpv6('::1'));
    });

    it('returns null for anything it cannot read', () => {
        for (const bad of ['not:an:address', '::1::2', 'gggg::1', '1:2:3:4:5:6:7:8:9']) {
            expect(expandIpv6(bad), bad).toBeNull();
        }
        // isPrivateAddress answers false for these because they are not addresses at all,
        // so isIP never routes them to the v6 branch. The guard handles that case through
        // its DNS path, not here.
        expect(isPrivateAddress('::1::2')).toBe(false);
        // But a well-formed address the expander somehow could not read is refused, which
        // is the direction a guard has to fail in.
        expect(isPrivateAddress('::1')).toBe(true);
    });

    it('still allows public IPv6', () => {
        for (const address of ['2606:4700::1', '2001:4860:4860::8888']) {
            expect(isPrivateAddress(address), address).toBe(false);
        }
    });
});

describe('isPrivateAddress', () => {
    it('covers the ranges that matter for SSRF', () => {
        for (const address of [
            '127.0.0.1', '10.0.0.1', '192.168.0.1', '172.16.0.1', '172.31.255.255',
            '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
            '::1', 'fe80::1', 'fc00::1', 'fd00::1', '::ffff:169.254.169.254',
        ]) {
            expect(isPrivateAddress(address), address).toBe(true);
        }
    });

    it('does not refuse public addresses', () => {
        for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1']) {
            expect(isPrivateAddress(address), address).toBe(false);
        }
    });
});

describe('hostAllowed', () => {
    it('matches a host and its subdomains, not a lookalike suffix', () => {
        expect(hostAllowed('api.example.com', ['example.com'])).toBe(true);
        expect(hostAllowed('example.com', ['example.com'])).toBe(true);
        expect(hostAllowed('example.com', ['*.example.com'])).toBe(true);
        expect(hostAllowed('notexample.com', ['example.com'])).toBe(false);
        expect(hostAllowed('example.com.evil.net', ['example.com'])).toBe(false);
    });
});
