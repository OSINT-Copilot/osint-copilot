import { describe, it, expect, vi } from 'vitest';
import { App } from './obsidian-mock';
import VaultAIPlugin from '../plugin/vault-ai-plugin';
import { createTestAppAsync, type TestApp } from '../obsidian-shim/testing/create-test-app';
import { GRAPH_NODE_POSITIONS_FILE } from '../constants/vault-layout';
import { fakeGraphHost, makeGraphView } from './helpers/graph-view-harness';

const DEFAULT_LAYOUT = { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } };
const CASE_LAYOUT = { a: { x: 50, y: 60 } };

/**
 * A host with the plugin's semantics as they were when this bug was found: adding a
 * workspace also activated it, and deleting the active one fell back to default -- both
 * before the view's switch ran. The view must not depend on either.
 */
function workspaceHost() {
    const state = {
        active: 'default',
        workspaces: [{ id: 'default', name: 'Default' }, { id: 'graph-case', name: 'Case' }],
    };
    const host = fakeGraphHost({
        getActiveGraphId: () => state.active,
        setActiveGraphId: async (id) => {
            if (state.workspaces.some((g) => g.id === id)) state.active = id;
        },
        listGraphWorkspaces: () => [...state.workspaces],
        addGraphWorkspace: async (name) => {
            const id = 'graph-new';
            state.workspaces.push({ id, name });
            state.active = id;
            return id;
        },
        deleteGraphWorkspace: async (id) => {
            state.workspaces = state.workspaces.filter((g) => g.id !== id);
            if (state.active === id) state.active = 'default';
        },
    });
    return { host, state };
}

async function setup() {
    const app = await createTestAppAsync({
        files: {
            [GRAPH_NODE_POSITIONS_FILE]: JSON.stringify({
                version: 3,
                byGraph: { default: DEFAULT_LAYOUT, 'graph-case': CASE_LAYOUT },
                membersByGraph: { default: ['a', 'b'], 'graph-case': ['a'] },
            }),
        },
    });
    const { host, state } = workspaceHost();
    const view = makeGraphView({}, host, app);
    // No cytoscape here; what is under test is which layout lands under which id.
    vi.spyOn(view, 'refreshWithSavedPositions').mockResolvedValue(undefined);
    await (view as any).loadSavedPositions();
    return { app, view, host, state };
}

function savedFile(app: TestApp) {
    return JSON.parse(app.storage.peek(GRAPH_NODE_POSITIONS_FILE)!) as {
        byGraph: Record<string, unknown>;
        membersByGraph: Record<string, string[]>;
    };
}

describe('GraphView workspaces', () => {
    it('a new workspace starts empty and the default layout stays where it was', async () => {
        const { app, view, host } = await setup();

        const id = (await host.addGraphWorkspace('Case B'))!;
        await (view as any).switchGraphWorkspace(id);
        await (view as any).savePositions();

        const file = savedFile(app);
        expect(file.byGraph.default).toEqual(DEFAULT_LAYOUT);
        // Not the default layout copied in, which on the next save made every entity a member.
        expect(file.byGraph[id]).toEqual({});
        expect(file.membersByGraph[id] ?? []).toEqual([]);
    });

    it('deleting a workspace removes it from the file and leaves the default layout alone', async () => {
        const { app, view, state } = await setup();
        await (view as any).switchGraphWorkspace('graph-case');
        // A node moved in the case workspace, so its layout differs from the default one.
        (view as any).nodePositionsCache.set('a', { x: 99, y: 99 });

        await (view as any).removeGraphWorkspace('graph-case');

        expect(state.active).toBe('default');
        // Removal writes the file itself, and the checks below must hold after the next save too.
        expect(savedFile(app).byGraph).not.toHaveProperty('graph-case');
        await (view as any).savePositions();
        const file = savedFile(app);
        expect(file.byGraph.default).toEqual(DEFAULT_LAYOUT);
        expect(file.byGraph).not.toHaveProperty('graph-case');
        expect(file.membersByGraph).not.toHaveProperty('graph-case');
        expect(file.membersByGraph.default).toEqual(['a', 'b']);
    });

    it('switching away and back keeps each workspace its own layout', async () => {
        const { app, view } = await setup();
        await (view as any).switchGraphWorkspace('graph-case');
        (view as any).nodePositionsCache.set('a', { x: 7, y: 8 });
        await (view as any).switchGraphWorkspace('default');
        await (view as any).savePositions();

        const file = savedFile(app);
        expect(file.byGraph.default).toEqual(DEFAULT_LAYOUT);
        expect(file.byGraph['graph-case']).toEqual({ a: { x: 7, y: 8 } });
    });
});

describe('VaultAIPlugin graph workspaces', () => {
    it('creates a workspace without making it the active one', async () => {
        const plugin = new VaultAIPlugin(new App() as never, { id: 'test-plugin', name: 'Test Plugin' } as never);
        plugin.settings = {
            activeGraphId: 'default',
            graphWorkspaces: [{ id: 'default', name: 'Default' }],
        } as never;
        plugin.saveSettings = vi.fn().mockResolvedValue(undefined);

        const id = await plugin.addGraphWorkspace('Case B');

        expect(plugin.listGraphWorkspaces().map((g) => g.id)).toContain(id);
        // The view's switch activates it, after storing the current layout.
        expect(plugin.getActiveGraphId()).toBe('default');
    });
});
