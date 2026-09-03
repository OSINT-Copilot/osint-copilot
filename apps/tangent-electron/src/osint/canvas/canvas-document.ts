/**
 * The live canvas document: what is on the board, how it changes, and when it is written.
 *
 * Deliberately not a Tangent DataType. The DataType route (QueryInfo + `common/dataTypes`)
 * is the documented precedent for a file-backed view, but its persistence runs through
 * `ObjectStore.getRawValues()`, which derives JSON from the store's own fields. That would
 * put the bytes we emit at the mercy of the patch system — and byte fidelity IS the
 * feature here, because the point of JSON Canvas is that Obsidian can open the same file.
 * So this owns its own load/save and the format module owns the bytes.
 *
 * Exposes Svelte's store contract (`subscribe`) so components can bind to it directly.
 */
import {
    parseCanvas, serializeCanvas, emptyCanvas, DEFAULT_NODE_SIZE,
    type CanvasDocument, type CanvasEdge, type CanvasNode, type CanvasNodeType,
} from './canvas-format';
import type { Rect, Side } from './canvas-viewport';

/** The slice of the vault this needs, named so tests can supply a fake. */
export interface CanvasFileStore {
    read(path: string): Promise<string | null>;
    write(path: string, contents: string): Promise<void>;
}

/**
 * How long to wait after the last change before writing.
 *
 * A drag emits a mutation per pointer move, so writing eagerly would hammer the vault and
 * spam Tangent's file watcher. Matches the 1s debounce graph-view uses for the same reason
 * when persisting node positions.
 */
export const SAVE_DEBOUNCE_MS = 1000;

let idCounter = 0;

/**
 * Ids only have to be unique within one file, and JSON Canvas does not constrain their
 * shape. A counter plus the current time is enough, and avoids pulling in a uuid
 * dependency for something this local.
 */
