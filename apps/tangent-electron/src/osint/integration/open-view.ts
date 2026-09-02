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
