/**
 * The loopback HTTP server the browser extension talks to.
 *
 * Threat model, in short (PROTOCOL.md has the long form): anything on this machine can
 * connect to 127.0.0.1, and since Chrome 149 any extension with host access can set the
 * Origin header. So Origin and Host are cheap filters -- Host defeats DNS rebinding from
 * web pages, Origin turns away the lazy -- and authentication is the HMAC over a key only
 * a paired extension holds. Two properties matter beyond "the MAC checks out":
 *
 *   - The signature is verified before a single body byte is read. It covers the
 *     declared Content-Length and body digest, so an unauthenticated caller can make us
 *     read nothing at all, rather than up to the body cap.
 *   - Responses are signed too, so the extension can tell this app from a process that
 *     grabbed the port first. Requests, responses and the hello proof all name the port
 *     the extension dialled (signing.endpointFor), and this side always uses the port it
 *     is bound to, never the Host header: a squatter on the remembered port that relays
 *     to our real one gets nothing that verifies at either end.
 *
 * Inbox and vault work are behind InboxBackend; this module never touches a workspace.
 * Whether the channel is on is start()/stop() alone: the caller maps the user's enabled
 * switch (PairingManager.enabled) onto them, and this class never reads it.
 * No electron import.
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { randomBytes as nodeRandomBytes } from 'crypto';
import {
    B64URL_16,
    ERROR_STATUS,
    EXTENSION_ORIGIN,
    HEADER,
    HOST,
    MAX_CONTROL_BODY,
    MAX_HANDSHAKE_BODY,
    MAX_SKEW_MS,
    PORTS,
    PROTO,
    RATE,
    REPLAY_WINDOW_MS,
    SHA256_HEX,
    type BundleResponse,
    type ErrorCode,
    type HelloResponse,
    type Manifest,
    type StatusResponse,
    type WorkspaceInfo,
} from './protocol';
import {
    b64url,
    endpointFor,
    helloProofString,
    hmac,
    requestStringToSign,
    sha256Hex,
    signResponse,
    verifyMac,
} from './signing';
import { validateManifest } from './validate';
import type { ClientRecord, PairingManager } from './pairing';

// --- the backend the next layer implements -------------------------------------------

export interface BundleContext {
    clientId: string;
    origin: string;
    extVersion: string;
    /** ISO 8601, stamped by main when the request arrived. */
    receivedAt: string;
    /** Hex sha256 of the exact request body. */
    bodySha256: string;
}

export type BundleOutcome =
    | BundleResponse
    | { error: 'unknown_workspace' | 'unlicensed' | 'budget_exceeded' | 'invalid'; detail?: string };

export interface InboxBackend {
    status(): Promise<StatusResponse>;
    listWorkspaces(): Promise<WorkspaceInfo[]>;
    acceptBundle(manifest: Manifest, ctx: BundleContext): Promise<BundleOutcome>;
}

export interface ServerDeps {
    pairing: PairingManager;
    backend: InboxBackend;
    appVersion: string;
    now?: () => number;
    randomBytes?: (size: number) => Buffer;
}

export interface StartOptions {
    /** Ports to try, in order. Defaults to the persisted port, then PORTS. Tests pass [0]. */
    ports?: readonly number[];
}

// --- small pieces --------------------------------------------------------------------

/** Sliding-window counter keyed by caller. */
class RateLimiter {
    private hits = new Map<string, number[]>();

    constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number) {}

    /** Records a hit; false when that would exceed the limit. */
    hit(key: string): boolean {
        const now = this.now();
        const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
        if (recent.length >= this.limit) {
            this.hits.set(key, recent);
            return false;
        }
        recent.push(now);
        this.hits.set(key, recent);
        return true;
    }
}

/** Nonces seen per client, each kept for the replay window. */
class ReplayCache {
    private seen = new Map<string, Map<string, number>>();

    constructor(private readonly now: () => number) {}

