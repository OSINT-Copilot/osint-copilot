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
    const noteA = { path: '/vault/A.md' };
    const noteB = { path: '/vault/B.md' };
    const chat = { path: '/vault/.tangent/osint/OSINT Chat.osintchat' };
    const entities = { path: '/vault/.tangent/osint/Entity Graph.osintgraph' };
    const timeline = { path: '/vault/.tangent/osint/Timeline.osinttimeline' };
    const openChat = () => openIndexedVaultNode('.tangent/osint/OSINT Chat.osintchat');
    const openEntities = () => openIndexedVaultNode('.tangent/osint/Entity Graph.osintgraph');

    beforeEach(() => setMode('switch'));

    it('gives the view the whole thread, so a note never sits beside it', () => {
        const { workspace, nodes, calls } = fakeWorkspace([noteA, noteB]);
        nodes.set(chat.path, chat);
        setTangentWorkspace(workspace as never);

        expect(openChat()).toBe(true);
        expect(calls.updateThread).toEqual([{ thread: [chat], currentNode: chat }]);
        expect(calls.navigateTo).toEqual([]);
    });

    it('replaces a previously open view rather than stacking a second one', () => {
        const { workspace, nodes, calls } = fakeWorkspace([chat]);
        nodes.set(entities.path, entities);
        setTangentWorkspace(workspace as never);

        expect(openEntities()).toBe(true);
        expect(calls.updateThread).toEqual([{ thread: [entities], currentNode: entities }]);
    });

    it('collapses a thread already holding a note and several views', () => {
        // Reachable from 'alongside' mode or a restored session. Switching must tidy it,
        // not inherit it.
        const { workspace, nodes, calls } = fakeWorkspace([noteA, chat, timeline]);
        nodes.set(entities.path, entities);
        setTangentWorkspace(workspace as never);

        expect(openEntities()).toBe(true);
        expect(calls.updateThread).toEqual([{ thread: [entities], currentNode: entities }]);
    });

    it('does not take the retain path when the view shares the thread with a note', () => {
        // The bug this ordering avoids: `thread: 'retain'` would keep [noteA, chat] intact
        // and leave the note beside the view.
        const { workspace, calls } = fakeWorkspace([noteA, chat]);
        setTangentWorkspace(workspace as never);

        expect(openChat()).toBe(true);
        expect(calls.updateThread).toEqual([{ thread: [chat], currentNode: chat }]);
    });

    it('raises Map focus, since navigateTo is not there to do it', () => {
        // In Map focus no panel renders, so opening a view would silently do nothing.
        const { workspace, nodes, calls } = fakeWorkspace([noteA], -1);
        nodes.set(chat.path, chat);
        setTangentWorkspace(workspace as never);
        expect(openChat()).toBe(true);
        expect(calls.focus).toEqual([0]);
    });

    it('leaves focus alone when already at Thread or deeper', () => {
        const { workspace, nodes, calls } = fakeWorkspace([noteA], 1);
        nodes.set(chat.path, chat);
        setTangentWorkspace(workspace as never);
        expect(openChat()).toBe(true);
        expect(calls.focus).toEqual([]);
    });

    it('opens NOTES the way Tangent does, in either mode', () => {
        // Only views take part in switching; a note opened from chat must navigate
        // normally, or following a citation would blow the thread away.
        for (const mode of ['switch', 'alongside'] as const) {
            setMode(mode);
            const { workspace, nodes, calls } = fakeWorkspace([chat]);
            nodes.set(noteB.path, noteB);
            setTangentWorkspace(workspace as never);

            expect(openIndexedVaultNode('B.md'), mode).toBe(true);
            expect(calls.navigateTo, mode).toEqual([
                { target: noteB, origin: 'current', direction: 'out' },
            ]);
            expect(calls.updateThread, mode).toEqual([]);
        }
    });

    it('never creates the file when asked to open only an indexed node', () => {
        const { workspace, calls } = fakeWorkspace([noteA]);
        setTangentWorkspace(workspace as never);
        expect(openIndexedVaultNode('.tangent/osint/Missing.osintchat')).toBe(false);
        expect(calls.navigateTo).toEqual([]);
        expect(calls.updateThread).toEqual([]);
    });

    it('defaults to switching before the plugin has published settings', () => {
        publishOsintPluginState({ ready: false, settings: null });
        const { workspace, nodes, calls } = fakeWorkspace([noteA]);
        nodes.set(chat.path, chat);
        setTangentWorkspace(workspace as never);

        expect(openChat()).toBe(true);
        expect(calls.updateThread).toEqual([{ thread: [chat], currentNode: chat }]);
    });
});

describe('alongside mode', () => {
    const noteA = { path: '/vault/A.md' };
    const chat = { path: '/vault/.tangent/osint/OSINT Chat.osintchat' };
    const entities = { path: '/vault/.tangent/osint/Entity Graph.osintgraph' };

    beforeEach(() => setMode('alongside'));

    it('appends the view beside the current pane', () => {
        const { workspace, nodes, calls } = fakeWorkspace([noteA, chat]);
        nodes.set(entities.path, entities);
        setTangentWorkspace(workspace as never);

        expect(openIndexedVaultNode('.tangent/osint/Entity Graph.osintgraph')).toBe(true);
        expect(calls.navigateTo).toEqual([
            { target: entities, origin: 'current', direction: 'out' },
        ]);
        expect(calls.updateThread).toEqual([]);
    });

    it('retains the thread when the view is already open in it', () => {
        // navigateTo would truncate everything to the right of the current pane.
        const { workspace, calls } = fakeWorkspace([chat, noteA]);
        setTangentWorkspace(workspace as never);

        expect(openIndexedVaultNode('.tangent/osint/OSINT Chat.osintchat')).toBe(true);
        expect(calls.updateThread).toEqual([{ currentNode: chat, thread: 'retain' }]);
        expect(calls.navigateTo).toEqual([]);
    });
});
