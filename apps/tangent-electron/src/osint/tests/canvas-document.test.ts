import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CanvasDocumentStore, SAVE_DEBOUNCE_MS, type CanvasFileStore } from '../canvas/canvas-document';
import { parseCanvas } from '../canvas/canvas-format';
import type { CanvasFileNode, CanvasTextNode } from '../canvas/canvas-format';

function fakeFiles(initial: string | null = null) {
    const written: string[] = [];
    let contents = initial;
    let failNext = false;
    const files: CanvasFileStore & {
        written: string[];
        latest(): string | null;
        failNextWrite(): void;
    } = {
        written,
        latest: () => contents,
        failNextWrite: () => { failNext = true; },
        async read() { return contents; },
        async write(_path, next) {
            if (failNext) { failNext = false; throw new Error('disk full'); }
            contents = next;
            written.push(next);
        },
    };
    return files;
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('CanvasDocumentStore loading', () => {
    it('treats a missing file as an empty board rather than an error', async () => {
        // A canvas can be created and opened before it has ever been written.
        const store = new CanvasDocumentStore('Boards/New.canvas', fakeFiles(null));
        await store.load();
        expect(store.current.loaded).toBe(true);
        expect(store.current.doc.nodes).toEqual([]);
        expect(store.current.dirty).toBe(false);
    });

    it('surfaces what the loader had to drop', async () => {
        const files = fakeFiles(JSON.stringify({ nodes: [{ type: 'text', x: 0, y: 0 }] }));
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();
        expect(store.current.problems.join(' ')).toMatch(/no id/);
    });
});

describe('CanvasDocumentStore when the vault is not reachable', () => {
    /** Throws on read, the way vaultFileStore does before the plugin has started. */
    function unavailableFiles(recovered: string | null = null) {
        let attempts = 0;
        const written: string[] = [];
        return {
            written,
            get attempts() { return attempts; },
            async read() {
                attempts += 1;
                if (attempts < 3 && recovered !== null) throw new Error('The vault is not available yet.');
                if (recovered === null) throw new Error('The vault is not available yet.');
                return recovered;
            },
            async write(_p: string, next: string) { written.push(next); },
        };
    }

    it('never overwrites a board it failed to read', async () => {
        // The failure mode this guards: a lens can mount during session restore, before
        // the plugin has started. Treating an unreadable board as an empty one would put
        // an empty document on screen and write it over the user's real file.
        vi.useFakeTimers();
        const files = unavailableFiles(null);
        const store = new CanvasDocumentStore('a.canvas', files);
        const loading = store.load(2);
        await vi.advanceTimersByTimeAsync(1000);
        await loading;

        expect(store.current.loaded).toBe(false);
        expect(store.current.problems.join(' ')).toMatch(/could not be read/);

        store.addNode({ type: 'text', text: 'should not be written', x: 0, y: 0, width: 1, height: 1 });
        await store.save();
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50);
        expect(files.written).toEqual([]);
        vi.useRealTimers();
    });

    it('retries while the vault comes up, then loads normally', async () => {
        vi.useFakeTimers();
        const board = JSON.stringify({
            nodes: [{ id: 'real', type: 'text', x: 0, y: 0, width: 1, height: 1, text: 'existing work' }],
            edges: [],
        });
        const files = unavailableFiles(board);
        const store = new CanvasDocumentStore('a.canvas', files);
        const loading = store.load();
        await vi.advanceTimersByTimeAsync(2000);
        await loading;

        expect(store.current.loaded).toBe(true);
        expect(store.current.doc.nodes[0].id).toBe('real');
        expect(files.attempts).toBeGreaterThan(1);
        vi.useRealTimers();
    });
});

