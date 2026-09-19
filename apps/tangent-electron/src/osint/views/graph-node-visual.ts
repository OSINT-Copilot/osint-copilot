/**
 * How an entity becomes a node in the graph: shape, fill, frame and caption.
 *
 * Split out of graph-view.ts so the parts that decide what a node LOOKS like can be tested
 * without constructing a GraphView -- which would drag in cytoscape, leaflet, the entity
 * manager and eleven modals. The same reason map-view.ts exports its pure helpers.
 *
 * Two of the rules below are load-bearing in a way that no unit test can prove, because
 * they fail inside the browser's image loader rather than in our code. Both are commented
 * where they are set; do not remove them without reading those comments.
 */

/** The side of an entity tile, in graph units. */
export const GRAPH_NODE_SIZE = 84;

/** The type-coloured frame around every tile. */
export const GRAPH_BORDER_WIDTH = 3;

/**
 * Extensions we are willing to paint into a node.
 *
 * Deliberately the set graph-view already used. SVG is included because these are files
 * already inside the vault, which the analyst put there -- unlike a DOWNLOADED image,
 * where SVG stays refused because it is XML that can carry script.
 */
export const GRAPH_IMAGE_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico',
]);

export function isGraphImageExtension(path: string): boolean {
    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    return GRAPH_IMAGE_EXTENSIONS.has(extension);
}

/** The subset of an entity this module needs. Structural, so tests need no real Entity. */
export interface EntityImageSource {
    type?: unknown;
    properties?: Record<string, unknown>;
}

/**
 * The vault-relative path of an entity's picture, if it has one.
 *
 * Two keys, in precedence order, because they mean different things:
 *
 *  - `properties.image` is "a picture OF this thing" and works on any entity -- a
 *    photograph of a person, a logo for a company. It is the key this feature writes.
 *  - `properties.filePath` is "the file this entity IS", set by dropping a file on the
 *    graph, which creates an Image or Evidence entity. Kept as a fallback so every entity
 *    created that way keeps its tile, and gated on the extension so a PDF on an Evidence
 *    entity is not mistaken for a picture.
 *
 * A URL is deliberately NOT a path: until it has been downloaded there is no vault file to
 * paint, and the tile should show its placeholder rather than ask the renderer to fetch
 * from the network on its own.
 */
export function entityImagePath(entity: EntityImageSource): string | undefined {
    const properties = entity.properties ?? {};

    const image = properties.image;
    if (typeof image === 'string' && image.trim() && !isRemoteUrl(image)) {
        return image.trim();
    }

    const filePath = properties.filePath;
    if (typeof filePath === 'string' && filePath.trim() && isGraphImageExtension(filePath)) {
        return filePath.trim();
    }

    return undefined;
}

export function isRemoteUrl(value: string): boolean {
    return /^https?:\/\//i.test(value.trim());
}

/** The node data fields the style mappers read. */
export interface GraphNodeVisualData {
    thumbUrl?: string;
    color?: string;
    icon?: string;
    label?: string;
    type?: string;
}

const FALLBACK_COLOR = '#607D8B';

/** Types that keep a distinct silhouette while they have no picture to show. */
const PIN_TYPES = new Set(['Location', 'Address']);

/**
 * A square, except for a Location or Address that has no picture yet.
 *
 * The pin shapes earn their keep on a map-like graph, but a photograph is more
 * identifying than a silhouette -- so as soon as there is an image the node becomes a tile
 * like every other. Deciding this INSIDE a mapper rather than across two selectors matters:
 * the old stylesheet put the diamond rule after the image rule, where equal specificity
 * meant the diamond silently won for every located entity that had a thumbnail.
 */
export function nodeShapeFor(data: GraphNodeVisualData): 'round-rectangle' | 'diamond' {
    if (data.thumbUrl) return 'round-rectangle';
    return PIN_TYPES.has(data.type ?? '') ? 'diamond' : 'round-rectangle';
}

/**
 * What fills the node behind the image.
 *
 * A near-black matte under a picture, so a transparent PNG does not pick up the type
 * colour and read as a tint; the type colour itself when there is nothing to show, which
 * is what makes an empty tile still say what kind of thing it is.
 */
export function nodeBackgroundColorFor(data: GraphNodeVisualData): string {
    if (data.thumbUrl) return '#1b1b1b';
    return data.color || FALLBACK_COLOR;
}

/**
 * Where the caption sits, which is the one thing the two node shapes disagree about.
 *
 * Inside works for a square: the whole face is usable, so three lines of type, name and
 * icon fit with room to spare. It does not work for a diamond, whose inscribed square is
 * only ~0.7 of its side -- barely half the usable area -- so the same three lines spill out
 * past the edges. And it does not work over a picture, which the text would cover.
 *
 * So a tile and a pin both caption themselves underneath. For the pin that is also simply
 * how a map marker reads, which is what the shape is imitating.
 */
function nodeCaptionPlacement(data: GraphNodeVisualData): 'inside' | 'below' {
    if (data.thumbUrl) return 'below';
    return nodeShapeFor(data) === 'diamond' ? 'below' : 'inside';
}

