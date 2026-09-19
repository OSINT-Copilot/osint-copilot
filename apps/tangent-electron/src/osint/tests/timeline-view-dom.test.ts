import { describe, it, expect, vi, afterEach } from 'vitest';
import { Notice } from 'obsidian';
import { TimelineView } from '../views/timeline-view';

// The mock has no setIcon, and its Notice is an empty class. The real setIcon so the
// toolbar renders its glyphs; a spy Notice so the tests can see what the view said.
vi.mock('obsidian', async (importOriginal) => {
    const mock = await importOriginal<Record<string, unknown>>();
    const { setIcon } = await import('../obsidian-shim/ui/set-icon');
    return { ...mock, setIcon, Notice: vi.fn() };
});

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{21BB}\u{2715}\u{22A1}]/u;

function event(id: string, start_date: string) {
    return { id, type: 'Event', label: `Event ${id}`, properties: { start_date } };
}

function makeView(entities: unknown[] = []) {
    const entityManager = {
        getBasePath: () => 'Entities',
        loadEntitiesFromNotes: vi.fn(async (): Promise<void> => undefined),
        getAllEntities: vi.fn(() => entities),
        getEntity: vi.fn(),
        updateEntity: vi.fn(async () => null),
        openEntityNote: vi.fn(async () => undefined),
    };
    const view = new TimelineView({} as any, entityManager as any);
    // What the shim's View constructor builds -- a header half and a content half; the
    // view mounts into children[1]. The mock ItemView has one child, so it is rebuilt.
    const containerEl = document.createElement('div');
    containerEl.createDiv({ cls: 'view-header' });
    containerEl.createDiv({ cls: 'view-content' });
    (view as any).containerEl = containerEl;
    (view as any).app = { vault: { on: vi.fn(() => ({ detach: vi.fn() })) } };
    (view as any).registerEvent = vi.fn();
    document.body.appendChild(containerEl);
    return { view, entityManager, root: containerEl.children[1] as HTMLElement };
}

afterEach(() => {
    document.body.innerHTML = '';
    vi.mocked(Notice).mockClear();
});

