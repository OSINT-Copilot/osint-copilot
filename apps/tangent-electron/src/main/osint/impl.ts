/**
 * Node implementation of the host contract.
 *
 * Used by the Electron main process and by vitest. The sandboxed renderer never
 * links this file -- esbuild aliases ./impl to ./impl.bridge for that target.
 */
import type { ExecOptions, ExecResult, Host, HttpRequest, HttpResponse, PlatformInfo, WatchEvent } from '../../osint/host/types';
import { resolveCliPath } from './node/cli';
import { OpenVault } from './node/vault';
import * as secretStore from './node/secrets';
import { guardedFetch, BlockedRequestError } from './node/net-guard';
import { extractPdfText, extractDocxText } from './node/extract';
import * as basemapStore from './node/basemap';

/**
 * Getters, not a snapshot: the resolve-binary-path suite overrides process.platform
 * with Object.defineProperty to exercise win32 branches, and a snapshot taken at
 * import time would defeat that.
 */
const platform: PlatformInfo = {
    get os() { return process.platform; },
    get arch() { return process.arch; },
    get homedir() { return (require('os') as typeof import('os')).homedir(); },
    get pathSep() { return (require('path') as typeof import('path')).sep; },
    get pathDelimiter() { return (require('path') as typeof import('path')).delimiter; },
    get isFlatpak() { return process.platform === 'linux' && Boolean(process.env.FLATPAK_ID?.trim()); },
    get electron() { return process.versions.electron ?? ''; },
    get chrome() { return process.versions.chrome ?? ''; },
};

const running = new Map<string, import('child_process').ChildProcess>();

async function exec(execId: string, binary: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const { execFile } = require('child_process') as typeof import('child_process');

    return new Promise<ExecResult>((resolve) => {
        const child = execFile(
            binary,
            args,
            {
                cwd: options.cwd,
                timeout: options.timeoutMs,
                maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
                env: { ...process.env, ...(options.envOverrides ?? {}) },
            },
            (error, stdout, stderr) => {
                running.delete(execId);
                // ExecFileException.code is string | number | null (an errno like 'ENOENT'
                // for spawn failures, an exit status for a process that ran and failed).
                resolve({
                    stdout: String(stdout ?? ''),
                    stderr: String(stderr ?? ''),
                    code: error?.code ?? (error ? 1 : 0),
                    signal: error?.signal ?? null,
                    killed: Boolean(error?.killed),
                    errorMessage: error?.message,
                });
            },
        );

        running.set(execId, child);

        if (options.stdin !== undefined && child.stdin) {
            // An unhandled EPIPE here crashed the Obsidian renderer; keep the guard.
            child.stdin.on('error', () => { /* ignore EPIPE */ });
            child.stdin.write(options.stdin);
            child.stdin.end();
        }
    });
}

/**
 * How much of a response body main will hold.
 *
 * `response.arrayBuffer()` decompresses without limit, so a 199KB gzip bomb becomes
 * hundreds of megabytes in the main process -- and main has no renderer to crash instead
 * of it. Reading the stream and stopping lets an oversized body fail as a request rather
 * than as an out-of-memory.
 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** A wall-clock ceiling, so a slow-drip response cannot pin memory indefinitely. */
const REQUEST_TIMEOUT_MS = 60_000;

async function readCapped(response: Response, limit: number): Promise<ArrayBuffer> {
    const body = response.body;
    // No stream (204, HEAD, or a stub in tests): the body is already small or absent.
    if (!body) return response.arrayBuffer();

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) {
                // Cancel rather than drain: the point is to stop receiving.
                await reader.cancel();
                throw new BlockedRequestError(
                    `Response from ${response.url || 'the server'} exceeded ${limit} bytes.`);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out.buffer;
}

/**
 * @param vault  The vault a `vault-file` credential is read from -- the requesting
 *               window's own. Main's IPC handler passes the sender's; see resolveSecret.
 */
export async function requestFor(req: HttpRequest, vault: OpenVault | null): Promise<HttpResponse> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {
        ...(req.contentType ? { 'Content-Type': req.contentType } : {}),
        ...(req.headers ?? {}),
    };

    // Secrets are resolved and injected HERE, never in the renderer.
    if (req.auth) {
        const secret = await secretStore.resolveSecret(req.auth.ref, vault);
        if (!secret) {
            throw new Error(
                `Missing credential (${req.auth.ref.source}: ${req.auth.ref.name})`,
            );
        }
        if (req.auth.placement === 'bearer') {
            headers.Authorization = `Bearer ${secret}`;
        } else if (req.auth.placement === 'header') {
            headers[req.auth.headerName || 'X-API-Key'] = secret;
        } else {
            url.searchParams.set(req.auth.queryParam || 'api_key', secret);
        }
    }

    // Allowlist + private-address denial, after any auth rewrote the URL, and re-applied
    // to every redirect hop rather than only to the URL the caller passed.
    // Names the header the caller's auth was injected into, so guardedFetch can strip it
    // if a redirect crosses origins.
    const credentialHeaders = req.auth?.placement === 'header'
        ? [req.auth.headerName || 'X-API-Key']
        : [];

    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await guardedFetch(url.toString(), {
        method: req.method ?? 'GET',
        headers,
        body: req.body,
        signal: timeout,
    }, req.allowedDomains, credentialHeaders);

    const arrayBuffer = await readCapped(response, MAX_RESPONSE_BYTES);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value; });

    if (req.throw !== false && response.status >= 400) {
        throw Object.assign(new Error(`Request failed, status ${response.status}`), { status: response.status });
    }

    return {
        status: response.status,
        headers: responseHeaders,
        arrayBuffer,
        text: new TextDecoder().decode(arrayBuffer),
    };
}

