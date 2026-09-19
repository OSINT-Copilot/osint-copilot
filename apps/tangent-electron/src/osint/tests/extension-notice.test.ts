import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App } from 'obsidian';
import { CountingNotice } from '../inbox/extension-notice';
import VaultAIPlugin from '../plugin/vault-ai-plugin';

// The mock's Notice is an empty class. The shim's is what the app runs, and it puts its
// notices in the page, where these tests count them.
vi.mock('obsidian', async (importOriginal) => {
    const mock = await importOriginal<Record<string, unknown>>();
    const { Notice } = await import('../obsidian-shim/ui/notice');
    return { ...mock, Notice };
});

const message = (n: number) => `${n} ${n === 1 ? 'item' : 'items'} added from the browser extension. Click to review.`;
const shown = () => [...document.querySelectorAll('.notice')].map((n) => n.textContent);
const click = () => (document.querySelector('.notice') as HTMLElement).click();

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('CountingNotice', () => {
    it('counts every arrival in one notice', () => {
        const notice = new CountingNotice({ message, durationMs: 10_000 });
        notice.add(1);
        notice.add(1);
        notice.add(3);
        expect(shown()).toEqual([message(5)]);
    });

    it('stays up for its duration after the latest arrival', () => {
        const notice = new CountingNotice({ message, durationMs: 10_000 });
        notice.add(1);
        vi.advanceTimersByTime(9_000);
        notice.add(1);
        vi.advanceTimersByTime(9_999);
        expect(shown()).toEqual([message(2)]);
        vi.advanceTimersByTime(1);
        expect(shown()).toEqual([]);
    });

    it('starts a new count once it has gone', () => {
        const notice = new CountingNotice({ message, durationMs: 10_000 });
        notice.add(2);
        vi.advanceTimersByTime(10_000);
        expect(shown()).toEqual([]);
        notice.add(1);
        expect(shown()).toEqual([message(1)]);
    });

    it('a click calls onClick once and hides it, and the next arrival starts at 1 with a full duration', () => {
        const onClick = vi.fn();
        const notice = new CountingNotice({ message, durationMs: 10_000, onClick });
        notice.add(2);
        vi.advanceTimersByTime(5_000);
        click();
        expect(onClick).toHaveBeenCalledTimes(1);
        expect(shown()).toEqual([]);

        vi.advanceTimersByTime(1_000);
        notice.add(1);
        expect(shown()).toEqual([message(1)]);
        // The first notice's timer went with it.
        vi.advanceTimersByTime(9_999);
        expect(shown()).toEqual([message(1)]);
        vi.advanceTimersByTime(1);
        expect(shown()).toEqual([]);
        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('a notice removed from outside is replaced by a new one with its own count', () => {
        const notice = new CountingNotice({ message, durationMs: 10_000 });
        notice.add(3);
        document.querySelector('.notice')!.remove();
        notice.add(1);
        expect(shown()).toEqual([message(1)]);
        vi.advanceTimersByTime(10_000);
        expect(shown()).toEqual([]);
    });
});

describe('items added from the browser extension', () => {
    it('in separate passes, are counted in one notice that opens the review', () => {
        const plugin = new VaultAIPlugin(new App() as never, { id: 'test-plugin', name: 'Test Plugin' } as never);
        plugin.settings = { autoRefreshGraph: false } as never;
        const review = vi.spyOn(plugin, 'openExtensionActivity').mockImplementation(() => undefined);
        // What InboxService calls after each pass.
        const notify = (applied: number, dropped: number) => (plugin as any).notifyExtensionItems(applied, dropped);

        notify(1, 0);
        vi.advanceTimersByTime(3_000);
        notify(1, 0);
        notify(2, 0);
        expect(shown()).toEqual([message(4)]);

        click();
        expect(review).toHaveBeenCalledTimes(1);
        expect(shown()).toEqual([]);
    });
});
