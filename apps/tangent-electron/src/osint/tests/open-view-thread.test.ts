import { describe, it, expect, beforeEach } from 'vitest';
import { setTangentWorkspace, openIndexedVaultNode } from '../integration/open-view';
import { publishOsintPluginState } from '../integration/osint-plugin-state';
import { DEFAULT_SETTINGS, type OsintViewOpenMode } from '../settings/vault-ai-settings';

/**
 * A recording stand-in for the slice of Tangent's Workspace that open-view.ts uses.
 * Nodes are compared by identity, as Session does.
 */
function fakeWorkspace(thread: { path: string }[], focusLevel = 0) {
    const calls: { updateThread: unknown[]; navigateTo: unknown[]; focus: number[] } = {
        updateThread: [], navigateTo: [], focus: [],
    };
    const nodes = new Map(thread.map((n) => [n.path, n]));
    const workspace = {
        directoryStore: {
            files: { path: '/vault' },
            get: (path: string) => nodes.get(path),
        },
        commands: { createNewFile: { execute: () => { throw new Error('must not create'); } } },
        navigateTo: (data: unknown) => { calls.navigateTo.push(data); },
        viewState: {
            tangent: {
                updateThread: (options: unknown) => { calls.updateThread.push(options); },
                focusLevel: { value: focusLevel, set: (v: number) => { calls.focus.push(v); } },
                thread: { value: thread },
            },
            system: { showMenu: { set() {} }, section: { set() {} } },
        },
    };
    return { workspace, nodes, calls };
}

/** Publishes just the one setting these tests care about. */
function setMode(mode: OsintViewOpenMode) {
    publishOsintPluginState({ ready: true, settings: { ...DEFAULT_SETTINGS, viewOpenMode: mode } });
}

describe('opening an OSINT view', () => {
    beforeEach(() => setMode('switch'));

    const noteA = { path: '/vault/A.md' };
    const noteB = { path: '/vault/B.md' };
    const chat = { path: '/vault/.tangent/osint/OSINT Chat.osintchat' };

    it('appends beside the current pane instead of replacing the thread', () => {
        // This used to be updateThread({ currentNode }) alone, which Session resolves to a
        // one-node thread -- every click on a view wiped what the analyst had open.
        const { workspace, nodes, calls } = fakeWorkspace([noteA, noteB]);
        nodes.set(chat.path, chat);
        setTangentWorkspace(workspace as never);

        expect(openIndexedVaultNode('.tangent/osint/OSINT Chat.osintchat')).toBe(true);
        expect(calls.navigateTo).toEqual([
            { target: chat, origin: 'current', direction: 'out' },
        ]);
        // The thread itself is left to navigateTo; nothing rebuilt it by hand.
        expect(calls.updateThread).toEqual([]);
    });

    it('retains the thread when the view is already open in it', () => {
        // navigateTo would truncate everything to the right of the current pane; a view
        // that is already there should just become current, the way CreateNewFile treats
        // an existing note.
        const { workspace, calls } = fakeWorkspace([chat, noteA, noteB]);
        setTangentWorkspace(workspace as never);

        expect(openIndexedVaultNode('.tangent/osint/OSINT Chat.osintchat')).toBe(true);
        expect(calls.updateThread).toEqual([{ currentNode: chat, thread: 'retain' }]);
        expect(calls.navigateTo).toEqual([]);
    });

    it('raises Map focus to Thread on the retain branch, since navigateTo is not there to', () => {
        // In Map focus no panel renders, so opening a view would silently do nothing.
        const { workspace, calls } = fakeWorkspace([chat, noteA], -1);
        setTangentWorkspace(workspace as never);
        openIndexedVaultNode('.tangent/osint/OSINT Chat.osintchat');
        expect(calls.focus).toEqual([0]);
    });

    it('leaves focus alone when already at Thread or deeper', () => {
        const { workspace, calls } = fakeWorkspace([chat, noteA], 1);
        setTangentWorkspace(workspace as never);
        openIndexedVaultNode('.tangent/osint/OSINT Chat.osintchat');
        expect(calls.focus).toEqual([]);
    });

    it('never creates the file when asked to open only an indexed node', () => {
        const { workspace, calls } = fakeWorkspace([noteA]);
        setTangentWorkspace(workspace as never);
        expect(openIndexedVaultNode('.tangent/osint/Missing.osintchat')).toBe(false);
        expect(calls.navigateTo).toEqual([]);
        expect(calls.updateThread).toEqual([]);
    });
});

