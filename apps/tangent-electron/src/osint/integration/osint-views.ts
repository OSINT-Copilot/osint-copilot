/**
 * Runtime helpers for the OSINT views. The descriptors themselves live in
 * osint-view-types.ts, which stays dependency-free so Tangent's shared modules can use
 * it without pulling the view layer in.
 */
import type { WorkspaceLeaf } from '../obsidian-shim/workspace/layout';
import { osintRuntime } from './bootstrap';
import { osintPluginState } from './osint-plugin-state';

/**
 * The Obsidian leaf holding this view, constructing it if needed.
 *
 * The shim's Workspace stays the owner of the leaf tree, so osint-workspace-controller
 * and the twelve getLeavesOfType call sites keep working untouched. Tangent renders
 * whichever leaf corresponds to the node it is showing.
 */
/**
 * Waits for the plugin to finish starting.
 *
 * Tangent restores the previous session before OSINT Copilot boots, so a workspace whose
 * last thread contained an OSINT view asks for its view state before the plugin exists —
 * and ViewStateContext caches states by path, so a state that gave up would never retry.
 * Waiting is what makes session restore work.
 */
async function waitForRuntime(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const runtime = osintRuntime();
        if (runtime) return runtime;
        // A failed start is final; waiting out the deadline just delays the message.
        if (osintPluginState.value.failed) return null;
        if (Date.now() > deadline) {
            console.error('[osint] plugin did not start within', timeoutMs, 'ms');
            return null;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

export async function leafForViewType(viewType: string): Promise<WorkspaceLeaf | null> {
    const runtime = await waitForRuntime();
    if (!runtime) return null;

    const workspace = runtime.app.workspace;
    const existing = workspace.getLeavesOfType(viewType);
    if (existing.length > 0) return existing[0];

    const leaf = workspace.getLeaf('tab');
    // active:false — Tangent decides what is on screen; this only builds the view.
    await leaf.setViewState({ type: viewType, active: false });
    return leaf;
}
