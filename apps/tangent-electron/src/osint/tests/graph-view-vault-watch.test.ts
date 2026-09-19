import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import cytoscape from 'cytoscape';
import { EntityManager } from '../services/entity-manager';
import { makeFile } from '../obsidian-shim/vault/tfile';
import { fakeGraphHost, makeGraphView } from './helpers/graph-view-harness';

describe('GraphView vault watcher', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function setup() {
        const handlers = new Map<string, (file: unknown, oldPath: string) => void>();
        const app = {
            vault: {
                on: vi.fn((name: string, handler: (file: unknown, oldPath: string) => void) => {
                    handlers.set(name, handler);
                    return { detach: vi.fn() };
                }),
            },
        };
        // The real path filter; nothing here reads the vault.
        const entityManager = new EntityManager(app as never, 'OSINTCopilot', null);
        const view = makeGraphView(entityManager, fakeGraphHost(), app);
        const refresh = vi.spyOn(view, 'refreshWithSavedPositions').mockResolvedValue(undefined);
        (view as any).registerVaultWatcher();
        const fire = (name: string, path: string, oldPath = '') => handlers.get(name)!(makeFile(path, null), oldPath);
        return { view, refresh, fire };
    }

    it('refreshes once, keeping pan and zoom, 400 ms after an entity note changes', () => {
        const { refresh, fire } = setup();
        fire('modify', 'OSINTCopilot/ftm/Person/a.md');
        vi.advanceTimersByTime(399);
        expect(refresh).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledWith({ fit: false });
    });

    it('folds a burst of changes into one refresh', () => {
        const { refresh, fire } = setup();
        fire('create', 'OSINTCopilot/ftm/Person/a.md');
        fire('modify', 'OSINTCopilot/ftm/Person/b.md');
        fire('delete', 'OSINTCopilot/Connections/c.md');
        vi.advanceTimersByTime(400);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('ignores chat saves, other files under the root, and notes outside it', () => {
        const { refresh, fire } = setup();
        fire('modify', 'OSINTCopilot/conversations/c.md');
        fire('modify', 'OSINTCopilot/graph-positions.json');
        fire('modify', 'OSINTCopilot/graph-yaml/Person/a.md');
        fire('modify', 'Research/notes.md');
        vi.advanceTimersByTime(1000);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('notices a note renamed out of the entity folders', () => {
        const { refresh, fire } = setup();
        fire('rename', 'Archive/a.md', 'OSINTCopilot/ftm/Person/a.md');
        vi.advanceTimersByTime(400);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('holds the refresh while connection mode is on, and runs it when the mode ends', () => {
        const { view, refresh, fire } = setup();
        (view as any).connectionMode = true;
        fire('modify', 'OSINTCopilot/ftm/Person/a.md');
        vi.advanceTimersByTime(400);
        expect(refresh).not.toHaveBeenCalled();

        (view as any).exitConnectionMode();
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledWith({ fit: false });
    });

    it('holds it through box-select mode as well', () => {
        const { view, refresh, fire } = setup();
        (view as any).boxSelectMode = true;
        fire('modify', 'OSINTCopilot/ftm/Person/a.md');
        vi.advanceTimersByTime(400);
        expect(refresh).not.toHaveBeenCalled();

        (view as any).exitBoxSelectMode();
        expect(refresh).toHaveBeenCalledTimes(1);
    });
});

describe('GraphView.refreshWithSavedPositions', () => {
    function setup(entityIds: string[]) {
        const entities = entityIds.map((id) => ({ id, type: 'Person', label: id, properties: {} }));
        const entityManager = {
            loadEntitiesFromNotes: vi.fn(async () => undefined),
            getGraphData: () => ({ entities, connections: [] }),
        };
        const view = makeGraphView(entityManager, fakeGraphHost(), { vault: {} });
        const cy = cytoscape({ headless: true });
        const fit = vi.spyOn(cy, 'fit').mockImplementation(() => cy);
        (view as any).cy = cy;
        // Every node has a saved position, so no layout runs.
        entityIds.forEach((id, i) => (view as any).nodePositionsCache.set(id, { x: i * 10, y: 0 }));
        return { view, cy, fit, entityManager };
    }

    it('fits by default and leaves the viewport alone when asked to', async () => {
        const { view, fit } = setup(['a']);
        await view.refreshWithSavedPositions({ fit: false });
        expect(fit).not.toHaveBeenCalled();
        await view.refreshWithSavedPositions();
        expect(fit).toHaveBeenCalledTimes(1);
    });

    it('drops selected ids that are gone and marks the rest selected again', async () => {
        const { view, cy } = setup(['a', 'b']);
        (view as any).selectedNodes = new Set(['a', 'gone']);
        (view as any).selectedEdges = new Set(['gone-edge']);

        await view.refreshWithSavedPositions({ fit: false });

        expect([...(view as any).selectedNodes]).toEqual(['a']);
        expect([...(view as any).selectedEdges]).toEqual([]);
        expect(cy.getElementById('a').hasClass('multi-selected')).toBe(true);
        expect(cy.getElementById('b').hasClass('multi-selected')).toBe(false);
    });

    it('joins a refresh already running instead of loading the store twice', async () => {
        const { view, entityManager, fit } = setup(['a']);
        let release!: () => void;
        entityManager.loadEntitiesFromNotes.mockReturnValueOnce(new Promise<undefined>((r) => { release = () => r(undefined); }));

        const first = view.refreshWithSavedPositions({ fit: false });
        const second = view.refreshWithSavedPositions();
        release();
        await Promise.all([first, second]);

        expect(entityManager.loadEntitiesFromNotes).toHaveBeenCalledTimes(1);
        // The joining call asked for a fit, and gets one once the run is done.
        expect(fit).toHaveBeenCalledTimes(1);
    });
});
