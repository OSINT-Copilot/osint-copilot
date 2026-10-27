import { vi } from 'vitest';
import { GraphView, type OSINTCopilotGraphHost } from '../../views/graph-view';

/** A graph host with only the default workspace and nothing locked; override what a test needs. */
export function fakeGraphHost(overrides: Partial<OSINTCopilotGraphHost> = {}): OSINTCopilotGraphHost {
    return {
        vaultLockService: { isPathLocked: () => false } as never,
        getActiveGraphId: () => 'default',
        setActiveGraphId: async () => undefined,
        listGraphWorkspaces: () => [{ id: 'default', name: 'Default' }],
        addGraphWorkspace: async () => null,
        deleteGraphWorkspace: async () => undefined,
        getGraphEntityVisual: () => ({ color: '#888888', icon: '' }),
        ...overrides,
    };
}

/**
 * A GraphView as its constructor leaves it: onOpen() has not run, so there is no
 * cytoscape instance and no toolbar. The mock ItemView sets neither `app` nor
 * registerEvent, so both are supplied here.
 */
export function makeGraphView(entityManager: unknown, graphHost: OSINTCopilotGraphHost, app: unknown): GraphView {
    const view = new GraphView({} as never, entityManager as never, undefined, undefined, graphHost);
    (view as any).app = app;
    (view as any).registerEvent = vi.fn();
    return view;
}
