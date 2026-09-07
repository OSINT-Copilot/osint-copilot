import { describe, it, expect } from 'vitest';
import {
    GRAPH_NODE_SIZE,
    entityImagePath,
    graphNodeStyles,
    isGraphImageExtension,
    isRemoteUrl,
    nodeBackgroundColorFor,
    nodeCaptionPlacement,
    nodeLabelFor,
    nodeShapeFor,
    nodeTextValignFor,
} from '../views/graph-node-visual';

/** Reads a rule's style block out of the stylesheet by selector. */
function ruleFor(selector: string): Record<string, unknown> {
    const rule = (graphNodeStyles() as { selector: string; style: Record<string, unknown> }[])
        .find((r) => r.selector === selector);
    expect(rule, `no rule for ${selector}`).toBeDefined();
    return rule!.style;
}

/** Calls a cytoscape function mapper with a plain data object. */
function mapper(style: Record<string, unknown>, key: string, data: Record<string, unknown>) {
    const fn = style[key];
    expect(typeof fn, `${key} should be a function mapper`).toBe('function');
    return (fn as (ele: { data(k: string): unknown }) => unknown)({ data: (k) => data[k] });
}

describe('entityImagePath', () => {
    it('prefers properties.image, the picture OF an entity', () => {
        expect(entityImagePath({ properties: { image: 'Evidence/ivanov.jpg' } }))
            .toBe('Evidence/ivanov.jpg');
    });

    it('falls back to properties.filePath, so entities made by dropping a file keep their tile', () => {
        expect(entityImagePath({ properties: { filePath: 'Evidence/shot.png' } }))
            .toBe('Evidence/shot.png');
    });

    it('prefers image over filePath when an entity has both', () => {
        expect(entityImagePath({ properties: { image: 'a.png', filePath: 'b.png' } })).toBe('a.png');
    });

    it('does not mistake a non-image filePath for a picture', () => {
        // Evidence entities carry documents in filePath; painting a PDF as a tile would
        // render a broken image rather than the type-coloured placeholder.
        expect(entityImagePath({ properties: { filePath: 'Evidence/contract.pdf' } })).toBeUndefined();
    });

    it('treats a not-yet-downloaded URL as no picture', () => {
        // There is no vault file to paint until the download has happened, and the tile
        // must not make the renderer fetch from the network on its own.
        expect(entityImagePath({ properties: { image: 'https://example.org/a.jpg' } })).toBeUndefined();
        expect(isRemoteUrl('https://example.org/a.jpg')).toBe(true);
    });

    it('ignores blank and non-string values', () => {
        expect(entityImagePath({ properties: { image: '   ' } })).toBeUndefined();
        expect(entityImagePath({ properties: { image: 42 } })).toBeUndefined();
        expect(entityImagePath({ properties: {} })).toBeUndefined();
        expect(entityImagePath({})).toBeUndefined();
    });

    it('accepts the extensions the graph is willing to paint', () => {
        expect(isGraphImageExtension('a/b.PNG')).toBe(true);
        expect(isGraphImageExtension('a/b.webp')).toBe(true);
        expect(isGraphImageExtension('a/b.docx')).toBe(false);
        expect(isGraphImageExtension('noextension')).toBe(false);
    });
});

describe('node shape', () => {
    it('is a square for an ordinary entity', () => {
        expect(nodeShapeFor({ type: 'Person' })).toBe('round-rectangle');
    });

    it('keeps the pin silhouette for a Location with no picture', () => {
        expect(nodeShapeFor({ type: 'Location' })).toBe('diamond');
        expect(nodeShapeFor({ type: 'Address' })).toBe('diamond');
    });

    it('becomes a tile once that Location has a picture', () => {
        expect(nodeShapeFor({ type: 'Location', thumbUrl: 'file:///v/a.png' })).toBe('round-rectangle');
    });

    it('never renders a diamond from an unconditional rule', () => {
        // The old stylesheet set shape: 'diamond' in a selector that sat AFTER the image
        // rule, so equal specificity meant a located entity WITH a thumbnail still drew a
        // diamond. Deciding it in a mapper is what makes that unrepresentable.
        for (const style of (graphNodeStyles() as { style: Record<string, unknown> }[]).map((r) => r.style)) {
            expect(style['shape']).not.toBe('diamond');
        }
    });
});

describe('node fill and caption', () => {
    it('fills with the type colour when there is no picture', () => {
        expect(nodeBackgroundColorFor({ color: '#4CAF50' })).toBe('#4CAF50');
    });

    it('mattes behind a picture instead of tinting it', () => {
        expect(nodeBackgroundColorFor({ color: '#4CAF50', thumbUrl: 'file:///v/a.png' })).toBe('#1b1b1b');
    });

    it('puts icon, name and type inside an empty tile', () => {
        expect(nodeLabelFor({ icon: '👤', label: 'A. Ivanov', type: 'Person' }))
            .toBe('👤\nA. Ivanov\n(Person)');
        expect(nodeTextValignFor({})).toBe('center');
    });

    it('puts a single-line caption under a picture, so nothing paints over it', () => {
        expect(nodeLabelFor({ icon: '👤', label: 'A. Ivanov', type: 'Person', thumbUrl: 'file:///v/a.png' }))
            .toBe('👤 A. Ivanov');
        expect(nodeTextValignFor({ thumbUrl: 'file:///v/a.png' })).toBe('bottom');
    });

    it('captions a diamond underneath too, because the shape cannot hold the text', () => {
        // A diamond's inscribed square is ~0.7 of its side, so barely half the usable area
        // of the tile -- three centred lines visibly spilled past the edges.
        expect(nodeTextValignFor({ type: 'Location' })).toBe('bottom');
        expect(nodeLabelFor({ icon: '📍', label: 'Probe Tower', type: 'Location' }))
            .toBe('📍 Probe Tower');
    });
});

describe('the base node rule', () => {
    const base = () => ruleFor('node');

    it('opts out of the crossorigin default, or every tile silently renders blank', () => {
        // Cytoscape defaults background-image-crossorigin to 'anonymous' and assigns it to
        // image.crossOrigin for any non-data: URL. A file:// image fetched that way from a
        // file:// page is a CORS refusal in Chromium, and the node paints its background
        // instead -- indistinguishable from the osint-vault:// bug this feature fixed.
        // Cytoscape maps the literal string 'null' back to null before assigning.
        expect(base()['background-image-crossorigin']).toBe('null');
    });

    it('frames every node in its entity type colour', () => {
        expect(base()['border-color']).toBe('data(color)');
    });

    it('paints the picture when there is one and nothing when there is not', () => {
        expect(mapper(base(), 'background-image', { thumbUrl: 'file:///v/a.png' })).toBe('file:///v/a.png');
        expect(mapper(base(), 'background-image', {})).toBe('none');
    });

    it('is square by default', () => {
        expect(mapper(base(), 'shape', { type: 'Person' })).toBe('round-rectangle');
        expect(base()['width']).toBe(GRAPH_NODE_SIZE);
        expect(base()['height']).toBe(GRAPH_NODE_SIZE);
    });
});

describe('rule order', () => {
    it('puts node:selected last, so a selection always wins the border', () => {
        const rules = graphNodeStyles() as { selector: string }[];
        expect(rules[rules.length - 1].selector).toBe('node:selected');
    });

    it('gives the classes that used to be styled inline a rule of their own', () => {
        // 'hovered' replaces a .style() bypass; 'is-unknown' was a class with no rule.
        expect(ruleFor('node.hovered')['border-width']).toBeTypeOf('number');
        expect(ruleFor('node.is-unknown')['border-style']).toBe('dashed');
    });
});
