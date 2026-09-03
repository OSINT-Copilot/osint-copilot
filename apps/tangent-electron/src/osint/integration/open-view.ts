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
import { nodePathFor, viewForViewType } from './osint-view-types';

interface TangentNodeLike { path: string }

interface TangentWorkspaceLike {
    directoryStore: { files: { path: string }, get(path: string): TangentNodeLike | undefined };
    commands: { createNewFile: { execute(context: unknown): unknown } };
    viewState: {
        tangent: {
            updateThread(options: unknown): void;
            focusLevel: { value: number, set(value: number): void };
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

export function tangentWorkspace(): TangentWorkspaceLike | null {
    return workspace;
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

function show(node: TangentNodeLike): void {
    const tangent = workspace!.viewState.tangent;
    tangent.updateThread({ currentNode: node });
    // In Map focus the thread panels are not rendered at all, so opening a view while
    // the map is up would silently appear to do nothing.
    if (tangent.focusLevel.value < FOCUS_LEVEL_THREAD) {
        tangent.focusLevel.set(FOCUS_LEVEL_THREAD);
    }
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
export const OSINT_SETTINGS_SECTION = 'OSINT Copilot';

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