function nextId(prefix: string): string {
    idCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export interface CanvasState {
    doc: CanvasDocument;
    /** Ids of selected nodes and edges. */
    selectedNodes: Set<string>;
    selectedEdges: Set<string>;
    /** Anything the loader had to drop, so the view can tell the user. */
    problems: string[];
    loaded: boolean;
    dirty: boolean;
}

type Subscriber = (state: CanvasState) => void;

export function nodeRect(node: CanvasNode): Rect {
    return { x: node.x, y: node.y, width: node.width, height: node.height };
}

export class CanvasDocumentStore {
    private state: CanvasState = {
        doc: emptyCanvas(),
        selectedNodes: new Set(),
        selectedEdges: new Set(),
        problems: [],
        loaded: false,
        dirty: false,
    };

    private subscribers = new Set<Subscriber>();
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private saveInFlight: Promise<void> | null = null;
    /** Set when a change lands mid-write, so the newer state is not lost. */
    private saveAgain = false;
    private disposed = false;

    constructor(
        private readonly path: string,
        private readonly files: CanvasFileStore,
    ) {}

    subscribe(run: Subscriber): () => void {
        this.subscribers.add(run);
        run(this.state);
        return () => { this.subscribers.delete(run); };
    }

    private emit(): void {
        // A fresh object each time so Svelte's `$store` reacts; the Sets are replaced by
        // the mutators rather than mutated in place for the same reason.
        this.state = { ...this.state };
        for (const run of this.subscribers) run(this.state);
    }

    get current(): CanvasState {
        return this.state;
    }

    /**
     * Loads the board, retrying while the vault is still coming up.
     *
     * A lens can be constructed during session restore, before the plugin has started, so
     * the first read may fail. Retrying matters more than it looks: if a failed read were
     * treated as an empty board, the first edit would write that empty board over the
     * user's real one.
     */
    async load(attempts = 10): Promise<void> {
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (this.disposed) return;
            try {
                const raw = await this.files.read(this.path);
                if (this.disposed) return;
                // null means the file does not exist yet -- created but never saved.
                const { doc, problems } = parseCanvas(raw ?? '');
                this.state.doc = doc;
                this.state.problems = problems;
                this.state.loaded = true;
                this.state.dirty = false;
                this.emit();
                return;
            } catch (e) {
                if (attempt === attempts - 1) {
                    // Stays `loaded: false`, which blocks every write. Better to show an
                    // unusable board than to silently replace one.
                    this.state.problems = [
                        `This canvas could not be read: ${e instanceof Error ? e.message : String(e)}`,
                    ];
                    this.emit();
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }
    }

    /** Marks the document changed and schedules a write. */
    private touch(): void {
        // Never write a board we never managed to read: that would replace the file with
        // whatever this empty in-memory document happens to hold.
        if (!this.state.loaded) return;
        this.state.dirty = true;
        this.emit();
        this.scheduleSave();
    }

    private scheduleSave(): void {
        if (this.disposed) return;
        if (this.saveTimer !== null) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.save();
        }, SAVE_DEBOUNCE_MS);
    }

    /**
     * Writes now, coalescing concurrent callers.
     *
     * Serialising through `saveInFlight` matters because a write is async: two overlapping
     * writes of the same path can land out of order and persist the older board.
     */
    async save(): Promise<void> {
        if (!this.state.loaded) return;
        if (this.saveInFlight) {
            this.saveAgain = true;
            return this.saveInFlight;
        }
        this.saveInFlight = this.writeOnce().finally(() => {
            this.saveInFlight = null;
            if (this.saveAgain) {
                this.saveAgain = false;
                void this.save();
            }
        });
        return this.saveInFlight;
    }

    private async writeOnce(): Promise<void> {
        const contents = serializeCanvas(this.state.doc);
        try {
            await this.files.write(this.path, contents);
            if (this.disposed) return;
            this.state.dirty = false;
            this.emit();
        } catch (e) {
            // Kept dirty on failure: a later change reschedules, and closing the view
            // flushes, so a transient write error does not silently lose the board.
            console.error('[Canvas] could not save', this.path, e);
        }
    }

    /** Flush before teardown so a debounced change is never dropped. */
    async dispose(): Promise<void> {
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.state.dirty) await this.save();
        this.disposed = true;
        this.subscribers.clear();
    }

    // ------------------------------------------------------------------ mutations

    addNode(node: Omit<CanvasNode, 'id' | 'extra'> & { id?: string }): CanvasNode {
        const created = { ...node, id: node.id ?? nextId('n'), extra: {} } as CanvasNode;
        this.state.doc.nodes = [...this.state.doc.nodes, created];
        this.touch();
        return created;
    }

    /** A card placed at a world point, centred on it — where a drop or paste lands. */
    addNodeAt(
        type: CanvasNodeType,
        at: { x: number; y: number },
        fields: Partial<CanvasNode> = {},
    ): CanvasNode {
        const width = fields.width ?? DEFAULT_NODE_SIZE.width;
        const height = fields.height ?? DEFAULT_NODE_SIZE.height;
        return this.addNode({
            ...fields,
            type,
            x: at.x - width / 2,
            y: at.y - height / 2,
            width,
            height,
        } as Omit<CanvasNode, 'id' | 'extra'>);
    }

    updateNode(id: string, changes: Partial<CanvasNode>): void {
        let found = false;
        this.state.doc.nodes = this.state.doc.nodes.map((node) => {
            if (node.id !== id) return node;
            found = true;
            return { ...node, ...changes } as CanvasNode;
        });
        if (found) this.touch();
    }

    /** One call for a whole drag, so a multi-card move is a single save. */
    moveNodes(ids: Set<string>, dx: number, dy: number): void {
        if (ids.size === 0 || (dx === 0 && dy === 0)) return;
        this.state.doc.nodes = this.state.doc.nodes.map((node) =>
            ids.has(node.id) ? { ...node, x: node.x + dx, y: node.y + dy } : node);
        this.touch();
    }

    removeNodes(ids: Set<string>): void {
        if (ids.size === 0) return;
        this.state.doc.nodes = this.state.doc.nodes.filter((node) => !ids.has(node.id));
        // Edges to a removed card would be lines to nowhere, and the format layer drops
        // them on the next load anyway -- so remove them here rather than writing a file
        // that reports problems when reopened.
        this.state.doc.edges = this.state.doc.edges.filter(
            (edge) => !ids.has(edge.fromNode) && !ids.has(edge.toNode));
        this.state.selectedNodes = new Set(
            [...this.state.selectedNodes].filter((id) => !ids.has(id)));
        this.touch();
    }

    addEdge(fromNode: string, toNode: string, fromSide?: Side, toSide?: Side): CanvasEdge | null {
        // A self-edge has no meaningful anchor pair and reads as a rendering glitch.
        if (fromNode === toNode) return null;
        const nodeIds = new Set(this.state.doc.nodes.map((n) => n.id));
        if (!nodeIds.has(fromNode) || !nodeIds.has(toNode)) return null;
        // Re-connecting an existing pair should not stack duplicate curves.
        const existing = this.state.doc.edges.find(
            (e) => e.fromNode === fromNode && e.toNode === toNode);
        if (existing) return existing;

        const edge: CanvasEdge = {
            id: nextId('e'), fromNode, toNode, fromSide, toSide, extra: {},
        };
        this.state.doc.edges = [...this.state.doc.edges, edge];
        this.touch();
        return edge;
    }

    updateEdge(id: string, changes: Partial<CanvasEdge>): void {
        let found = false;
        this.state.doc.edges = this.state.doc.edges.map((edge) => {
            if (edge.id !== id) return edge;
            found = true;
            return { ...edge, ...changes };
        });
        if (found) this.touch();
    }

    removeEdges(ids: Set<string>): void {
        if (ids.size === 0) return;
        this.state.doc.edges = this.state.doc.edges.filter((edge) => !ids.has(edge.id));
        this.state.selectedEdges = new Set(
            [...this.state.selectedEdges].filter((id) => !ids.has(id)));
        this.touch();
    }

    /** Deletes whatever is selected, cards and edges together. */
    deleteSelection(): void {
        const nodes = this.state.selectedNodes;
        const edges = this.state.selectedEdges;
        if (nodes.size === 0 && edges.size === 0) return;
        if (edges.size > 0) {
            this.state.doc.edges = this.state.doc.edges.filter((edge) => !edges.has(edge.id));
            this.state.selectedEdges = new Set();
        }
        if (nodes.size > 0) {
            this.removeNodes(nodes);
            return;
        }
        this.touch();
    }

    // ------------------------------------------------------------------ selection
    //
    // Selection is view state, not document state: it never marks the file dirty and is
    // never written. Kept here so every component reads one source of truth.

    setSelection(nodeIds: Iterable<string>, edgeIds: Iterable<string> = []): void {
        this.state.selectedNodes = new Set(nodeIds);
        this.state.selectedEdges = new Set(edgeIds);
        this.emit();
    }

    toggleNodeSelected(id: string, additive: boolean): void {
        const next = additive ? new Set(this.state.selectedNodes) : new Set<string>();
        if (additive && next.has(id)) next.delete(id);
        else next.add(id);
        this.state.selectedNodes = next;
        if (!additive) this.state.selectedEdges = new Set();
        this.emit();
    }

    toggleEdgeSelected(id: string, additive: boolean): void {
        const next = additive ? new Set(this.state.selectedEdges) : new Set<string>();
        if (additive && next.has(id)) next.delete(id);
        else next.add(id);
        this.state.selectedEdges = next;
        if (!additive) this.state.selectedNodes = new Set();
        this.emit();
    }

    clearSelection(): void {
        if (this.state.selectedNodes.size === 0 && this.state.selectedEdges.size === 0) return;
        this.state.selectedNodes = new Set();
        this.state.selectedEdges = new Set();
        this.emit();
    }
}