/**
 * The caption.
 *
 * Cytoscape gives a node exactly ONE label, so the icon and the name are one string and
 * the placements differ in what that string can afford to be. Inside a square there is
 * room for three lines. Underneath, one line -- and a caption is read left to right, so
 * the icon leads it rather than sitting on its own row.
 */
export function nodeLabelFor(data: GraphNodeVisualData): string {
    const icon = data.icon || '📦';
    const label = data.label || '';
    if (nodeCaptionPlacement(data) === 'below') return `${icon} ${label}`;
    const type = data.type || '';
    return type ? `${icon}\n${label}\n(${type})` : `${icon}\n${label}`;
}

export function nodeTextValignFor(data: GraphNodeVisualData): 'center' | 'bottom' {
    return nodeCaptionPlacement(data) === 'below' ? 'bottom' : 'center';
}

/** Reads a mapper's input off a cytoscape element without importing cytoscape's types. */
interface DataReader { data(key: string): unknown }

function visualDataOf(ele: DataReader): GraphNodeVisualData {
    const read = (key: string) => {
        const value = ele.data(key);
        return typeof value === 'string' ? value : undefined;
    };
    return {
        thumbUrl: read('thumbUrl'),
        color: read('color'),
        icon: read('icon'),
        label: read('label'),
        type: read('type'),
    };
}

/**
 * Every node rule in the graph stylesheet, in order.
 *
 * Returned rather than inlined in graph-view so the two rules that fail silently in the
 * browser can be asserted in a test: the crossorigin opt-out, and `:selected` staying last.
 */
export function graphNodeStyles(): unknown[] {
    return [
        {
            selector: 'node',
            style: {
                'shape': (ele: DataReader) => nodeShapeFor(visualDataOf(ele)),
                'width': GRAPH_NODE_SIZE,
                'height': GRAPH_NODE_SIZE,
                'background-color': (ele: DataReader) => nodeBackgroundColorFor(visualDataOf(ele)),
                // 'none' rather than an empty string: cytoscape's `urls` parser accepts the
                // literal and the renderer skips any value that is not a real URL.
                'background-image': (ele: DataReader) => visualDataOf(ele).thumbUrl || 'none',
                'background-fit': 'cover',
                'background-clip': 'node',
                /*
                 * Cytoscape defaults this to 'anonymous' and then assigns it to
                 * image.crossOrigin for every non-data: URL. A file:// image fetched with
                 * crossOrigin='anonymous' from a file:// page is a CORS refusal in
                 * Chromium, so the picture never arrives and the node paints its
                 * background instead -- indistinguishable from the osint-vault:// bug this
                 * feature exists to fix. The literal string 'null' is cytoscape's own
                 * opt-out: it maps it back to null before assigning.
                 */
                'background-image-crossorigin': 'null',
                'background-image-opacity': 1,
                'border-width': GRAPH_BORDER_WIDTH,
                // The frame is what carries the entity type once the fill is a photograph.
                'border-color': 'data(color)',
                'border-opacity': 1,
                'label': (ele: DataReader) => nodeLabelFor(visualDataOf(ele)),
                'text-valign': (ele: DataReader) => nodeTextValignFor(visualDataOf(ele)),
                'text-halign': 'center',
                'text-margin-y': (ele: DataReader) =>
                    (nodeCaptionPlacement(visualDataOf(ele)) === 'below' ? 6 : 0),
                'font-size': '12px',
                'color': '#ffffff',
                'text-outline-color': '#000000',
                'text-outline-width': 2,
                'text-wrap': 'wrap',
                'text-max-width': `${GRAPH_NODE_SIZE + 24}px`,
            },
        },
        {
            // Was a class with no rule at all, so an unresolved connection target rendered
            // as an ordinary node with the literal text "help-circle" for an icon.
            selector: 'node.is-unknown',
            style: { 'border-style': 'dashed', 'background-opacity': 0.55 },
        },
        {
            // The marker that used to be a double border on the diamond. It still reads on
            // a tile, and it is now the only thing distinguishing a located entity.
            selector: 'node.has-coordinates',
            style: { 'border-style': 'double', 'border-width': GRAPH_BORDER_WIDTH + 1 },
        },
        {
            // A class, not an inline .style() call: an inline style is a bypass that
            // outranks the stylesheet permanently, so the old hover handler pinned every
            // node's border to 2px for the rest of the session on first hover.
            selector: 'node.hovered',
            style: { 'border-width': GRAPH_BORDER_WIDTH + 2 },
        },
        {
            selector: 'node.connection-source',
            style: { 'border-width': 5, 'border-color': '#00ff00', 'border-style': 'dashed' },
        },
        {
            selector: 'node.multi-selected',
            style: {
                'border-width': 4,
                'border-color': '#ff6b6b',
                'overlay-color': '#ff6b6b',
                'overlay-padding': 6,
                'overlay-opacity': 0.2,
            },
        },
        {
            // Last, so an explicit selection always wins the border colour.
            selector: 'node:selected',
            style: { 'border-width': 4, 'border-color': '#ffff00' },
        },
    ];
}
