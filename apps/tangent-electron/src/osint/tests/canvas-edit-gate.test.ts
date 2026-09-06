import { describe, it, expect } from 'vitest';
import { CanvasDocumentStore, type CanvasFileStore } from '../canvas/canvas-document';

/** A store whose read always fails, the way a corrupt or unreadable board behaves. */
function unreadable(): CanvasFileStore {
    return {
        async read() { throw new Error('disk on fire'); },
        async write() { throw new Error('should never be written'); },
    };
}

/** A board whose file parses but whose contents the loader had to drop entries from. */
function lossy(): CanvasFileStore {
    let contents: string | null = JSON.stringify({ nodes: [{ type: 'text', x: 0, y: 0 }], edges: [] });
    return {
        async read() { return contents; },
        async write(_p, next) { contents = next; },
    };
}

describe('a canvas that could not be read refuses edits without pretending otherwise', () => {
    it('reports canEdit() false and leaves the document untouched by a mutation', async () => {
        // The bug: touch() declined AFTER the mutator had already changed state.doc, so the
        // board visibly gained a card that was never marked dirty, never saved, and gone on
        // reopen -- and "Edit anyway" was not offered, because that is only for a lossy load.
        const store = new CanvasDocumentStore('broken.canvas', unreadable());
        await store.load(1);

        expect(store.current.loaded).toBe(false);
        expect(store.canEdit()).toBe(false);
        expect(store.current.problems[0]).toMatch(/could not be read/i);

        const added = store.addNodeAt('text', { x: 0, y: 0 }, { width: 100, height: 100 } as never);
        expect(added).toBeNull();
        expect(store.current.doc.nodes).toHaveLength(0);
        expect(store.current.dirty).toBe(false);
    });

    it('refuses removals and edges too, so nothing diverges from the file', async () => {
        const store = new CanvasDocumentStore('broken.canvas', unreadable());
        await store.load(1);
        expect(store.addEdge('a', 'b')).toBeNull();
        store.removeNodes(new Set(['a']));
        store.removeEdges(new Set(['e']));
        expect(store.current.dirty).toBe(false);
    });
});

describe('a lossy load holds edits until they are accepted', () => {
    it('blocks first, then allows after acceptLossyLoad', async () => {
        const store = new CanvasDocumentStore('lossy.canvas', lossy());
        await store.load();
        expect(store.current.loaded).toBe(true);
        expect(store.current.lossyLoad).toBe(true);
        expect(store.canEdit()).toBe(false);
        expect(store.addNodeAt('text', { x: 0, y: 0 }, {} as never)).toBeNull();

        store.acceptLossyLoad();
        expect(store.canEdit()).toBe(true);
        const node = store.addNodeAt('text', { x: 0, y: 0 }, {} as never);
        expect(node).not.toBeNull();
        expect(store.current.dirty).toBe(true);
    });
});

describe('a healthy board is unaffected', () => {
    it('allows edits normally', async () => {
        const store = new CanvasDocumentStore('ok.canvas', {
            async read() { return null; },
            async write() { /* accepted */ },
        });
        await store.load();
        expect(store.canEdit()).toBe(true);
        expect(store.addNodeAt('text', { x: 0, y: 0 }, {} as never)).not.toBeNull();
    });
});
