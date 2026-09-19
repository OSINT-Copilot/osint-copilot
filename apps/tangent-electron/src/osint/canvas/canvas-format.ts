/**
 * JSON Canvas 1.0 — https://jsoncanvas.org/spec/1.0/
 *
 * The format is Obsidian's, and interoperating with Obsidian is the whole reason for
 * choosing it, so this module is written around one rule: **a document we did not author
 * must survive a load/save round trip unchanged.** The spec says implementations should
 * preserve properties they do not recognise, and a canvas is a user's own file — silently
 * dropping a key Obsidian added, or one a future spec version adds, would corrupt their
 * work in a way they would only notice much later.
 *
 * Hence `extra` on every node and edge, and on the document itself. Anything not in the
 * known key set lands there and is written back out verbatim.
 *
 * Parsing is total: `parseCanvas` never throws. A canvas is a file on disk that an agent,
 * another app, or a bad merge may have mangled, and a view that throws on load is a view
 * the analyst cannot use to recover. Malformed entries are dropped and reported in
 * `problems` so the UI can say what happened.
 */

/** Spec: a hex string like "#FF0000", or a preset "1".."6". */
export type CanvasColor = string;

const CANVAS_PRESET_COLORS = ['1', '2', '3', '4', '5', '6'] as const;

export type CanvasNodeType = 'text' | 'file' | 'link' | 'group';
export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';
export type CanvasEnd = 'none' | 'arrow';
export type CanvasBackgroundStyle = 'cover' | 'ratio' | 'repeat';

interface CanvasNodeBase {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: CanvasColor;
    /**
     * Our own extension: binds a card to an OSINT entity.
     *
     * JSON Canvas has no entity node type and inventing one would make the file
     * unreadable elsewhere, so an entity card is a `file` node pointing at the entity's
     * backing note plus this key. Obsidian shows a normal note card; we show a typed,
     * colour-coded entity card. If the id no longer resolves we fall back to the note,
     * which is why the binding is additive rather than a separate node type.
     */
    osintEntityId?: string;
    /** Anything this build does not know about, preserved verbatim. */
    extra: Record<string, unknown>;
}

export interface CanvasTextNode extends CanvasNodeBase {
    type: 'text';
    text: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
    type: 'file';
    file: string;
    subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
    type: 'link';
    url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
    type: 'group';
    label?: string;
    background?: string;
    backgroundStyle?: CanvasBackgroundStyle;
}

export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode;

export interface CanvasEdge {
    id: string;
    fromNode: string;
    fromSide?: CanvasSide;
    fromEnd?: CanvasEnd;
    toNode: string;
    toSide?: CanvasSide;
    toEnd?: CanvasEnd;
    color?: CanvasColor;
    label?: string;
    extra: Record<string, unknown>;
}

export interface CanvasDocument {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
    /** Top-level keys outside `nodes`/`edges`, preserved verbatim. */
    extra: Record<string, unknown>;
}

export interface CanvasParseResult {
    doc: CanvasDocument;
    /** Human-readable notes about anything dropped or repaired. Empty on a clean load. */
    problems: string[];
}

/**
 * A colour the spec allows: a preset "1".."6", or a hex string.
 *
 * Validated rather than passed through, because an unrecognised value is not merely
 * cosmetic -- Obsidian and this renderer would disagree about it, and a board is meant to
 * look the same in both.
 */
function normalizeCanvasColor(value: unknown): CanvasColor | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!text) return undefined;
    if ((CANVAS_PRESET_COLORS as readonly string[]).includes(text)) return text;
    // #rgb, #rrggbb, #rrggbbaa -- normalised to lowercase so the file does not churn on
    // case alone when it is co-edited.
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(text)) return text.toLowerCase();
    return undefined;
}

export function emptyCanvas(): CanvasDocument {
    return { nodes: [], edges: [], extra: {} };
}

const NODE_COMMON_KEYS = ['id', 'type', 'x', 'y', 'width', 'height', 'color', 'osintEntityId'];
const NODE_KEYS_BY_TYPE: Record<CanvasNodeType, string[]> = {
    text: [...NODE_COMMON_KEYS, 'text'],
    file: [...NODE_COMMON_KEYS, 'file', 'subpath'],
    link: [...NODE_COMMON_KEYS, 'url'],
    group: [...NODE_COMMON_KEYS, 'label', 'background', 'backgroundStyle'],
};
const EDGE_KEYS = [
    'id', 'fromNode', 'fromSide', 'fromEnd', 'toNode', 'toSide', 'toEnd', 'color', 'label',
];

