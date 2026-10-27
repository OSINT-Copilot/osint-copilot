import { describe, it, expect } from 'vitest';
import {
    parseCanvas,
    serializeCanvas,
    emptyCanvas,
    type CanvasFileNode,
    type CanvasGroupNode,
    type CanvasTextNode,
} from '../canvas/canvas-format';

/** A document exercising every node type, both extension points, and unknown keys. */
const SPEC_FIXTURE = {
    nodes: [
        {
            id: 'n-text', type: 'text', x: 0, y: 0, width: 400, height: 200,
            text: '# Hypothesis\n\nSeen at the docks 3x', color: '3',
        },
        {
            id: 'n-file', type: 'file', x: 500, y: 0, width: 400, height: 400,
            file: 'People/Ivan.md', subpath: '#Associates',
        },
        {
            id: 'n-entity', type: 'file', x: 1000, y: 0, width: 300, height: 200,
            file: 'OSINTCopilot/ftm/Person/Ivan.md', osintEntityId: '499a2c6d-1234',
        },
        { id: 'n-link', type: 'link', x: 0, y: 500, width: 400, height: 300, url: 'https://example.org' },
        {
            id: 'n-group', type: 'group', x: -50, y: -50, width: 1400, height: 600,
            label: 'Shell companies', background: 'Assets/map.png', backgroundStyle: 'cover',
        },
    ],
    edges: [
        {
            id: 'e1', fromNode: 'n-file', fromSide: 'right', toNode: 'n-text',
            toSide: 'left', toEnd: 'arrow', color: '5', label: 'supports',
        },
        { id: 'e2', fromNode: 'n-entity', toNode: 'n-group' },
    ],
};

describe('parseCanvas', () => {
    it('reads every node type in the spec', () => {
        const { doc, problems } = parseCanvas(JSON.stringify(SPEC_FIXTURE));
        expect(problems).toEqual([]);
        expect(doc.nodes.map((n) => n.type)).toEqual(['text', 'file', 'file', 'link', 'group']);
        expect(doc.edges).toHaveLength(2);

        const text = doc.nodes[0] as CanvasTextNode;
        expect(text.text).toContain('docks');
        expect(text.color).toBe('3');

        const file = doc.nodes[1] as CanvasFileNode;
        expect(file.file).toBe('People/Ivan.md');
        expect(file.subpath).toBe('#Associates');

        const group = doc.nodes[4] as CanvasGroupNode;
        expect(group.label).toBe('Shell companies');
        expect(group.backgroundStyle).toBe('cover');
    });

    it('reads our entity binding off a file node', () => {
        // An entity card is a file node plus osintEntityId, so Obsidian still shows the
        // note rather than choking on a node type it does not know.
        const { doc } = parseCanvas(JSON.stringify(SPEC_FIXTURE));
        const entity = doc.nodes[2] as CanvasFileNode;
        expect(entity.type).toBe('file');
        expect(entity.osintEntityId).toBe('499a2c6d-1234');
        expect(entity.file).toBe('OSINTCopilot/ftm/Person/Ivan.md');
    });

    it('never throws, whatever is on disk', () => {
        // A canvas is a user file an agent or a bad merge can mangle. A view that throws
        // on load is one they cannot use to recover.
        for (const bad of ['', '   ', 'not json', '[]', 'null', '42', '{"nodes":"nope"}', '{']) {
            expect(() => parseCanvas(bad)).not.toThrow();
        }
        expect(parseCanvas('').doc).toEqual(emptyCanvas());
        expect(parseCanvas('not json').problems[0]).toMatch(/not valid JSON/);
        expect(parseCanvas('[]').problems[0]).toMatch(/not a JSON Canvas document/);
        expect(parseCanvas('{"nodes":"nope"}').problems[0]).toMatch(/"nodes" is not an array/);
    });

    it('drops entries it cannot use, and says why', () => {
        const { doc, problems } = parseCanvas(JSON.stringify({
            nodes: [
                { type: 'text', x: 0, y: 0, width: 1, height: 1, text: 'no id' },
                { id: 'ok', type: 'text', x: 0, y: 0, width: 1, height: 1, text: 'fine' },
                { id: 'weird', type: 'sticky', x: 0, y: 0, width: 1, height: 1 },
                { id: 'nofile', type: 'file', x: 0, y: 0, width: 1, height: 1 },
                'not an object',
            ],
            edges: [{ id: 'dangling', fromNode: 'ok', toNode: 'gone' }],
        }));

        expect(doc.nodes.map((n) => n.id)).toEqual(['ok']);
        expect(doc.edges).toEqual([]);
        expect(problems).toHaveLength(5);
        expect(problems.join(' ')).toMatch(/no id/);
        expect(problems.join(' ')).toMatch(/unknown type/);
        // A dangling edge would draw a line to nowhere and break anchor maths.
        expect(problems.join(' ')).toMatch(/not on the canvas/);
    });

    it('keeps the first of a duplicated id rather than rendering two cards for one', () => {
        const { doc, problems } = parseCanvas(JSON.stringify({
            nodes: [
                { id: 'dup', type: 'text', x: 0, y: 0, width: 1, height: 1, text: 'first' },
                { id: 'dup', type: 'text', x: 9, y: 9, width: 1, height: 1, text: 'second' },
            ],
            edges: [
                { id: 'e', fromNode: 'dup', toNode: 'dup' },
                { id: 'e', fromNode: 'dup', toNode: 'dup' },
            ],
        }));
        expect(doc.nodes).toHaveLength(1);
        expect((doc.nodes[0] as CanvasTextNode).text).toBe('first');
        expect(doc.edges).toHaveLength(1);
        expect(problems.join(' ')).toMatch(/Duplicate node id/);
        expect(problems.join(' ')).toMatch(/Duplicate edge id/);
    });

    it('accepts fractional geometry, which real files carry', () => {
        // The spec says integer, but anything that has divided by a zoom factor emits
        // floats. Refusing them would reject perfectly good canvases.
        const { doc, problems } = parseCanvas(JSON.stringify({
            nodes: [{ id: 'a', type: 'text', x: 10.5, y: -3.25, width: 400.1, height: 200, text: '' }],
        }));
        expect(problems).toEqual([]);
        expect(doc.nodes[0].x).toBe(10.5);
        expect(doc.nodes[0].y).toBe(-3.25);
    });

    it('substitutes a default size rather than losing a card with bad geometry', () => {
        const { doc } = parseCanvas(JSON.stringify({
            nodes: [{ id: 'a', type: 'text', text: 'content worth keeping', width: Infinity }],
        }));
        expect(doc.nodes).toHaveLength(1);
        expect(doc.nodes[0].x).toBe(0);
        expect(Number.isFinite(doc.nodes[0].width)).toBe(true);
    });
});