describe('CanvasDocumentStore mutations', () => {
    let store: CanvasDocumentStore;
    let files: ReturnType<typeof fakeFiles>;

    beforeEach(async () => {
        vi.useFakeTimers();
        files = fakeFiles(null);
        store = new CanvasDocumentStore('a.canvas', files);
        await store.load();
    });

    afterEach(() => { vi.useRealTimers(); });

    it('centres a card on the point it was dropped at', () => {
        const node = store.addNodeAt('text', { x: 100, y: 100 }, { width: 400, height: 200 })!;
        expect(node.x).toBe(-100);
        expect(node.y).toBe(0);
    });

    it('moves a whole selection in one change', () => {
        const a = store.addNode({ type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 });
        const b = store.addNode({ type: 'text', text: '', x: 50, y: 50, width: 10, height: 10 });
        store.moveNodes(new Set([a.id, b.id]), 25, -5);
        const [first, second] = store.current.doc.nodes;
        expect([first.x, first.y]).toEqual([25, -5]);
        expect([second.x, second.y]).toEqual([75, 45]);
    });

    it('removes edges attached to a deleted card', () => {
        // Otherwise the file is written with dangling edges the loader then reports as
        // problems the next time it is opened.
        const a = store.addNode({ type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 });
        const b = store.addNode({ type: 'text', text: '', x: 9, y: 0, width: 10, height: 10 });
        store.addEdge(a.id, b.id);
        expect(store.current.doc.edges).toHaveLength(1);
        store.removeNodes(new Set([a.id]));
        expect(store.current.doc.edges).toEqual([]);
    });

    it('refuses a self-edge and does not stack duplicates', () => {
        const a = store.addNode({ type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 });
        const b = store.addNode({ type: 'text', text: '', x: 9, y: 0, width: 10, height: 10 });
        expect(store.addEdge(a.id, a.id)).toBeNull();
        const first = store.addEdge(a.id, b.id);
        const second = store.addEdge(a.id, b.id);
        expect(second).toBe(first);
        expect(store.current.doc.edges).toHaveLength(1);
    });

    it('refuses an edge to a card that is not on the board', () => {
        const a = store.addNode({ type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 });
        expect(store.addEdge(a.id, 'ghost')).toBeNull();
    });

    it('keeps selection out of the saved document', async () => {
        // Selection is view state. Writing it would churn the file whenever the user
        // merely clicked something, and mean nothing to Obsidian.
        const a = store.addNode({ type: 'text', text: 'hi', x: 0, y: 0, width: 10, height: 10 });
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
        const before = files.latest();

        store.setSelection([a.id]);
        expect(store.current.dirty).toBe(false);
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
        expect(files.latest()).toBe(before);
        expect(files.latest()).not.toMatch(/selected/i);
    });

    it('drops a card out of the selection when it is deleted', () => {
        const a = store.addNode({ type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 });
        store.setSelection([a.id]);
        store.removeNodes(new Set([a.id]));
        expect(store.current.selectedNodes.size).toBe(0);
    });

    it('toggles selection additively, and replaces it otherwise', () => {
        const a = store.addNode({ type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 });
        const b = store.addNode({ type: 'text', text: '', x: 9, y: 0, width: 10, height: 10 });
        store.toggleNodeSelected(a.id, false);
        store.toggleNodeSelected(b.id, true);
        expect(store.current.selectedNodes).toEqual(new Set([a.id, b.id]));
        store.toggleNodeSelected(a.id, true);
        expect(store.current.selectedNodes).toEqual(new Set([b.id]));
        store.toggleNodeSelected(a.id, false);
        expect(store.current.selectedNodes).toEqual(new Set([a.id]));
    });
});

