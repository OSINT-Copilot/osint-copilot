import { describe, it, expect, vi, afterEach } from 'vitest';
import { Notice } from 'obsidian';
import { Workspace } from '../obsidian-shim/workspace/workspace';
import { ItemView } from '../obsidian-shim/workspace/view';
import type { WorkspaceLeaf } from '../obsidian-shim/workspace/layout';
import { OsintWorkspaceController } from '../plugin/osint-workspace-controller';
import { GRAPH_VIEW_TYPE } from '../views/graph-view';
import { MAP_VIEW_TYPE } from '../views/map-view';

// A spy Notice, so the tests can see what the controller said.
vi.mock('obsidian', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Notice: vi.fn(),
}));

/** Stands in for a registered view: the real shim workspace only needs its type. */
class Probe extends ItemView {
    constructor(leaf: WorkspaceLeaf, private readonly type: string) {
        super(leaf);
    }
    getViewType(): string {
        return this.type;
    }
}

/** A real shim workspace with counting factories, and the graph open in one tab. */
async function setup(makeMap: (leaf: WorkspaceLeaf) => ItemView = (leaf) => new Probe(leaf, MAP_VIEW_TYPE)) {
    const workspace = new Workspace();
    const made = { graph: 0, map: 0 };
    workspace.registerViewFactory(GRAPH_VIEW_TYPE, (leaf) => {
        made.graph++;
        return new Probe(leaf, GRAPH_VIEW_TYPE);
    });
    workspace.registerViewFactory(MAP_VIEW_TYPE, (leaf) => {
        made.map++;
        return makeMap(leaf);
    });
    const graphLeaf = workspace.getLeaf('tab');
    await graphLeaf.setViewState({ type: GRAPH_VIEW_TYPE });

    const plugin = {
        settings: { enableGraphFeatures: true },
        app: { workspace },
        entityManager: {
            getEntity: () => ({ id: 'a1', type: 'Address', label: 'HQ', properties: { latitude: '51.5', longitude: '-0.12' } }),
        },
    };
    return { workspace, made, graphLeaf, controller: new OsintWorkspaceController(plugin as never) };
}

afterEach(() => {
    vi.mocked(Notice).mockClear();
});

describe('OsintWorkspaceController', () => {
    it('opens the map in a new tab beside the graph without building a second graph', async () => {
        const { workspace, made, graphLeaf, controller } = await setup();

        await controller.openMapView();

        // The tab used to be a duplicate of the graph's, whose view was built, loaded
        // and thrown away while its onOpen() was still running.
        expect(made).toEqual({ graph: 1, map: 1 });
        const [mapLeaf] = workspace.getLeavesOfType(MAP_VIEW_TYPE);
        const tabs = graphLeaf.parent as unknown as { children: unknown[] };
        expect(tabs.children.indexOf(mapLeaf)).toBe(tabs.children.indexOf(graphLeaf) + 1);
    });

    it('says so when the map fails to open, rather than failing silently', async () => {
        const focusLocation = vi.fn(() => true);
        class BrokenMap extends Probe {
            async onOpen() { throw new Error('no canvas'); }
            refresh = vi.fn(async () => undefined);
            focusLocation = focusLocation;
        }
        const { controller } = await setup((leaf) => new BrokenMap(leaf, MAP_VIEW_TYPE));

        await expect(controller.showEntityOnMap('a1')).resolves.toBeUndefined();

        expect(focusLocation).not.toHaveBeenCalled();
        expect(vi.mocked(Notice)).toHaveBeenCalledWith('The map view failed to load.');
    });
});
