/**
 * Opening an OSINT view = putting its node into Tangent's thread.
 *
 * The marker file is created on first use and reused thereafter, so a workspace where
 * nobody opened a view stays clean. The node is looked up in the directory store before
 * creating: createNewFile uniquifies a name that already exists ("Entity Graph 1"),
 * which would spawn a fresh file on every open.
 *
 * Typed structurally on purpose: importing Tangent's classes here would pull its common/
 * tree into our strict typecheck.
 */
import { nodePathFor, viewForFileType, viewForViewType } from './osint-view-types';
import { osintPluginState } from './osint-plugin-state';

interface TangentNodeLike { path: string }

interface TangentWorkspaceLike {
    directoryStore: {
        files: { path: string };
        get(path: string): TangentNodeLike | undefined;
        /** Tangent's name resolver, as the wikilink autocompleter uses it. Optional: absent in tests. */
        getMatchesForPath?(path: string, options: { bestOnly: true }): TangentNodeLike | TangentNodeLike[] | undefined;
    };
    commands: { createNewFile: { execute(context: unknown): unknown } };
    /** Workspace.navigateTo: how a link click or the file tree opens a node in the thread. */
    navigateTo(data: {
        target: TangentNodeLike;
        origin?: TangentNodeLike | 'current';
        direction?: 'in' | 'out' | 'replace';
    }): void;
    viewState: {
        tangent: {
            updateThread(options: unknown): void;
            focusLevel: { value: number, set(value: number): void };
            thread: { value: TangentNodeLike[] };
        };
        system: { showMenu: { set(value: boolean): void }, section: { set(value: string): void } };
    };
}

/** Tangent's FocusLevel.Thread. Map is -1, and in Map mode no panel is rendered. */
const FOCUS_LEVEL_THREAD = 0;

let workspace: TangentWorkspaceLike | null = null;

export function setTangentWorkspace(value: TangentWorkspaceLike): void {
    workspace = value;
}

function absolutePathOf(relativePath: string): string {
    return `${workspace!.directoryStore.files.path}/${relativePath}`;
}

/** The node for this relative path, creating the file if it does not exist yet. */
function nodeFor(relativePath: string): TangentNodeLike | null {
    const existing = workspace!.directoryStore.get(absolutePathOf(relativePath));
    if (existing) return existing;

    const created = workspace!.commands.createNewFile.execute({
        relativePath,
        creationMode: 'createOrOpen',
        updateSelection: false,
    });
    return (created as TangentNodeLike) ?? null;
}

/** True when this node is one of the five OSINT views, judged by its file extension. */
function isOsintViewNode(node: TangentNodeLike): boolean {
    const dot = node.path.lastIndexOf('.');
    return dot >= 0 && viewForFileType(node.path.slice(dot)) !== undefined;
}

/**
 * In Map focus no thread panel is rendered at all, so opening a view while the map is up
 * would silently appear to do nothing. navigateTo raises the focus itself; the branches
 * that drive the thread directly have to.
 */
function raiseFocusOutOfMap(): void {
    const tangent = workspace!.viewState.tangent;
    if (tangent.focusLevel.value < FOCUS_LEVEL_THREAD) {
        tangent.focusLevel.set(FOCUS_LEVEL_THREAD);
    }
}

/** Defaults to 'switch' -- the setting is absent until the plugin has published it. */
function viewOpenMode(): 'switch' | 'alongside' {
    return osintPluginState.value.settings?.viewOpenMode === 'alongside' ? 'alongside' : 'switch';
}

/**
 * Puts the node in the thread the way Tangent itself opens things.
 *
 * Three branches, in order:
 *
 * - already in the thread: `thread: 'retain'` just moves the current marker, the way
 *   CreateNewFile does for an existing note. Without this, re-clicking an open view would
 *   truncate everything to its right.
 * - a VIEW, in 'switch' mode (the default): it becomes the whole thread, so the window
 *   shows one thing at a time -- a note, or a view, never a note beside a view. The pill
 *   then reads as a set of view modes rather than a way of building a split.
 * - otherwise: `navigateTo({ origin: 'current', direction: 'out' })`, which is the file
 *   tree's "Open to the Right" -- appends beside the current pane, and leaves Map focus
 *   on its own. This is how NOTES always open, whatever the mode, and how views open in
 *   'alongside' mode.
 */