const SIDES: CanvasSide[] = ['top', 'right', 'bottom', 'left'];
const ENDS: CanvasEnd[] = ['none', 'arrow'];
const BACKGROUND_STYLES: CanvasBackgroundStyle[] = ['cover', 'ratio', 'repeat'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
    const value = source[key];
    return typeof value === 'string' ? value : undefined;
}

/**
 * Coordinates and sizes.
 *
 * The spec types these as integers, but files in the wild carry floats (any app that has
 * ever divided by a zoom factor), and refusing those would reject perfectly good canvases.
 * Non-finite values are refused, because they propagate into every layout calculation
 * downstream and are impossible to see on screen.
 */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return value;
}

function readEnum<T extends string>(
    source: Record<string, unknown>, key: string, allowed: readonly T[],
): T | undefined {
    const value = source[key];
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? (value as T)
        : undefined;
}

function collectExtra(source: Record<string, unknown>, known: string[]): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
        if (!known.includes(key)) extra[key] = source[key];
    }
    return extra;
}

function parseNode(raw: unknown, index: number, problems: string[]): CanvasNode | null {
    if (!isRecord(raw)) {
        problems.push(`Node ${index} is not an object; skipped.`);
        return null;
    }

    const id = readString(raw, 'id');
    if (!id) {
        problems.push(`Node ${index} has no id; skipped.`);
        return null;
    }

    const type = readEnum<CanvasNodeType>(raw, 'type', ['text', 'file', 'link', 'group']);
    if (!type) {
        problems.push(`Node "${id}" has an unknown type ${JSON.stringify(raw.type)}; skipped.`);
        return null;
    }

    // Geometry defaults rather than a rejection: a node with a good id and content but a
    // missing width is recoverable, and dropping it would lose the user's content.
    const x = readNumber(raw, 'x') ?? 0;
    const y = readNumber(raw, 'y') ?? 0;
    const width = readNumber(raw, 'width') ?? DEFAULT_NODE_SIZE.width;
    const height = readNumber(raw, 'height') ?? DEFAULT_NODE_SIZE.height;

    const base: CanvasNodeBase = {
        id, x, y, width, height,
        color: normalizeCanvasColor(raw.color),
        osintEntityId: readString(raw, 'osintEntityId'),
        extra: collectExtra(raw, NODE_KEYS_BY_TYPE[type]),
    };

    switch (type) {
        case 'text':
            return { ...base, type, text: readString(raw, 'text') ?? '' };
        case 'file': {
            const file = readString(raw, 'file');
            if (!file) {
                problems.push(`File node "${id}" has no file path; skipped.`);
                return null;
            }
            return { ...base, type, file, subpath: readString(raw, 'subpath') };
        }
        case 'link': {
            const url = readString(raw, 'url');
            if (!url) {
                problems.push(`Link node "${id}" has no url; skipped.`);
                return null;
            }
            return { ...base, type, url };
        }
        case 'group':
            return {
                ...base, type,
                label: readString(raw, 'label'),
                background: readString(raw, 'background'),
                backgroundStyle: readEnum(raw, 'backgroundStyle', BACKGROUND_STYLES),
            };
    }
}

function parseEdge(
    raw: unknown, index: number, nodeIds: Set<string>, problems: string[],
): CanvasEdge | null {
    if (!isRecord(raw)) {
        problems.push(`Edge ${index} is not an object; skipped.`);
        return null;
    }

    const id = readString(raw, 'id');
    const fromNode = readString(raw, 'fromNode');
    const toNode = readString(raw, 'toNode');
    if (!id || !fromNode || !toNode) {
        problems.push(`Edge ${index} is missing id, fromNode or toNode; skipped.`);
        return null;
    }

    // A dangling edge would render as a line to nowhere and crash any anchor maths that
    // assumes both endpoints exist.
    if (!nodeIds.has(fromNode) || !nodeIds.has(toNode)) {
        problems.push(`Edge "${id}" refers to a node that is not on the canvas; skipped.`);
        return null;
    }

    return {
        id, fromNode, toNode,
        fromSide: readEnum(raw, 'fromSide', SIDES),
        toSide: readEnum(raw, 'toSide', SIDES),
        fromEnd: readEnum(raw, 'fromEnd', ENDS),
        toEnd: readEnum(raw, 'toEnd', ENDS),
        color: normalizeCanvasColor(raw.color),
        label: readString(raw, 'label'),
        extra: collectExtra(raw, EDGE_KEYS),
    };
}