describe('serializeCanvas', () => {
    it('round-trips a spec document with no loss', () => {
        const first = parseCanvas(JSON.stringify(SPEC_FIXTURE));
        const written = serializeCanvas(first.doc);
        const second = parseCanvas(written);
        expect(second.problems).toEqual([]);
        expect(second.doc).toEqual(first.doc);
        // And the emitted JSON still matches the input semantically.
        expect(JSON.parse(written)).toEqual(SPEC_FIXTURE);
    });

    it('is stable: serializing twice produces identical bytes', () => {
        // Otherwise every open/close churns the whole diff of a file shared with Obsidian.
        const { doc } = parseCanvas(JSON.stringify(SPEC_FIXTURE));
        const once = serializeCanvas(doc);
        expect(serializeCanvas(parseCanvas(once).doc)).toBe(once);
    });

    it('preserves properties it does not recognise', () => {
        // The spec asks implementations to preserve unknown properties. Dropping a key
        // Obsidian or a future spec version added would corrupt the user's file in a way
        // they would not notice until much later.
        const withUnknowns = {
            nodes: [{
                id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 1, text: 'hi',
                futureProperty: { nested: [1, 2, 3] }, styleAttributes: 'obsidian-thing',
            }],
            edges: [{ id: 'e', fromNode: 'a', toNode: 'a', someEdgeExtension: true }],
            metadata: { frontmatter: { tags: ['case-7'] } },
        };
        const { doc, problems } = parseCanvas(JSON.stringify(withUnknowns));
        expect(problems).toEqual([]);
        expect(JSON.parse(serializeCanvas(doc))).toEqual(withUnknowns);
    });

    it('omits absent optional keys instead of writing nulls', () => {
        const { doc } = parseCanvas(JSON.stringify({
            nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '' }],
        }));
        const written = JSON.parse(serializeCanvas(doc));
        expect('color' in written.nodes[0]).toBe(false);
        expect('osintEntityId' in written.nodes[0]).toBe(false);
        expect('subpath' in written.nodes[0]).toBe(false);
    });

    it('writes an empty canvas Obsidian can open', () => {
        const written = serializeCanvas(emptyCanvas());
        expect(JSON.parse(written)).toEqual({ nodes: [], edges: [] });
        expect(written.endsWith('\n')).toBe(true);
    });

    it('lets a parsed value win over a stale duplicate in the extras bag', () => {
        const { doc } = parseCanvas(JSON.stringify({
            nodes: [{ id: 'a', type: 'text', x: 5, y: 0, width: 1, height: 1, text: 'hi' }],
        }));
        doc.nodes[0].extra.x = 999;
        doc.nodes[0].x = 5;
        expect(JSON.parse(serializeCanvas(doc)).nodes[0].x).toBe(5);
    });
});
