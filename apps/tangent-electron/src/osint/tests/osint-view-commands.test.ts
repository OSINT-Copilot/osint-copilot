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

function fakeWorkspace(current: { fileType?: string } | null) {
    const currentNode = nodeStore(current);
    return { workspace: { viewState: { tangent: { currentNode } } } as never, currentNode };
}

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

    it('is checked, and therefore disabled, exactly when its view is the current node', () => {
        // The focus-level convention: the active button is highlighted and not clickable.
        const { workspace } = fakeWorkspace({ fileType: chat.fileType });
        const command = new OpenOsintViewCommand(workspace, chat);
        expect(command.getChecked()).toBe(true);
        expect(command.canExecute()).toBe(false);

        const other = new OpenOsintViewCommand(workspace, entities);
        expect(other.getChecked()).toBe(false);
        expect(other.canExecute()).toBe(true);
    });

    it('re-notifies its buttons when the thread moves', async () => {
        // This is what keeps the highlight in step with the thread: the constructor
        // subscribes to currentNode and calls alertDirty, like SetFocusLevelCommand.
        const { workspace, currentNode } = fakeWorkspace(null);
        const command = new OpenOsintViewCommand(workspace, chat);
        let notified = 0;
        command.subscribe(() => { notified += 1; });

        currentNode.set({ fileType: chat.fileType });
        await nextFrame();
        expect(notified).toBeGreaterThan(0);
        expect(command.getChecked()).toBe(true);
    });

    it('refuses a graph-backed view while graph features are off, and recovers live', async () => {
        const { workspace } = fakeWorkspace(null);
        const gated = new OpenOsintViewCommand(workspace, entities);
        const open = new OpenOsintViewCommand(workspace, chat);

        publishOsintPluginState({ settings: { enableGraphFeatures: false } as never });
        expect(gated.canExecute()).toBe(false);
        // Chat is not gated and must be unaffected.
        expect(open.canExecute()).toBe(true);

        let notified = 0;
        gated.subscribe(() => { notified += 1; });
        publishOsintPluginState({ settings: { enableGraphFeatures: true } as never });
        await nextFrame();
        expect(gated.canExecute()).toBe(true);
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