    /** True if new (and now recorded); false for a replay. */
    add(clientId: string, nonce: string): boolean {
        const now = this.now();
        let nonces = this.seen.get(clientId);
        if (!nonces) this.seen.set(clientId, nonces = new Map());
        for (const [n, expires] of nonces) {
            if (expires <= now) nonces.delete(n);
        }
        if (nonces.has(nonce)) return false;
        nonces.set(nonce, now + REPLAY_WINDOW_MS);
        return true;
    }

    forget(clientId: string): void {
        this.seen.delete(clientId);
    }
}

class RequestError extends Error {
    constructor(readonly code: ErrorCode, readonly detail?: string) {
        super(code);
    }
}

function header(req: http.IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    return typeof value === 'string' ? value : undefined;
}

function isJsonContentType(value: string | undefined): boolean {
    return !!value && value.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * Reads at most `limit` bytes. Past that it stops keeping anything and reports overrun:
 * what was read so far is dropped, never handed on.
 */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
        };
        req.on('data', (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
                chunks = [];
                settle(() => reject(new RequestError('too_large')));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
        req.on('error', err => settle(() => reject(err)));
        req.on('close', () => settle(() => reject(new Error('request closed before its body ended'))));
    });
}

function parseJson(body: Buffer): unknown {
    try {
        return JSON.parse(body.toString('utf8'));
    } catch {
        throw new RequestError('bad_json');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a reply is signed with, once the request's MAC has verified. */
interface Signer {
    key: Buffer;
    nonce: string;
    endpoint: string;
}

interface Authenticated {
    record: ClientRecord;
    key: Buffer;
    body: Buffer;
    bodySha256: string;
}

// --- the server ----------------------------------------------------------------------

export class ExtensionServer {
    private server: http.Server | null = null;
    private boundPort: number | null = null;
    /** The bind in progress, so overlapping start()/stop() calls share it rather than race. */
    private starting: Promise<number> | null = null;
    private readonly now: () => number;
    private readonly random: (size: number) => Buffer;
    private readonly replay: ReplayCache;
    private readonly overall: RateLimiter;
    private readonly pairLimit: RateLimiter;
    private readonly helloLimit: RateLimiter;
    private readonly bundleLimit: RateLimiter;

    constructor(private readonly deps: ServerDeps) {
        this.now = deps.now ?? Date.now;
        this.random = deps.randomBytes ?? nodeRandomBytes;
        this.replay = new ReplayCache(this.now);
        this.overall = new RateLimiter(RATE.requestsPerSecond, 1000, this.now);
        this.pairLimit = new RateLimiter(RATE.pairPerMinute, 60_000, this.now);
        this.helloLimit = new RateLimiter(RATE.helloPerMinutePerClient, 60_000, this.now);
        this.bundleLimit = new RateLimiter(RATE.bundlesPerMinutePerClient, 60_000, this.now);
    }

    get port(): number | null {
        return this.boundPort;
    }

    /**
     * Binds the first free port and persists it; resolves with the port. A call while a
     * bind is under way joins it: two listeners would leak one, and the loser would answer
     * everything with bad_host because boundPort names the other.
     */
    start(opts: StartOptions = {}): Promise<number> {
        if (this.server && this.boundPort !== null) return Promise.resolve(this.boundPort);
        if (!this.starting) {
            const starting = this.bind(opts);
            this.starting = starting;
            const clear = () => { if (this.starting === starting) this.starting = null; };
            starting.then(clear, clear);
        }
        return this.starting;
    }

    private async bind(opts: StartOptions): Promise<number> {
        const remembered = this.deps.pairing.port;
        const candidates = opts.ports
            ?? (remembered !== null && PORTS.includes(remembered) ? [remembered, ...PORTS.filter(p => p !== remembered)] : PORTS);

        for (const port of candidates) {
            const server = this.createServer();
            try {
                await new Promise<void>((resolve, reject) => {
                    server.once('error', reject);
                    // HOST is the literal 127.0.0.1: never 'localhost' (may resolve to ::1
                    // or elsewhere), never all interfaces.
                    server.listen({ host: HOST, port, exclusive: true }, () => {
                        server.off('error', reject);
                        resolve();
                    });
                });
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === 'EADDRINUSE' || code === 'EACCES') continue;
                throw err;
            }
            this.server = server;
            this.boundPort = (server.address() as AddressInfo).port;
            await this.deps.pairing.setPort(this.boundPort);
            return this.boundPort;
        }
        throw new Error(`No free port for the extension server among ${candidates.join(', ')}`);
    }

    async stop(): Promise<void> {
        // A stop issued mid-start must close what that start binds, not leave it running.
        if (this.starting) await this.starting.catch(() => undefined);
        const server = this.server;
        this.server = null;
        this.boundPort = null;
        if (!server) return;
        await new Promise<void>(resolve => {
            server.close(() => resolve());
            server.closeAllConnections();
        });
    }

    /** Drops a revoked client's replay state; its key is already gone from the store. */
    forgetClient(clientId: string): void {
        this.replay.forget(clientId);
    }

    private createServer(): http.Server {
        const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
            this.handle(req, res).catch(() => {
                if (!res.headersSent) this.sendError(req, res, new RequestError('internal'), null);
                else res.destroy();
            });
        });
        // A slow-loris caller holds a socket for at most this long.
        server.headersTimeout = 10_000;
        server.requestTimeout = 30_000;
        server.keepAliveTimeout = 5_000;
        server.maxHeadersCount = 64;
        return server;
    }

    // --- replies -----------------------------------------------------------------------

    private send(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        status: number,
        body: unknown,
        signer: Signer | null,
    ): void {
        const bytes = Buffer.from(JSON.stringify(body), 'utf8');
        const headers: Record<string, string | number> = {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': bytes.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        };
        if (signer) headers['X-OC-Sig'] = signResponse(signer.key, signer.endpoint, status, signer.nonce, bytes);
        if (status >= 400) {
            // An error may leave body bytes unread. Close rather than parse them as the
            // next request, and drain (discarding) so the close is graceful and the reply
            // is not lost to a TCP reset.
            headers['Connection'] = 'close';
        }
        res.writeHead(status, headers);
        res.end(bytes);
        if (status >= 400 && !req.complete) {
            req.removeAllListeners('data');
            req.resume();
            res.once('finish', () => setTimeout(() => req.socket.destroy(), 2_000).unref());
        }
    }

    private sendError(req: http.IncomingMessage, res: http.ServerResponse, err: RequestError, signer: Signer | null): void {
        const body = err.detail ? { error: err.code, detail: err.detail } : { error: err.code };
        this.send(req, res, ERROR_STATUS[err.code], body, signer);
    }

    // --- dispatch ----------------------------------------------------------------------

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let signer: Signer | null = null;
        try {
            await this.dispatch(req, res, s => { signer = s; });
        } catch (err) {
            if (res.headersSent) throw err;
            this.sendError(req, res, err instanceof RequestError ? err : new RequestError('internal'), signer);
        }
    }

    private async dispatch(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        identify: (signer: Signer) => void,
    ): Promise<void> {
        const port = this.boundPort;
        const endpoint = port === null ? '' : endpointFor(port);
        const method = req.method ?? '';
        const target = req.url ?? '';

        // (1) Host: a DNS-rebound web page arrives with its own hostname here.
        const host = header(req, 'host');
        if (port === null || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
            throw new RequestError('bad_host');
        }
        // (2) No preflight ever succeeds, and no response carries CORS headers, so a web
        // page cannot read anything even where it can reach the port.
        if (method === 'OPTIONS') throw new RequestError('forbidden');
        if (!this.overall.hit('*')) throw new RequestError('rate_limited');
        // (3)
        if (header(req, HEADER.proto) !== String(PROTO)) throw new RequestError('bad_proto');
        // (4) application/json is not a CORS-safelisted type: a page cannot send it
        // without a preflight, and the preflight fails at (2).
        if (method === 'POST' && !isJsonContentType(header(req, 'content-type'))) {
            throw new RequestError('bad_content_type');
        }
        // (5) Defence in depth only; the per-client match is checked once the client is known.
        const origin = header(req, 'origin');
        if (method === 'POST' && (!origin || !EXTENSION_ORIGIN.test(origin))) throw new RequestError('bad_origin');

        const path = target.split('?')[0];
        if (path === '/v1/pair') {
            if (method !== 'POST') throw new RequestError('method_not_allowed');
            return this.pair(req, res, origin!);
        }
        if (path === '/v1/hello') {
            if (method !== 'POST') throw new RequestError('method_not_allowed');
            return this.hello(req, res, origin!, endpoint);
        }

        const routes: Record<string, string> = { '/v1/status': 'GET', '/v1/workspaces': 'GET', '/v1/bundles': 'POST' };
        const auth = await this.authenticate(req, method, target, origin, endpoint, identify);
        const signer = { key: auth.key, nonce: header(req, HEADER.nonce)!, endpoint };
        void this.deps.pairing.touch(auth.record.clientId).catch(() => undefined);

        if (!(path in routes)) throw new RequestError('not_found');
        if (routes[path] !== method) throw new RequestError('method_not_allowed');

        if (path === '/v1/status') {
            this.send(req, res, 200, await this.deps.backend.status(), signer);
        } else if (path === '/v1/workspaces') {
            this.send(req, res, 200, { workspaces: await this.deps.backend.listWorkspaces() }, signer);
        } else {
            await this.bundle(req, res, auth, signer);
        }
    }

    /**
     * Identifies the client and checks the signature from headers alone, then reads the
     * body under the declared length. Returns only for a request that is authentic, fresh,
     * first-seen and whose body matches what was signed.
     */
    private async authenticate(
        req: http.IncomingMessage,
        method: string,
        target: string,
        origin: string | undefined,
        endpoint: string,
        identify: (signer: Signer) => void,
    ): Promise<Authenticated> {
        const clientId = header(req, HEADER.client);
        const ts = header(req, HEADER.ts);
        const nonce = header(req, HEADER.nonce);
        const bodySha256 = header(req, HEADER.bodySha256);
        const sig = header(req, HEADER.sig);
        if (!clientId || !B64URL_16.test(clientId) || !nonce || !B64URL_16.test(nonce)) {
            throw new RequestError('unauthenticated');
        }
        const client = this.deps.pairing.client(clientId);
        if (!client) throw new RequestError('unauthenticated');

        // Replies stay unsigned until the MAC verifies. Signing earlier would let anyone
        // who knows a clientId (it is in every request header) mint authentic-looking
        // terminal failures for any nonce they like; unsigned, the extension treats them
        // as network errors and retries.
        if (method === 'POST' && origin !== client.record.origin) throw new RequestError('bad_origin');
        if (!ts || !/^\d{1,16}$/.test(ts) || !bodySha256 || !SHA256_HEX.test(bodySha256) || !sig) {
            throw new RequestError('unauthenticated');
        }

        // Chunked bodies have no Content-Length: they are signed as "0" and so may not
        // carry a byte.
        const contentLength = header(req, 'content-length') ?? '0';
        if (!/^\d{1,12}$/.test(contentLength)) throw new RequestError('unauthenticated');
        const message = requestStringToSign({
            method,
            pathWithQuery: target,
            ts,
            nonce,
            clientId,
            contentLength,
            bodySha256,
            endpoint,
        });
        if (!verifyMac(client.key, message, sig)) throw new RequestError('bad_signature');
        // From here on every reply, errors included, is signed for this client.
        identify({ key: client.key, nonce, endpoint });
        if (Math.abs(this.now() - Number(ts)) > MAX_SKEW_MS) throw new RequestError('clock_skew');
        if (!this.replay.add(clientId, nonce)) throw new RequestError('replay');

        const cap = method === 'POST' ? MAX_CONTROL_BODY : 0;
        const declared = Number(contentLength);
        if (declared > cap) throw new RequestError('too_large');
        const body = await readBody(req, declared);
        const digest = sha256Hex(body);
        if (digest !== bodySha256) throw new RequestError('hash_mismatch');
        return { ...client, body, bodySha256: digest };
    }

    /** The handshake endpoints are unsigned, so they read small bodies only. */
    private async readHandshake(req: http.IncomingMessage): Promise<Record<string, unknown>> {
        const declared = header(req, 'content-length');
        if (declared !== undefined && Number(declared) > MAX_HANDSHAKE_BODY) throw new RequestError('too_large');
        const body = parseJson(await readBody(req, MAX_HANDSHAKE_BODY));
        if (!isRecord(body)) throw new RequestError('invalid', 'body must be a JSON object');
        return body;
    }

    // --- endpoints ---------------------------------------------------------------------

    private async pair(req: http.IncomingMessage, res: http.ServerResponse, origin: string): Promise<void> {
        // Nothing is read, let alone computed, unless the user has a pairing string up.
        if (!this.deps.pairing.hasActivePairing()) throw new RequestError('pair_expired');
        if (!this.pairLimit.hit('*')) throw new RequestError('rate_limited');
        const body = await this.readHandshake(req);
        const outcome = await this.deps.pairing.complete({
            pairingId: body.pairingId as string,
            clientNonce: body.clientNonce as string,
            extVersion: body.extVersion as string,
            proof: body.proof as string,
        }, origin);
        if (outcome.ok === false) throw new RequestError(outcome.error, outcome.detail);
        this.send(req, res, 200, outcome.response, null);
    }

    private async hello(req: http.IncomingMessage, res: http.ServerResponse, origin: string, endpoint: string): Promise<void> {
        const body = await this.readHandshake(req);
        const { clientId, clientNonce } = body;
        if (typeof clientId !== 'string' || !B64URL_16.test(clientId)) throw new RequestError('unauthenticated');
        const client = this.deps.pairing.client(clientId);
        if (!client) throw new RequestError('unauthenticated');
        if (origin !== client.record.origin) throw new RequestError('bad_origin');
        if (!this.helloLimit.hit(clientId)) throw new RequestError('rate_limited');
        if (typeof clientNonce !== 'string' || !B64URL_16.test(clientNonce)) {
            throw new RequestError('invalid', 'clientNonce: must be 16 bytes of base64url');
        }

        const instanceId = this.deps.pairing.instanceId;
        const serverNonce = b64url(this.random(16));
        const response: HelloResponse = {
            instanceId,
            serverNonce,
            serverProof: b64url(hmac(client.key, helloProofString(endpoint, clientNonce, serverNonce, instanceId))),
            proto: { min: PROTO, max: PROTO },
            appVersion: this.deps.appVersion,
        };
        await this.deps.pairing.touch(clientId);
        this.send(req, res, 200, response, null);
    }

    private async bundle(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        auth: Authenticated,
        signer: Signer,
    ): Promise<void> {
        if (!this.bundleLimit.hit(auth.record.clientId)) throw new RequestError('rate_limited');
        const checked = validateManifest(parseJson(auth.body));
        if (checked.ok === false) throw new RequestError('invalid', checked.detail);

        const outcome = await this.deps.backend.acceptBundle(checked.value, {
            clientId: auth.record.clientId,
            origin: auth.record.origin,
            extVersion: auth.record.extVersion,
            receivedAt: new Date(this.now()).toISOString(),
            bodySha256: auth.bodySha256,
        });
        if ('error' in outcome) throw new RequestError(outcome.error, outcome.detail);
        this.send(req, res, 200, outcome, signer);
    }
}