/** Default size for a new card, and the fallback for one that arrives without geometry. */
export const DEFAULT_NODE_SIZE = { width: 400, height: 400 };

/**
 * Total: never throws, whatever is on disk.
 *
 * An empty or whitespace-only file parses as an empty canvas rather than an error, because
 * that is what a freshly created file looks like before the first save.
 */
export function parseCanvas(raw: string): CanvasParseResult {
    const problems: string[] = [];

    if (!raw || !raw.trim()) return { doc: emptyCanvas(), problems };

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (e) {
        problems.push(`This canvas is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        return { doc: emptyCanvas(), problems };
    }

    if (!isRecord(json)) {
        problems.push('This canvas is valid JSON but not a JSON Canvas document.');
        return { doc: emptyCanvas(), problems };
    }

    const nodes: CanvasNode[] = [];
    const seenIds = new Set<string>();
    const rawNodes = Array.isArray(json.nodes) ? json.nodes : [];
    if (json.nodes !== undefined && !Array.isArray(json.nodes)) {
        problems.push('"nodes" is not an array; ignored.');
    }

    for (let i = 0; i < rawNodes.length; i++) {
        const node = parseNode(rawNodes[i], i, problems);
        if (!node) continue;
        // Duplicate ids would make selection, edges and deletion ambiguous.
        if (seenIds.has(node.id)) {
            problems.push(`Duplicate node id "${node.id}"; kept the first.`);
            continue;
        }
        seenIds.add(node.id);
        nodes.push(node);
    }

    const edges: CanvasEdge[] = [];
    const seenEdgeIds = new Set<string>();
    const rawEdges = Array.isArray(json.edges) ? json.edges : [];
    if (json.edges !== undefined && !Array.isArray(json.edges)) {
        problems.push('"edges" is not an array; ignored.');
    }

    for (let i = 0; i < rawEdges.length; i++) {
        const edge = parseEdge(rawEdges[i], i, seenIds, problems);
        if (!edge) continue;
        if (seenEdgeIds.has(edge.id)) {
            problems.push(`Duplicate edge id "${edge.id}"; kept the first.`);
            continue;
        }
        seenEdgeIds.add(edge.id);
        edges.push(edge);
    }

    return {
        doc: { nodes, edges, extra: collectExtra(json, ['nodes', 'edges']) },
        problems,
    };
}

/** Drops undefined values so optional keys are absent rather than `"key": undefined`. */
function compact(source: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined) out[key] = value;
    }
    return out;
}

function nodeToJson(node: CanvasNode): Record<string, unknown> {
    // Extra first so a known key always wins: if a file we loaded carried a stale
    // duplicate, our parsed value is the authority.
    const common = {
        ...node.extra,
        id: node.id,
        type: node.type,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        color: node.color,
        osintEntityId: node.osintEntityId,
    };

    switch (node.type) {
        case 'text':
            return compact({ ...common, text: node.text });
        case 'file':
            return compact({ ...common, file: node.file, subpath: node.subpath });
        case 'link':
            return compact({ ...common, url: node.url });
        case 'group':
            return compact({
                ...common,
                label: node.label,
                background: node.background,
                backgroundStyle: node.backgroundStyle,
            });
    }
}

function edgeToJson(edge: CanvasEdge): Record<string, unknown> {
    return compact({
        ...edge.extra,
        id: edge.id,
        fromNode: edge.fromNode,
        fromSide: edge.fromSide,
        fromEnd: edge.fromEnd,
        toNode: edge.toNode,
        toSide: edge.toSide,
        toEnd: edge.toEnd,
        color: edge.color,
        label: edge.label,
    });
}

/**
 * Two-space indented, newline-terminated — the shape Obsidian writes, so a canvas edited
 * in both apps does not churn its whole diff on every save.
 */
export function serializeCanvas(doc: CanvasDocument): string {
    const json = {
        ...doc.extra,
        nodes: doc.nodes.map(nodeToJson),
        edges: doc.edges.map(edgeToJson),
    };
    return JSON.stringify(json, null, 2) + '\n';
}
