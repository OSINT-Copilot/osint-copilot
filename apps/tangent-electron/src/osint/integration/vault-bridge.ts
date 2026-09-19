/**
 * Turns Tangent's TreeChange stream into the four vault events the Obsidian shim
 * expects, so exactly one filesystem watcher runs over the workspace.
 *
 * Tangent already watches the workspace recursively (main/Workspace.ts). On any
 * filesystem event it re-reads the tree at that path and emits a TreeChange. Crucially,
 * an *existing* node that changed on disk comes back under `added` with a fresh
 * `modified` timestamp — Tangent integrates it into the store rather than reporting it
 * separately — so `added` maps to `create` or `modify` depending on whether the shim's
 * index already knows the path. `changed` is metadata-only (the indexer re-parsing a
 * file), which is also a `modify` as far as the shim is concerned.
 *
 * Paths: Tangent's are absolute, Obsidian's are workspace-relative and NFC-normalised.
 *
 * Virtual nodes are dropped. Tangent creates one for every unresolved `[[wikilink]]` so
 * the link has somewhere to point, and our entity note template ships placeholder links
 * ("[[Entity Name]]", "[[Target Entity]]"). Forwarding those as 'create' sends the
 * plugin's indexer to read files that do not exist, once per link per reindex.
 */
import { normalizePath } from '../obsidian-shim/vault/normalize-path';
import type { StatDto, WatchEvent } from '../host/types';

/** The shape of Tangent's TreeNode that we depend on. Kept structural to avoid importing across the app boundary. */
interface TangentNode {
    path: string;
    fileType?: string;
    created?: Date | string | number;
    modified?: Date | string | number;
    /** Tangent's index data. `virtual: true` means the node has no file behind it. */
    meta?: { virtual?: boolean };
}

interface TangentTreeChange {
    added?: TangentNode[];
    removed?: string[];
    changed?: TangentNode[];
    moved?: { oldPath: string; node: TangentNode }[];
}

function millis(value: Date | string | number | undefined): number {
    if (value === undefined) return 0;
    const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
}

function toVaultPath(root: string, absolute: string): string {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    const relative = absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
    return normalizePath(relative);
}

/**
 * `size` is 0 for events derived from the tree: Tangent's TreeNode does not carry one.
 * The shim uses path+mtime+size as its read-cache key, and mtime alone is enough to
 * invalidate — every write moves it. Writes that go through the shim itself do supply a
 * real size, because those stats come back from our own vault IPC.
 */
function statOf(root: string, node: TangentNode): StatDto {
    return {
        path: toVaultPath(root, node.path),
        type: node.fileType === 'folder' ? 'folder' : 'file',
        ctime: millis(node.created),
        mtime: millis(node.modified),
        size: 0,
    };
}

/**
 * @param knows  Whether the shim's index already has this path. An `added` node it
 *               already knows about is a modification, not a creation.
 */
export function treeChangeToWatchEvents(
    root: string,
    change: TangentTreeChange,
    knows: (path: string) => boolean,
): WatchEvent[] {
    const events: WatchEvent[] = [];

    for (const node of change.added ?? []) {
        if (node.meta?.virtual) continue;
        const stat = statOf(root, node);
        events.push({ kind: knows(stat.path) ? 'modify' : 'create', path: stat.path, stat });
    }

    for (const node of change.changed ?? []) {
        if (node.meta?.virtual) continue;
        const stat = statOf(root, node);
        events.push({ kind: 'modify', path: stat.path, stat });
    }

    for (const move of change.moved ?? []) {
        const stat = statOf(root, move.node);
        events.push({ kind: 'rename', path: stat.path, oldPath: toVaultPath(root, move.oldPath), stat });
    }

    for (const removed of change.removed ?? []) {
        events.push({ kind: 'delete', path: toVaultPath(root, removed) });
    }

    return events;
}