describe('CanvasDocumentStore saving', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('coalesces a burst of changes into one write', async () => {
        // A drag emits a mutation per pointer move; writing each would hammer the vault
        // and spam Tangent's file watcher.
        const files = fakeFiles(null);
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();

        const node = store.addNode({ type: 'text', text: '', x: 0, y: 0, width: 10, height: 10 });
        for (let i = 0; i < 50; i++) store.moveNodes(new Set([node.id]), 1, 1);

        expect(files.written).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
        expect(files.written).toHaveLength(1);
        expect(store.current.dirty).toBe(false);
        expect(parseCanvas(files.latest() ?? '').doc.nodes[0].x).toBe(50);
    });

    it('writes what is on the board, in JSON Canvas form', async () => {
        const files = fakeFiles(null);
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();
        store.addNode({
            type: 'file', file: 'People/Ivan.md', osintEntityId: 'ent-1',
            x: 0, y: 0, width: 300, height: 200,
        });
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);

        const written = JSON.parse(files.latest() ?? '{}');
        expect(written.nodes[0].type).toBe('file');
        expect(written.nodes[0].file).toBe('People/Ivan.md');
        expect(written.nodes[0].osintEntityId).toBe('ent-1');
        expect(written.edges).toEqual([]);
    });

    it('stays dirty when the write fails, so the board is not silently lost', async () => {
        const files = fakeFiles(null);
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();
        files.failNextWrite();
        store.addNode({ type: 'text', text: 'precious', x: 0, y: 0, width: 10, height: 10 });

        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
        await flush();
        expect(store.current.dirty).toBe(true);

        // The next change reschedules and this time it lands.
        store.addNode({ type: 'text', text: 'more', x: 0, y: 0, width: 10, height: 10 });
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
        await flush();
        expect(store.current.dirty).toBe(false);
        expect(files.latest()).toMatch(/precious/);
    });

    it('flushes a pending change on dispose rather than dropping it', async () => {
        // Closing the panel within the debounce window must not lose the last edit.
        const files = fakeFiles(null);
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();
        store.addNode({ type: 'text', text: 'last edit', x: 0, y: 0, width: 10, height: 10 });
        expect(files.written).toHaveLength(0);

        await store.dispose();
        expect(files.latest()).toMatch(/last edit/);
    });

    it('does not persist an older board when two writes overlap', async () => {
        // Writes are async; unserialized, they can land out of order.
        // Asserted, not annotated: TypeScript does not see the closure assign it, and
        // would treat it as always null below.
        let release = null as (() => void) | null;
        const order: string[] = [];
        const files: CanvasFileStore = {
            async read() { return null; },
            async write(_path, contents) {
                if (!release) {
                    await new Promise<void>((resolve) => { release = resolve; });
                }
                order.push(contents);
            },
        };
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();

        store.addNode({ type: 'text', text: 'first', x: 0, y: 0, width: 10, height: 10 });
        const firstSave = store.save();
        await flush();

        store.addNode({ type: 'text', text: 'second', x: 0, y: 0, width: 10, height: 10 });
        const secondSave = store.save();

        release?.();
        await firstSave;
        await secondSave;
        await flush();

        expect(order[order.length - 1]).toMatch(/second/);
    });
});

describe('round trip through the store', () => {
    it('reloads a board it wrote, unchanged', async () => {
        vi.useFakeTimers();
        const files = fakeFiles(null);
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();

        const note = store.addNode({
            type: 'file', file: 'Notes/A.md', x: 10, y: 20, width: 300, height: 200,
        });
        const text = store.addNode({
            type: 'text', text: '# Why', x: 400, y: 20, width: 300, height: 200,
        });
        store.addEdge(note.id, text.id, 'right', 'left');
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);

        const reopened = new CanvasDocumentStore('a.canvas', files);
        await reopened.load();
        expect(reopened.current.problems).toEqual([]);
        expect(reopened.current.doc).toEqual(store.current.doc);
        expect((reopened.current.doc.nodes[0] as CanvasFileNode).file).toBe('Notes/A.md');
        expect((reopened.current.doc.nodes[1] as CanvasTextNode).text).toBe('# Why');
        expect(reopened.current.doc.edges[0].fromSide).toBe('right');
        vi.useRealTimers();
    });
});

describe('vaultRelativePath', () => {
    // Tangent addresses nodes by absolute path; the obsidian-shim vault addresses files
    // by vault-relative path. Getting this wrong meant the store read and wrote the wrong
    // place, silently.
    const withRoot = async (root: string | undefined, run: () => void) => {
        const previous = (globalThis as any).osint;
        (globalThis as any).osint = root === undefined ? undefined : { vaultRoot: root };
        try { run(); } finally { (globalThis as any).osint = previous; }
    };

    it('strips the vault root', async () => {
        const { vaultRelativePath } = await import('../canvas/canvas-runtime');
        await withRoot('/home/b/Documents/test2', () => {
            expect(vaultRelativePath('/home/b/Documents/test2/OSINTCopilot/boards/A.canvas'))
                .toBe('OSINTCopilot/boards/A.canvas');
        });
    });

    it('tolerates a trailing slash on the root', async () => {
        const { vaultRelativePath } = await import('../canvas/canvas-runtime');
        await withRoot('/vault/', () => {
            expect(vaultRelativePath('/vault/a/b.canvas')).toBe('a/b.canvas');
        });
    });

    it('leaves a path alone when it is already relative or outside the vault', async () => {
        const { vaultRelativePath } = await import('../canvas/canvas-runtime');
        await withRoot('/vault', () => {
            expect(vaultRelativePath('already/relative.canvas')).toBe('already/relative.canvas');
            // A sibling directory must not be mangled by a naive prefix match.
            expect(vaultRelativePath('/vault-other/x.canvas')).toBe('/vault-other/x.canvas');
        });
    });

    it('converts back to absolute for Tangent lookups', async () => {
        // JSON Canvas stores vault-relative paths; directoryStore is keyed by absolute.
        // Getting this backwards made every note card read "missing from the vault".
        const { absoluteVaultPath, vaultRelativePath } = await import('../canvas/canvas-runtime');
        await withRoot('/home/b/Documents/test2', () => {
            expect(absoluteVaultPath('New Folder/New Note.md'))
                .toBe('/home/b/Documents/test2/New Folder/New Note.md');
            // Already absolute stays put, so a double conversion is harmless.
            expect(absoluteVaultPath('/home/b/Documents/test2/a.md'))
                .toBe('/home/b/Documents/test2/a.md');
            const abs = '/home/b/Documents/test2/x/y.md';
            expect(absoluteVaultPath(vaultRelativePath(abs))).toBe(abs);
        });
    });

    it('passes the path through when the runtime is not up yet', async () => {
        const { vaultRelativePath } = await import('../canvas/canvas-runtime');
        await withRoot(undefined, () => {
            expect(vaultRelativePath('/anything/x.canvas')).toBe('/anything/x.canvas');
        });
    });
});

