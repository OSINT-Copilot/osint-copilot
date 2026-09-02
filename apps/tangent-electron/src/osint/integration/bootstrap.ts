/**
 * Starts OSINT Copilot inside a running Tangent workspace.
 *
 * The plugin source is unmodified: it still constructs an Obsidian `App` and calls the
 * Obsidian API. What changes is what sits underneath — the Vault shim reads and writes
 * through our own IPC (confined to the workspace Tangent has open), and its change
 * events are derived from Tangent's watcher rather than a second one of ours.
 *
 * Called once per workspace, after Tangent's own startup completes.
 */
// Loaded with the bootstrap so it only enters the bundle when a workspace opens.
// theme-bridge maps Obsidian's variables onto Tangent's, so the views follow the
// user's theme; styles.css is the plugin's own stylesheet, unmodified.
import '../theme-bridge.css';
import '../styles.css';
import { App } from '../obsidian-shim/app';
import { installDomExtensions } from '../obsidian-shim/dom/dom-extensions';
import { pushVaultEvents } from '../host/impl.tangent';
import { treeChangeToWatchEvents } from './vault-bridge';
import { openOsintSettings, openOsintView, openVaultNote, setTangentWorkspace } from './open-view';
import VaultAIPlugin from '../plugin/vault-ai-plugin';
import { OSINT_VERSION } from '../version';

export interface OsintRuntime {
    app: App;
    plugin: VaultAIPlugin;
    vaultRoot: string;
    dispose(): Promise<void>;
}

/** The manifest the plugin reads for its About row. */
const MANIFEST = {
    id: 'osint-copilot',
    name: 'OSINT Copilot',
    version: OSINT_VERSION,
    minAppVersion: '0.0.0',
    description: 'An OSINT investigation workspace built on local markdown notes.',
    author: 'Probe Point Analytics LLC',
};

let current: OsintRuntime | null = null;

/**
 * The live runtime, or null before startup / after teardown.
 *
 * Falls back to the global. This module is reached two ways — App.svelte imports it
 * dynamically, and Tangent.ts pulls it in statically through the view-state creator — so
 * relying on module-local state alone makes correctness depend on the bundler giving
 * both paths the same module instance. Reading the global is not sensitive to that.
 */
export function osintRuntime(): OsintRuntime | null {
    return current ?? ((globalThis as any).osint as OsintRuntime | undefined) ?? null;
}

/**
 * @param tangentWorkspace Tangent's renderer-side Workspace. Typed structurally so this
 *        module does not import across the app boundary, which keeps it testable.
 */
export async function startOsintCopilot(tangentWorkspace: {
    directoryStore: { files: { path: string } };
    commands: { createNewFile: { execute(context: unknown): unknown } };
    viewState: { tangent: { updateThread(options: unknown): void } };
}): Promise<OsintRuntime> {
    if (current) return current;

    // Obsidian patches createEl/createDiv/addClass/empty/setCssProps onto HTMLElement,
    // and the plugin calls them about 1,100 times — including from constructors, so
    // this has to happen before anything is built. Idempotent.
    installDomExtensions();

    const vaultRoot = tangentWorkspace.directoryStore.files.path;
    const app = await App.open(vaultRoot);

    // Tangent's watcher is the only one running over the tree. Its TreeChange stream
    // becomes the shim's create/modify/delete/rename events. `added` for a path the
    // index already holds is a modification, not a creation — Tangent re-integrates an
    // externally changed node rather than reporting it separately.
    const api = (globalThis as any).window?.api;
    api?.file?.onTreeChange((change: unknown) => {
        try {
            pushVaultEvents(treeChangeToWatchEvents(
                vaultRoot,
                change as never,
                path => app.vault.getAbstractFileByPath(path) !== null,
            ));
        } catch (e) {
            console.error('[osint] failed to apply a tree change', e);
        }
    });

    setTangentWorkspace(tangentWorkspace as never);

    // The shim keeps owning the leaf tree — osint-workspace-controller compares
    // leaf.getRoot() to rootSplit, and getLeavesOfType has twelve call sites — but
    // Tangent decides what is on screen. revealLeaf therefore navigates Tangent's thread
    // to the node backing that view, and openFile hands notes to Tangent's own editor
    // rather than the shim's.
    app.workspace.onRevealLeaf = leaf => {
        const viewType = leaf.view?.getViewType?.();
        if (viewType) openOsintView(viewType);
    };
    app.workspace.openMarkdownFile = file => { openVaultNote(file.path); };

    const plugin = new VaultAIPlugin(app, MANIFEST as never);
    plugin.load();
    // onload() is async. Obsidian never awaits it; we do, so a failure surfaces here
    // instead of as an unhandled rejection behind a half-initialised plugin.
    await plugin.whenLoaded();

    // The plugin's own commands are picked up on Tangent's side, by
    // app/model/commands/OsintViewCommands.ts, which waits for this runtime to appear.
    // The dependency points that way on purpose: importing Tangent from here would drag
    // its common/ tree into our strict typecheck.

    // chat-view.ts calls app.setting.open() / openTabById() to send the user to
    // settings. Route both at Tangent's preferences, on our page.
    (app as unknown as { setting: unknown }).setting = {
        open: () => openOsintSettings(),
        openTabById: () => openOsintSettings(),
    };

    current = {
        app,
        plugin,
        vaultRoot,
        async dispose() {
            try { plugin.unload(); } catch (e) { console.error('[osint] plugin teardown failed', e); }
            current = null;
        },
    };

    // Exposed for debugging and for the smoke checks; also how the view layer reaches
    // the plugin without threading it through Tangent's own object graph.
    (globalThis as any).osint = current;

    console.log(`[osint] started in ${vaultRoot}`);
    return current;
}
