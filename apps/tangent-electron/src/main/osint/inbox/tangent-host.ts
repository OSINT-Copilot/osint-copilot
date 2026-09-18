/**
 * The inbox's view of Tangent's bookkeeping: which workspaces exist and which windows
 * have one open.
 *
 * Structural rather than importing main/workspaces, for the reason guarded-ipc.ts gives:
 * this folder is inside `typecheck:osint`, and Tangent's tree does not build under strict
 * null checks. index.ts passes the real workspaceMap and contentsMap in; tests pass maps
 * of their own (or the real ones).
 */
import * as fs from 'fs';
import type { InboxHost } from './inbox-writer';

/** The part of a WebContents the inbox uses: it is the key of contentsMap. */
export interface WindowContents {
    isDestroyed(): boolean;
    send(channel: string, ...args: unknown[]): void;
}

/** The part of a WindowHandle the inbox reads. */
export interface WindowLike {
    assignedWorkspacePath?: string | null;
    workspace?: { rootPath?: string | null } | null;
}

export interface TangentMaps {
    /** Tangent's workspaceMap: every known workspace, loaded or not. */
    workspaceMap: Map<string, unknown>;
    /** Tangent's contentsMap: every application window, by its webContents. */
    contentsMap: Map<WindowContents, WindowLike>;
    documentationPath(): string | null;
}

/** A window's workspace, as main itself assigned it. Null for a window with none. */
export function workspacePathOf(handle: WindowLike | undefined | null): string | null {
    return handle?.assignedWorkspacePath || handle?.workspace?.rootPath || null;
}

function realpathOrNull(p: string): string | null {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return null;
    }
}

export function tangentInboxHost(maps: TangentMaps): InboxHost {
    return {
        knownRoots: () => [...maps.workspaceMap.keys()],
        openRoots() {
            const roots: string[] = [];
            for (const handle of maps.contentsMap.values()) {
                if (handle.assignedWorkspacePath) roots.push(handle.assignedWorkspacePath);
                if (handle.workspace?.rootPath) roots.push(handle.workspace.rootPath);
            }
            return roots;
        },
        documentationPath: () => maps.documentationPath(),
        notify(realRoot, channel) {
            for (const [contents, handle] of maps.contentsMap) {
                if (contents.isDestroyed()) continue;
                const candidates = [handle.assignedWorkspacePath, handle.workspace?.rootPath];
                // Realpath, never a prefix test: '/cases/a' is not '/cases/ab'.
                if (candidates.some(p => !!p && realpathOrNull(p) === realRoot)) contents.send(channel);
            }
        },
    };
}