describe('setNodeExtra', () => {
    it('merges rather than replacing, so unknown keys survive', async () => {
        // updateNode({extra}) would discard everything we do not know about -- which is
        // precisely the preservation guarantee the format layer exists to provide.
        const files = fakeFiles(JSON.stringify({
            nodes: [{
                id: 'n', type: 'link', url: 'https://example.org', x: 0, y: 0, width: 1, height: 1,
                obsidianWroteThis: 'keep me',
            }],
            edges: [],
        }));
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();

        store.setNodeExtra('n', { osintLinkTitle: 'A title' });
        expect(store.current.doc.nodes[0].extra).toEqual({
            obsidianWroteThis: 'keep me',
            osintLinkTitle: 'A title',
        });

        // undefined removes, so a cleared preview does not persist as a null.
        store.setNodeExtra('n', { osintLinkTitle: undefined });
        expect(store.current.doc.nodes[0].extra).toEqual({ obsidianWroteThis: 'keep me' });
    });
});

describe('a board the parser could only partly read', () => {
    const partlyReadable = JSON.stringify({
        nodes: [
            { id: 'good', type: 'text', x: 0, y: 0, width: 1, height: 1, text: 'kept' },
            { id: 'bad', type: 'sticky', x: 0, y: 0, width: 1, height: 1 },
        ],
        edges: [],
    });

    it('holds edits, because saving would delete what it could not read', async () => {
        vi.useFakeTimers();
        const files = fakeFiles(partlyReadable);
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();

        expect(store.current.lossyLoad).toBe(true);
        expect(store.current.problems).toHaveLength(1);

        store.addNode({ type: 'text', text: 'new', x: 0, y: 0, width: 1, height: 1 });
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50);
        // The unreadable node is still on disk because nothing was written.
        expect(files.written).toEqual([]);
        expect(files.latest()).toBe(partlyReadable);
        vi.useRealTimers();
    });

    it('saves once the loss is explicitly accepted', async () => {
        vi.useFakeTimers();
        const files = fakeFiles(partlyReadable);
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();

        store.acceptLossyLoad();
        expect(store.current.lossyLoad).toBe(false);
        store.addNode({ type: 'text', text: 'new', x: 0, y: 0, width: 1, height: 1 });
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50);

        expect(files.written).toHaveLength(1);
        expect(files.latest()).toMatch(/new/);
        // And the unreadable node is gone -- which is what was agreed to.
        expect(files.latest()).not.toMatch(/sticky/);
        vi.useRealTimers();
    });

    it('does not hold edits on a board that read cleanly', async () => {
        vi.useFakeTimers();
        const files = fakeFiles(JSON.stringify({ nodes: [], edges: [] }));
        const store = new CanvasDocumentStore('a.canvas', files);
        await store.load();
        expect(store.current.lossyLoad).toBe(false);
        store.addNode({ type: 'text', text: 'fine', x: 0, y: 0, width: 1, height: 1 });
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50);
        expect(files.written).toHaveLength(1);
        vi.useRealTimers();
    });
});
