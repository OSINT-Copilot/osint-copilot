/**
 * Plugs the OSINT views into Tangent's view-state system.
 *
 * Tangent's ViewStateContext carries an ordered `creators` array — the author's own
 * comment there says it is the intended plugin seam. A creator is handed a TreeNode and
 * returns a NodeViewState, or nothing to let the next creator try. Ours answers for the
 * five OSINT file types and declines everything else, so Tangent's own handling of
 * notes, folders, images, PDFs and queries is untouched.
 *
 * Everything here is typed structurally rather than importing Tangent's types, so this
 * file stays inside the strict typecheck for our subtree (importing across the boundary
 * would drag Tangent's common/ tree in under strictNullChecks, where it reports ~1,500
 * errors in code we do not own).
 */
import OsintViewHost from './OsintViewHost.svelte';
import CanvasView from '../canvas/CanvasView.svelte';
import { CANVAS_FILE_TYPE } from '../canvas/canvas-file-type';
import { leafForViewType } from './osint-views';
import { viewForFileType } from './osint-view-types';
import type { WorkspaceLeaf } from '../obsidian-shim/workspace/layout';

interface MinimalNode {
    path: string;
    name?: string;
    fileType?: string;
}

/** Svelte's store contract: subscribe(run) runs immediately and returns an unsubscribe. */
function constant<T>(value: T) {
    return {
        value,
        subscribe(run: (v: T) => void) {
            run(value);
            return () => { /* never changes */ };
        },
    };
}

/**
 * A lens is what NodeViewSelector actually renders. Ours has a single one: the host
 * component that mounts the Obsidian ItemView's DOM.
 */
export class OsintNodeViewState {
    readonly node: MinimalNode;
    readonly viewType: string;
    readonly currentLens: ReturnType<typeof constant<unknown>>;

    /** Resolves to the Obsidian leaf whose view this panel shows. */
    readonly leaf: Promise<WorkspaceLeaf | null>;

    constructor(node: MinimalNode, viewType: string) {
        this.node = node;
        this.viewType = viewType;
        this.leaf = leafForViewType(viewType);
        this.currentLens = constant({
            parent: this,
            viewComponent: OsintViewHost,
            osintViewType: viewType,
            osintLeaf: this.leaf,
        });
    }

    /**
     * Tangent disposes a view state when its node leaves every thread. The Obsidian view
     * is deliberately NOT torn down here: getLeavesOfType() has twelve call sites that
     * expect a background view to still be there, and refreshOpenInsightViews() drives
     * views the user cannot currently see. The leaf is released on plugin teardown.
     */
    dispose(): void { /* see above */ }
}

/**
 * A canvas is a document, not a singleton view.
 *
 * The five views above are one-per-vault and hang off an empty marker file, so their state
 * only has to name a view type. A `.canvas` file has real content and there can be any
 * number of them, so this state carries the node itself and a native Svelte lens reads and
 * writes it -- no Obsidian leaf, no ItemView, no DOM adoption.
 */
export class CanvasNodeViewState {
    readonly node: MinimalNode;
    readonly currentLens: ReturnType<typeof constant<unknown>>;

    constructor(node: MinimalNode) {
        this.node = node;
        // The node goes ON THE LENS, not just on the state: NodeViewSelector renders
        // `<svelte:component state={$lensState}>`, so the component receives the lens.
        // OsintViewHost works the same way, via osintViewType/osintLeaf.
        this.currentLens = constant({
            parent: this,
            viewComponent: CanvasView,
            canvasNode: node,
        });
    }

    /** CanvasView flushes its own pending save in onDestroy. */
    dispose(): void { /* see above */ }
}

/**
 * Registered into ViewStateContext.creators. Returns undefined for anything that is not
 * one of ours, which is how Tangent's creator chain expects a decline.
 */
export function osintViewStateCreator(_context: unknown, node: MinimalNode): unknown {
    if (!node?.fileType) return undefined;
    if (node.fileType === CANVAS_FILE_TYPE) return new CanvasNodeViewState(node);
    const view = viewForFileType(node.fileType);
    if (!view) return undefined;
    return new OsintNodeViewState(node, view.viewType);
}
