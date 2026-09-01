/**
 * Renderer implementation of the host contract, on top of Tangent's preload bridge.
 *
 * Replaces the standalone app's own `window.host`: everything now goes through
 * `window.api.osint`, which Tangent's preload exposes (see common/WindowApi.ts).
 *
 * There is deliberately no fallback. A missing bridge is a wiring bug and should fail
 * loudly rather than silently degrade into a half-working app.
 */
import type { Host, VaultHost } from './types';

function api() {
    const injected = (globalThis as any).window?.api?.osint;
    if (!injected) {
        throw new Error(
            'OSINT host bridge unavailable: preload did not run, or window.api.osint is missing.',
        );
    }
    return injected as Host & { platform(): Host['platform'] };
}

/**
 * File I/O is Tangent's job, not ours: the Vault shim is re-pointed at Tangent's
 * DirectoryStore and `window.api.file` in phase 2. Until then these throw rather than
 * pretend, so a premature caller is obvious.
 */
const notYetWired = (member: string) => () => {
    throw new Error(
        `host.${member} is not wired yet: the Vault shim moves onto Tangent's DirectoryStore in phase 2.`,
    );
};

const vault = new Proxy({} as VaultHost, {
    get: (_target, prop) => notYetWired(`vault.${String(prop)}`),
});

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
    vault,
    app: {
        pickVault: notYetWired('app.pickVault'),
        lastVault: notYetWired('app.lastVault'),
        rememberVault: notYetWired('app.rememberVault'),
    },
};