describe('switch vs alongside', () => {
    const noteA = { path: '/vault/A.md' };
    const chat = { path: '/vault/.tangent/osint/OSINT Chat.osintchat' };
    const entities = { path: '/vault/.tangent/osint/Entity Graph.osintgraph' };
    const timeline = { path: '/vault/.tangent/osint/Timeline.osinttimeline' };
    const openEntities = () => openIndexedVaultNode('.tangent/osint/Entity Graph.osintgraph');

    it('puts the new view in the open view\'s place, keeping notes', () => {
        // The whole point of the setting: the pill reads as view modes, not as a stack of
        // panes. noteA must survive -- replacing the entire thread is what used to wipe it.
        setMode('switch');
        const { workspace, nodes, calls } = fakeWorkspace([noteA, chat]);
        nodes.set(entities.path, entities);
        setTangentWorkspace(workspace as never);

        expect(openEntities()).toBe(true);
        expect(calls.updateThread).toEqual([{ thread: [noteA, entities], currentNode: entities }]);
        expect(calls.navigateTo).toEqual([]);
    });

    it('collapses a thread that already holds several views down to one', () => {
        // Threads built in 'alongside' mode (or before the setting existed) can hold
        // several; swapping only the first would leave the clutter the user turned this on
        // to get rid of.
        setMode('switch');
        const { workspace, nodes, calls } = fakeWorkspace([chat, noteA, timeline]);
        nodes.set(entities.path, entities);
        setTangentWorkspace(workspace as never);

        expect(openEntities()).toBe(true);
        expect(calls.updateThread).toEqual([{ thread: [entities, noteA], currentNode: entities }]);
    });

    it('appends when no view is open yet, so a view never displaces a note', () => {
        setMode('switch');
        const { workspace, nodes, calls } = fakeWorkspace([noteA]);
        nodes.set(entities.path, entities);
        setTangentWorkspace(workspace as never);

        expect(openEntities()).toBe(true);
        expect(calls.navigateTo).toEqual([{ target: entities, origin: 'current', direction: 'out' }]);
        expect(calls.updateThread).toEqual([]);
    });

    it('appends in alongside mode even when a view is open', () => {
        setMode('alongside');
        const { workspace, nodes, calls } = fakeWorkspace([noteA, chat]);
        nodes.set(entities.path, entities);
        setTangentWorkspace(workspace as never);

        expect(openEntities()).toBe(true);
        expect(calls.navigateTo).toEqual([{ target: entities, origin: 'current', direction: 'out' }]);
        expect(calls.updateThread).toEqual([]);
    });

    it('never switches a NOTE into a view\'s place', () => {
        // Only views take part; opening a note from chat must keep normal navigation.
        setMode('switch');
        const noteB = { path: '/vault/B.md' };
        const { workspace, nodes, calls } = fakeWorkspace([chat]);
        nodes.set(noteB.path, noteB);
        setTangentWorkspace(workspace as never);

        expect(openIndexedVaultNode('B.md')).toBe(true);
        expect(calls.navigateTo).toEqual([{ target: noteB, origin: 'current', direction: 'out' }]);
        expect(calls.updateThread).toEqual([]);
    });

    it('raises Map focus when the switch drives the thread directly', () => {
        // navigateTo is not involved on this branch, so nothing else would.
        setMode('switch');
        const { workspace, nodes, calls } = fakeWorkspace([noteA, chat], -1);
        nodes.set(entities.path, entities);
        setTangentWorkspace(workspace as never);
        openEntities();
        expect(calls.focus).toEqual([0]);
    });

    it('defaults to switching when the plugin has published no settings yet', () => {
        publishOsintPluginState({ ready: false, settings: null });
        const { workspace, nodes, calls } = fakeWorkspace([noteA, chat]);
        nodes.set(entities.path, entities);
        setTangentWorkspace(workspace as never);

        expect(openEntities()).toBe(true);
        expect(calls.updateThread).toEqual([{ thread: [noteA, entities], currentNode: entities }]);
    });
});
