/**
 * Node implementation of the host contract's in-process parts.
 *
 * Used by the Electron main process, and by the `osint` vitest project, which resolves
 * `host-impl` here. The renderer resolves `host-impl` to osint/host/impl.tangent.ts
 * through tsconfig paths (TsConfigPathsPlugin in webpack), so it never links this file.
 */
import type { ExecOptions, ExecResult, Host, HttpRequest, HttpResponse, PlatformInfo } from '../../osint/host/types';
import { resolveCliPath } from './node/cli';
import type { OpenVault } from './node/vault';
import * as secretStore from './node/secrets';
import { guardedFetch, BlockedRequestError } from './node/net-guard';
import { extractPdfText, extractDocxText } from './node/extract';

/**
 * Getters, not a snapshot: the resolve-binary-path suite overrides process.platform
 * with Object.defineProperty to exercise win32 branches, and a snapshot taken at
 * import time would defeat that.
 */
const platform: PlatformInfo = {
    get os() { return process.platform; },
    get homedir() { return (require('os') as typeof import('os')).homedir(); },
    get pathSep() { return (require('path') as typeof import('path')).sep; },
    get isFlatpak() { return process.platform === 'linux' && Boolean(process.env.FLATPAK_ID?.trim()); },
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
 * Only what runs in-process: main's own handlers call these, and so does the `osint`
 * vitest project. The renderer's other members (net, vault, basemap, inbox, extension)
 * reach main over IPC, where the handlers call requestFor and the node/ modules for the
 * sending window.
 */
export const host: Pick<Host, 'platform' | 'cli' | 'extract'> = {
    platform,
    cli: {
        resolve: resolveCliPath,
        exec,
        kill(execId: string) { running.get(execId)?.kill('SIGTERM'); },
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