/**
 * The vault of the in-process host object below, and nothing else's.
 *
 * Main's IPC handlers never go through `host.vault`: each window's vault is its own
 * OpenVault, looked up by sender (node/vault.ts). This one serves the callers that have
 * no sender -- vitest, which resolves `host-impl` to this file -- and, being a separate
 * instance, cannot be confused with any window's. In the running app it is never opened,
 * so `host.secrets.has` / `host.net.request` find no vault-file credentials through it.
 */
let hostVault: OpenVault | null = null;
/** Survive a reopen, as they did when the watcher was module-level. */
const hostVaultListeners = new Set<(events: WatchEvent[]) => void>();

function requireHostVault(): OpenVault {
    if (!hostVault) throw new Error('No vault is open');
    return hostVault;
}

const NO_WINDOW = 'The browser extension inbox is only reachable from an app window.';

export const host: Host = {
    platform,
    secrets: {
        has: (ref) => secretStore.hasSecret(ref, hostVault),
        setKeychain: secretStore.setKeychain,
        deleteKeychain: secretStore.deleteKeychain,
        listKeychain: secretStore.listKeychain,
    },
    cli: {
        resolve: resolveCliPath,
        exec,
        kill(execId: string) { running.get(execId)?.kill('SIGTERM'); },
    },
    net: { request: (req) => requestFor(req, hostVault) },
    vault: {
        async open(dir: string) {
            const { vault, snapshot } = await OpenVault.open(dir);
            const previous = hostVault;
            hostVault = vault;
            vault.onChange((events) => { for (const listener of hostVaultListeners) listener(events); });
            await previous?.close();
            return snapshot;
        },
        basePath: () => hostVault?.root ?? '',
        read: (p) => requireHostVault().read(p),
        readBinary: (p) => requireHostVault().readBinary(p),
        write: (p, d) => requireHostVault().write(p, d),
        writeBinary: (p, d) => requireHostVault().writeBinary(p, d),
        create: (p, d) => requireHostVault().create(p, d),
        mkdir: (p) => requireHostVault().mkdir(p),
        remove: (p) => requireHostVault().remove(p),
        // Electron's shell.trashItem is only available in main; under vitest this
        // degrades to a plain remove, which is what the tests want anyway.
        trash: (p) => requireHostVault().remove(p),
        rename: (from, to) => requireHostVault().rename(from, to),
        stat: (p) => requireHostVault().stat(p),
        onChange(callback) {
            hostVaultListeners.add(callback);
            return () => hostVaultListeners.delete(callback);
        },
        // Same file:// shape as the renderer host. It used to mint `osint-vault://`, a
        // scheme nothing registers -- and this is the implementation the `osint` vitest
        // project resolves `host-impl` to, so a test would have proved the wrong thing.
        resourceUrl: (path: string) => {
            const encode = (value: string) =>
                value.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
            const root = encode(hostVault?.root ?? '').replace(/^([A-Za-z])%3A/i, '$1:');
            return `file://${root.startsWith('/') ? root : `/${root}`}/${encode(path)}`;
        },
    },
    basemap: {
        pick: () => basemapStore.pick(),
        open: () => basemapStore.open(),
        forget: () => basemapStore.forget(),
        read: (handleId: string, offset: number, length: number) => basemapStore.read(handleId, offset, length),
        close: (handleId: string) => basemapStore.close(handleId),
    },
    // The inbox and the extension controls exist only per window, over IPC: main answers
    // for the calling window's own investigation, and a caller with no window has none.
    inbox: {
        claim: async () => { throw new Error(NO_WINDOW); },
        release: async () => { throw new Error(NO_WINDOW); },
        list: async () => { throw new Error(NO_WINDOW); },
        step: async () => { throw new Error(NO_WINDOW); },
        finish: async () => { throw new Error(NO_WINDOW); },
        markRemoved: async () => { throw new Error(NO_WINDOW); },
        listApplied: async () => { throw new Error(NO_WINDOW); },
        placeFiles: async () => { throw new Error(NO_WINDOW); },
        onChanged: () => () => undefined,
    },
    extension: {
        status: async () => { throw new Error(NO_WINDOW); },
        setEnabled: async () => { throw new Error(NO_WINDOW); },
        pairBegin: async () => { throw new Error(NO_WINDOW); },
        pairCancel: async () => { throw new Error(NO_WINDOW); },
        revoke: async () => { throw new Error(NO_WINDOW); },
    },
    // Overridden in main (electron/ipc) where dialog and userData exist; inert under vitest.
    app: {
        async pickVault() { return null; },
        async lastVault() { return null; },
        async rememberVault() { /* no-op outside Electron */ },
    },
    extract: {
        // A static import of extract.ts is cheap: the module is small and pdfjs itself
        // stays deferred inside loadPdfJs(), which requires it on first use. A relative
        // require() here would not resolve under vitest, and a dynamic import() needs
        // `module` set on Tangent's main tsconfig, which is an upstream file.
        pdfText: (data: ArrayBuffer) => extractPdfText(data),
        docxText: async (data: ArrayBuffer) => extractDocxText(data),
    },
};
