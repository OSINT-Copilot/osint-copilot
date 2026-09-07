/**
 * Renderer implementation of the host contract, on top of Tangent's preload bridge.
 *
 * Replaces the standalone app's own `window.host`: everything now goes through
 * `window.api.osint`, which Tangent's preload exposes (see common/WindowApi.ts).
 *
 * There is deliberately no fallback. A missing bridge is a wiring bug and should fail
 * loudly rather than silently degrade into a half-working app.
 */
import type { Host, StatDto, WatchEvent } from './types';

function api() {
    const injected = (globalThis as any).window?.api?.osint;
    if (!injected) {
        throw new Error(
            'OSINT host bridge unavailable: preload did not run, or window.api.osint is missing.',
        );
    }
    return injected;
}

/**
 * The vault root, cached so `basePath()` can stay synchronous — it is the cwd handed to
 * every CLI runtime, and the shim reads it during construction.
 */
let vaultRoot = '';

/**
 * Vault change events do not come from a watcher of ours. Tangent already watches the
 * workspace recursively; the integration layer converts its TreeChange stream into
 * WatchEvents and pushes them here, so exactly one watcher runs over the tree.
 */
const changeListeners = new Set<(events: WatchEvent[]) => void>();

/**
 * Echo suppression for our own writes.
 *
 * The Vault shim emits its events synchronously from the mutating call, the way
 * Obsidian does. Tangent's watcher then reports the same write about half a second
 * later (its dirty-cache debounce), which would arrive as a second `modify`. Left
 * unsuppressed that becomes a loop: modify -> the four watched-folder registries
 * invalidate -> the schema catalog rebuilds -> whatever that writes starts it again.
 *
 * Content writes are keyed on path+mtime so an genuinely newer external edit still gets
 * through. Deletes have no mtime, so they are keyed on path alone.
 */
const selfWrites = new Map<string, number>();
const SELF_WRITE_TTL_MS = 5000;

function markSelfWrite(key: string): void {
    selfWrites.set(key, Date.now());
    if (selfWrites.size > 512) {
        const cutoff = Date.now() - SELF_WRITE_TTL_MS;
        for (const [k, at] of selfWrites) if (at < cutoff) selfWrites.delete(k);
    }
}

function stamp<T extends StatDto>(stat: T): T {
    markSelfWrite(`w:${stat.path}:${stat.mtime}`);
    return stat;
}

function isSelfWrite(event: WatchEvent): boolean {
    const key = event.kind === 'delete'
        ? `d:${event.path}`
        : `w:${event.path}:${event.stat?.mtime}`;
    const at = selfWrites.get(key);
    if (at === undefined) return false;
    selfWrites.delete(key);
    return Date.now() - at < SELF_WRITE_TTL_MS;
}

/** Called by the integration layer (see integration/vault-bridge.ts). */
export function pushVaultEvents(events: WatchEvent[]): void {
    const fresh = events.filter(event => !isSelfWrite(event));
    if (fresh.length === 0) return;
    for (const listener of changeListeners) listener(fresh);
}

/** Encodes each segment separately, so separators survive and everything else is escaped. */
function encodePathSegments(value: string): string {
    return value.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}

/**
 * The vault root as the authority-and-path part of a file:// URL.
 *
 * Windows needs both fixes: `C:\\vault` has no separator to split on, so the drive colon
 * would be escaped to `C%3A` -- which is a hostname, not a path -- and there is no leading
 * slash for `file://` to hang the absolute path from.
 */
function fileUrlRoot(root: string): string {
    const encoded = encodePathSegments(root).replace(/^([A-Za-z])%3A/i, '$1:');
    return encoded.startsWith('/') ? encoded : `/${encoded}`;
}

export const host: Host = {
    get platform() { return api().platform(); },
    secrets: {
        has: (ref) => api().secrets.has(ref),
        setKeychain: (name, value) => api().secrets.setKeychain(name, value),
        deleteKeychain: (name) => api().secrets.deleteKeychain(name),
        listKeychain: () => api().secrets.listKeychain(),
    },
    cli: {
        resolve: (configured, fallback, extras, timeout) => api().cli.resolve(configured, fallback, extras, timeout),
        exec: (execId, binary, args, options) => api().cli.exec(execId, binary, args, options),
        kill: (execId) => api().cli.kill(execId),
    },
    net: { request: (req) => api().net.request(req) },
    extract: {
        pdfText: (data) => api().extract.pdfText(data),
        docxText: (data) => api().extract.docxText(data),
    },
    vault: {
        async open(dir: string): Promise<StatDto[]> {
            const snapshot = await api().vault.open(dir);
            vaultRoot = dir;
            return snapshot;
        },
        basePath: () => vaultRoot,
        read: (p) => api().vault.read(p),
        readBinary: (p) => api().vault.readBinary(p),
        write: (p, data) => api().vault.write(p, data).then(stamp),
        writeBinary: (p, data) => api().vault.writeBinary(p, data).then(stamp),
        create: (p, data) => api().vault.create(p, data).then(stamp),
        mkdir: (p) => api().vault.mkdir(p).then(stamp),
        async remove(p) { markSelfWrite(`d:${p}`); return api().vault.remove(p); },
        async trash(p) { markSelfWrite(`d:${p}`); return api().vault.trash(p); },
        async rename(from, to) { markSelfWrite(`d:${from}`); return api().vault.rename(from, to); },
        stat: (p) => api().vault.stat(p),
        onChange(callback) {
            changeListeners.add(callback);
            return () => changeListeners.delete(callback);
        },
        /**
         * Tangent serves its window from file://, so a vault image can be referenced
         * directly. `?v=<mtime>` busts Electron's image cache, which otherwise serves a
         * stale thumbnail forever after a re-import.
         *
         * Per-segment encoding, not encodeURI: entity labels routinely contain spaces, #,
         * ? and &. The space matters twice over -- cytoscape's `background-image` is a
         * multi-valued `urls` property that splits a mapped value on /\s+/, so a single
         * unencoded space silently becomes two URLs, neither of which loads.
         */
        resourceUrl(p: string): string {
            return `file://${fileUrlRoot(vaultRoot)}/${encodePathSegments(p)}`;
        },
    },
    basemap: {
        pick: () => api().basemap.pick(),
        open: () => api().basemap.open(),
        forget: () => api().basemap.forget(),
        read: (handleId, offset, length) => api().basemap.read(handleId, offset, length),
        close: (handleId) => api().basemap.close(handleId),
    },
    app: {
        async pickVault() {
            throw new Error('host.app.pickVault is not used under Tangent: it owns workspace selection.');
        },
        async lastVault() { return vaultRoot || null; },
        async rememberVault() { /* Tangent persists the open workspace itself. */ },
    },
};
