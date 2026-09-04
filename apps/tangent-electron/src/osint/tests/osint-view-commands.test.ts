import { describe, it, expect, beforeEach } from 'vitest';
import { OpenOsintViewCommand, NewOsintCanvasCommand } from '../../app/model/commands/OsintViewCommands';
import { OSINT_VIEWS } from '../integration/osint-view-types';
import { publishOsintPluginState } from '../integration/osint-plugin-state';

/** A writable store with the shape Tangent's currentNode exposes: `.value` and `subscribe`. */
function nodeStore(initial: { fileType?: string } | null) {
    const subs = new Set<(v: unknown) => void>();
    const store = {
        value: initial as { fileType?: string } | null,
        subscribe(run: (v: unknown) => void) { subs.add(run); run(store.value); return () => subs.delete(run); },
        set(next: { fileType?: string } | null) { store.value = next; for (const run of subs) run(next); },
    };
    return store;
}

function fakeWorkspace(current: { fileType?: string; path?: string } | null) {
    const currentNode = nodeStore(current);
    return {
        workspace: { viewState: { tangent: { currentNode } }, directoryStore: { files: { path: '/vault' } } } as never,
        currentNode,
    };
}
const markerOf = (view: { title: string; fileType: string }) => `/vault/.tangent/osint/${view.title}${view.fileType}`;

/** alertDirty() notifies on the next animation frame. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const chat = OSINT_VIEWS.find((v) => v.label === 'Chat')!;
const entities = OSINT_VIEWS.find((v) => v.label === 'Entities')!;

describe('OpenOsintViewCommand', () => {
    beforeEach(() => {
        publishOsintPluginState({ ready: true, settings: { enableGraphFeatures: true } as never });
    });

    it('carries the descriptor shortcut as its default', () => {
        const { workspace } = fakeWorkspace(null);
        const command = new OpenOsintViewCommand(workspace, chat);
        expect(command.shortcuts).toEqual([chat.shortcut]);
        expect(command.defaultShortcuts).toEqual([chat.shortcut]);
    });

    it('is checked exactly when the current node is its marker file -- and stays clickable', () => {
        // checked AND disabled on the same element made the current view the dimmest icon
        // in the group; re-opening the current view is a no-op in open-view.ts anyway.
        const { workspace } = fakeWorkspace({ fileType: chat.fileType, path: markerOf(chat) });
        const command = new OpenOsintViewCommand(workspace, chat);
        expect(command.getChecked()).toBe(true);
        expect(command.canExecute()).toBe(true);

        const other = new OpenOsintViewCommand(workspace, entities);
        expect(other.getChecked()).toBe(false);
    });

    it('does not light up for a stray file that merely shares the extension', () => {
        const { workspace } = fakeWorkspace({ fileType: chat.fileType, path: '/vault/Notes/copy.osintchat' });
        expect(new OpenOsintViewCommand(workspace, chat).getChecked()).toBe(false);
    });

    it('is not executable before the plugin is up', () => {
        const { workspace } = fakeWorkspace(null);
        const command = new OpenOsintViewCommand(workspace, chat);
        publishOsintPluginState({ ready: false, settings: null });
        expect(command.canExecute()).toBe(false);
        publishOsintPluginState({ ready: true, settings: { enableGraphFeatures: true } as never });
        expect(command.canExecute()).toBe(true);
    });

    it('re-notifies its buttons when the thread moves', async () => {
        // This is what keeps the highlight in step with the thread: the constructor
        // subscribes to currentNode and calls alertDirty, like SetFocusLevelCommand.
        const { workspace, currentNode } = fakeWorkspace(null);
        const command = new OpenOsintViewCommand(workspace, chat);
        let notified = 0;
        command.subscribe(() => { notified += 1; });

        currentNode.set({ fileType: chat.fileType, path: markerOf(chat) });
        await nextFrame();
        expect(notified).toBeGreaterThan(0);
        expect(command.getChecked()).toBe(true);
    });

    it('knows when the graph-features setting has turned it off, and recovers live', async () => {
        // Still executable (the palette and shortcut reach it, and executing explains and
        // opens settings) but reported off, which is what the pill filters on.
        const { workspace } = fakeWorkspace(null);
        const gated = new OpenOsintViewCommand(workspace, entities);
        const open = new OpenOsintViewCommand(workspace, chat);

        publishOsintPluginState({ settings: { enableGraphFeatures: false } as never });
        expect(gated.isEnabled).toBe(false);
        expect(gated.canExecute()).toBe(true);
        expect(open.isEnabled).toBe(true);

        let notified = 0;
        gated.subscribe(() => { notified += 1; });
        publishOsintPluginState({ settings: { enableGraphFeatures: true } as never });
        await nextFrame();
        expect(gated.isEnabled).toBe(true);
        expect(notified).toBeGreaterThan(0);
    });

    it('labels for the palette and tooltips for the pill, without the old promises', () => {
        const { workspace } = fakeWorkspace(null);
        const command = new OpenOsintViewCommand(workspace, entities);
        expect(command.getLabel()).toBe('OSINT: Open Entities');
        expect(command.getTooltip()).toBe('Open Entities');
        // "Ctrl+click for new tab" did nothing in this host; it must not be promised.
        expect(command.getTooltip()).not.toMatch(/new tab/i);
    });
});

describe('NewOsintCanvasCommand', () => {
    it('waits for the plugin, then runs', () => {
        const { workspace } = fakeWorkspace(null);
        const command = new NewOsintCanvasCommand(workspace);
        publishOsintPluginState({ ready: false, settings: null });
        expect(command.canExecute()).toBe(false);
        publishOsintPluginState({ ready: true });
        expect(command.canExecute()).toBe(true);
    });

    it('is not gated by graph features: a board is a document, not a graph view', () => {
        const { workspace } = fakeWorkspace(null);
        const command = new NewOsintCanvasCommand(workspace);
        publishOsintPluginState({ ready: true, settings: { enableGraphFeatures: false } as never });
        expect(command.canExecute()).toBe(true);
    });
});
