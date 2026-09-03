import { describe, it, expect, beforeEach } from 'vitest';
import { setTangentWorkspace, openIndexedVaultNode } from '../integration/open-view';

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

describe('opening an OSINT view', () => {
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