export function show(node: TangentNodeLike): void {
    const ws = workspace!;
    const tangent = ws.viewState.tangent;

    if (isOsintViewNode(node) && viewOpenMode() === 'switch') {
        // The view is the ONLY thing on screen: you are reading a note or you are in a
        // view, never both. Unconditional on purpose -- checking "already open" first
        // would take the retain path for a thread like [note, chat], leaving the note
        // beside the view, which is the split this setting exists to remove. Re-clicking
        // the view a second time costs nothing: Tangent drops an update that would not
        // change the session state (Tangent.updateThread -> willItemChangeState). The
        // previous thread is not lost either -- the back arrow restores it.
        tangent.updateThread({ thread: [node], currentNode: node });
        raiseFocusOutOfMap();
        return;
    }

    // By path, not identity: a session restored with the marker file missing carries a
    // placeholder node for it, and nodeFor() then creates a fresh one. Identity said
    // "not in the thread" and, in alongside mode, appended a second pane for the same view.
    const already = tangent.thread.value.find((n) => n.path === node.path);
    if (already) {
        tangent.updateThread({ currentNode: already, thread: 'retain' });
        raiseFocusOutOfMap();
        return;
    }

    ws.navigateTo({ target: node, origin: 'current', direction: 'out' });
}

/** Navigates Tangent to the node backing `viewType`, creating it the first time. */
export function openOsintView(viewType: string): boolean {
    const view = viewForViewType(viewType);
    if (!view || !workspace) return false;
    try {
        const node = nodeFor(nodePathFor(view));
        if (!node) return false;
        show(node);
        return true;
    } catch (e) {
        console.error('[osint] could not open view', viewType, e);
        return false;
    }
}

/**
 * Navigates to a node ONLY if Tangent has already indexed it.
 *
 * Unlike openVaultNote, this never falls back to createNewFile. That fallback is right for
 * the marker files the OSINT views hang off -- they are empty by design -- but fatal for a
 * file with content: Tangent's createFile calls initializeContents(), which writes an empty
 * string, so navigating to a freshly written canvas before the watcher had indexed it
 * blanked the file we had just saved.
 */
export function openIndexedVaultNode(relativePath: string): boolean {
    if (!workspace) return false;
    try {
        const existing = workspace.directoryStore.get(absolutePathOf(relativePath));
        if (!existing) return false;
        show(existing as TangentNodeLike);
        return true;
    } catch (e) {
        console.error('[osint] could not open node', relativePath, e);
        return false;
    }
}

/**
 * Opens whatever a wikilink points at: a workspace-relative path, with or without its
 * extension, or a bare note name resolved the way Tangent resolves [[links]].
 *
 * Never creates anything. A link in an agent's answer can point at a note that does
 * not exist, and openVaultNote's createOrOpen would have turned every such click into a
 * new empty file.
 */
export function openVaultLink(target: string): boolean {
    if (!workspace) return false;
    const clean = target.split('#')[0].split('|')[0].trim();
    if (!clean) return false;
    const store = workspace.directoryStore;
    const hasExtension = /\.[A-Za-z0-9]+$/.test(clean);
    let node = store.get(absolutePathOf(clean))
        ?? (hasExtension ? undefined : store.get(absolutePathOf(`${clean}.md`)));
    if (!node && store.getMatchesForPath) {
        try {
            const match = store.getMatchesForPath(clean, { bestOnly: true });
            node = Array.isArray(match) ? match[0] : match ?? undefined;
        } catch {
            node = undefined;
        }
    }
    if (!node) return false;
    try {
        show(node);
        return true;
    } catch (e) {
        console.error('[osint] could not open link', clean, e);
        return false;
    }
}

/** Navigates Tangent to a vault note, by workspace-relative path. */
export function openVaultNote(relativePath: string): boolean {
    if (!workspace) return false;
    try {
        const node = nodeFor(relativePath);
        if (!node) return false;
        show(node);
        return true;
    } catch (e) {
        console.error('[osint] could not open note', relativePath, e);
        return false;
    }
}

/** The name of our page in Tangent's preferences; must match System.svelte. */
const OSINT_SETTINGS_SECTION = 'OSINT Copilot';

/** Opens Tangent's preferences on the OSINT Copilot page. */
export function openOsintSettings(): boolean {
    if (!workspace) return false;
    try {
        workspace.viewState.system.section.set(OSINT_SETTINGS_SECTION);
        workspace.viewState.system.showMenu.set(true);
        return true;
    } catch (e) {
        console.error('[osint] could not open settings', e);
        return false;
    }
}