describe('TimelineView', () => {
    it('builds a toolbar of icon buttons with sentence-case labels, and no emoji', async () => {
        const { view, root } = makeView();
        await view.onOpen();
        const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.graph_copilot-timeline-toolbar button'));
        // trim(): the lucide markup inside each button is multi-line, so textContent
        // carries its whitespace along with the label.
        expect(buttons.map((b) => b.textContent!.trim())).toEqual(['Add event', 'Refresh']);
        for (const b of buttons) {
            expect(b.querySelector('svg'), `${b.textContent} has a glyph`).toBeTruthy();
            expect(b.textContent).not.toMatch(EMOJI);
        }
        // Refresh trails, as a group of its own.
        expect(buttons[1].closest('.graph_copilot-timeline-toolbar-trailing')).toBeTruthy();
    });

    it('keeps the explanatory sentence under the toolbar, not in it', async () => {
        const { view, root } = makeView();
        await view.onOpen();
        const toolbar = root.querySelector('.graph_copilot-timeline-toolbar')!;
        expect(toolbar.querySelector('.graph_copilot-timeline-info')).toBeNull();
        const hint = root.querySelector('.graph_copilot-timeline-hint')!;
        expect(hint.previousElementSibling).toBe(toolbar);
        // The toolbar layout is the stylesheet's, not an inline copy that beats it.
        expect((toolbar as HTMLElement).style.display).toBe('');
        // And the canvas no longer carries the dead calc(100% - 50px).
        expect(root.querySelector<HTMLElement>('.graph_copilot-timeline-canvas')!.style.height).toBe('');
    });

    it('puts the date before its card with no inline geometry, so the container query can restack it', async () => {
        const { view, root } = makeView([event('a', '2024-03-01')]);
        await view.onOpen();
        const date = root.querySelector<HTMLElement>('.graph_copilot-timeline-date')!;
        expect(date.style.left).toBe('');
        expect(date.style.position).toBe('');
        expect(date.nextElementSibling!.classList.contains('graph_copilot-timeline-card')).toBe(true);
        expect(root.querySelector<HTMLElement>('.graph_copilot-timeline-wrapper')!.style.paddingLeft).toBe('');
        // The remove button is a plain, un-emoji'd label styled from the stylesheet.
        const remove = root.querySelector<HTMLElement>('.graph_copilot-timeline-remove-btn')!;
        expect(remove.textContent).toBe('Remove');
        expect(remove.style.color).toBe('');
    });

    it('claims the right-click before Tangent sees it', async () => {
        const { view, root } = makeView([event('a', '2024-03-01')]);
        await view.onOpen();
        const card = root.querySelector('.graph_copilot-timeline-card')!;
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
        card.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('keeps the last timeline and says so when the reload fails', async () => {
        const { view, root, entityManager } = makeView([event('a', '2024-03-01')]);
        await view.onOpen();
        expect(root.querySelectorAll('.graph_copilot-timeline-card').length).toBe(1);

        entityManager.loadEntitiesFromNotes.mockRejectedValueOnce(new Error('EIO'));
        // The store would be empty after a failed load; the view must not render that.
        entityManager.getAllEntities.mockReturnValue([]);
        await view.refresh();

        expect(root.querySelectorAll('.graph_copilot-timeline-card').length).toBe(1);
        expect(root.querySelector('.graph_copilot-timeline-empty')).toBeNull();
        expect(vi.mocked(Notice)).toHaveBeenCalledWith('Could not reload events; showing the last known timeline.');
    });

    it('shows a busy state on Refresh while the reload runs', async () => {
        const { view, root, entityManager } = makeView();
        await view.onOpen();
        let release!: () => void;
        entityManager.loadEntitiesFromNotes.mockReturnValueOnce(new Promise<void>((r) => { release = r; }));

        const refresh = root.querySelector<HTMLButtonElement>('.graph_copilot-timeline-toolbar-trailing button')!;
        refresh.click();
        expect(refresh.disabled).toBe(true);
        expect(refresh.textContent!.trim()).toBe('Refreshing…');
        expect(refresh.querySelector('svg'), 'the glyph survives the relabel').toBeTruthy();

        release();
        await new Promise((r) => setTimeout(r, 0));
        expect(refresh.disabled).toBe(false);
        expect(refresh.textContent!.trim()).toBe('Refresh');
    });

    it('dates an Event by the startDate and endDate the entity modal writes', async () => {
        const { view, root } = makeView([
            { id: 'e1', type: 'Event', label: 'FTM', properties: { startDate: '2024-03-03', endDate: '2024-03-04' } },
        ]);
        await view.onOpen();
        const headers = Array.from(root.querySelectorAll('.graph_copilot-timeline-section-header'));
        expect(headers.map((h) => h.textContent)).not.toContain('Undated (1)');
        expect(root.querySelector('.graph_copilot-timeline-date')!.textContent).not.toBe('No date');
        expect(root.querySelector('.graph_copilot-timeline-time')!.textContent).toContain('→');
    });

    it('reads last_seen when end_date is blank or unknown', async () => {
        const { view, root } = makeView([
            { id: 'e1', type: 'Event', label: 'x', properties: { start_date: '2024-03-03', end_date: 'unknown', last_seen: '2024-03-05' } },
        ]);
        await view.onOpen();
        expect(root.querySelector('.graph_copilot-timeline-time')!.textContent).toContain('→');
    });

    it('tells the user when removing an event from the timeline fails', async () => {
        const { view, root, entityManager } = makeView([event('a', '2024-03-01')]);
        await view.onOpen();
        entityManager.updateEntity.mockRejectedValueOnce(new Error('locked'));
        root.querySelector<HTMLButtonElement>('.graph_copilot-timeline-remove-btn')!.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(vi.mocked(Notice)).toHaveBeenCalledWith('Could not remove the event from the timeline.');
    });
});
