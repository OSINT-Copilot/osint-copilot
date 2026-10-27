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
import { publishOsintPluginState } from './osint-plugin-state';
import VaultAIPlugin from '../plugin/vault-ai-plugin';
import { OSINT_VERSION } from '../version';
import { viewForFileType } from './osint-view-types';

export interface OsintRuntime {
    app: App;
    plugin: VaultAIPlugin;
    vaultRoot: string;
}

/** The manifest the plugin reads for its About row. */
const MANIFEST = {
    id: 'osint-copilot',
    name: 'OSINT Copilot',
    version: OSINT_VERSION,
    minAppVersion: '0.0.0',
    description: 'An OSINT investigation workspace built on local markdown notes.',
    author: 'OSINT Copilot contributors',
};

let current: OsintRuntime | null = null;
/** The start in progress, so two overlapping calls share one plugin instead of building two. */
let starting: Promise<OsintRuntime> | null = null;

/**
 * The live runtime, or null before startup.
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
    if (starting) return starting;
    starting = startOsintCopilotUncached(tangentWorkspace).catch((e) => {
        // Published so the view host and the settings page can say "did not start" at
        // once, rather than each waiting out a 60-second timeout and then blaming view
        // registration. App.svelte's own catch only logs.
        publishOsintPluginState({ ready: false, settings: null, failed: String(e?.message ?? e) });
        throw e;
    });
    try {
        return await starting;
    } finally {
        starting = null;
    }
}

/**
 * The first-run tour, shown once per vault.
 *
 * Here rather than in the plugin's onload() for the reason the rest of this file exists:
 * onload() is Obsidian-shaped plugin code, and "what the shell does after the plugin is
 * up" belongs on this side of the seam. It is also the first point at which navigating to
 * the Guide view can actually work.
 */
async function showWelcomeIfFirstRun(app: App, plugin: VaultAIPlugin): Promise<void> {
    try {
        if (plugin.settings.hasSeenWelcomeGuide) return;

        // Written BEFORE the dialog is shown, not after it is dismissed: a crash or a
        // force-quit while the tour is open should not mean seeing it again every launch.
        plugin.settings.hasSeenWelcomeGuide = true;
        await plugin.saveSettings();

        const docs = viewForFileType('.osintdocs');
        const { WelcomeModal } = await import('../modals/welcome-modal');
        new WelcomeModal(app, {
            openGuide: () => { if (docs) openOsintView(docs.viewType); },
        }).open();
    }
    catch (e) {
        console.error('[osint] could not show the welcome guide', e);
    }
}

async function startOsintCopilotUncached(tangentWorkspace: Parameters<typeof startOsintCopilot>[0]): Promise<OsintRuntime> {
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
    // Now the toolbar's canvas command can run and its gate has real settings to read.
    publishOsintPluginState({ ready: true, settings: plugin.settings });

    // Not awaited: the tour is for the user to read at their pace, and startup should not
    // block on a dialog. Failures are swallowed -- a broken tour must not stop the app.
    void showWelcomeIfFirstRun(app, plugin);

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
    // entity-modal.ts reaches the plugin through Obsidian's `app.plugins` registry (for
    // the schema catalog and the family/layer toggles). Without it every one of those
    // lookups was null: eight settings toggles did nothing, and four un-guarded sites
    // threw before the type picker rendered.
    (app as unknown as { plugins: unknown }).plugins = {
        plugins: { 'osint-copilot': plugin },
        getPlugin: (id: string) => (id === 'osint-copilot' ? plugin : null),
    };

    current = { app, plugin, vaultRoot };

    // Exposed for debugging and for the smoke checks; also how the view layer reaches
    // the plugin without threading it through Tangent's own object graph.
    (globalThis as any).osint = current;

    console.debug(`[osint] started in ${vaultRoot}`);
    return current;
}
