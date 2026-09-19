import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolsSkillsRegistryView, submitOnEnter } from '../views/tools-skills-registry-view';

vi.mock('obsidian', async (importOriginal) => {
    const mock = await importOriginal<Record<string, unknown>>();
    return { ...mock, Notice: vi.fn() };
});

function makeView() {
    const host = {
        app: {} as any,
        skillRegistry: { invalidate: vi.fn(), listVaultSkills: vi.fn(async () => []) },
        enricherRegistry: { invalidate: vi.fn(), listAll: vi.fn(async () => []) },
        settings: { skillsFolder: '', enrichersFolder: '' },
    };
    const view = new ToolsSkillsRegistryView({} as any, host as any);
    const containerEl = document.createElement('div');
    containerEl.createDiv({ cls: 'view-header' });
    containerEl.createDiv({ cls: 'view-content' });
    (view as any).containerEl = containerEl;
    document.body.appendChild(containerEl);
    return { view, host, root: containerEl.children[1] as HTMLElement };
}

const columns = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('.osint-copilot-registry-column'));

afterEach(() => {
    document.body.innerHTML = '';
});

describe('ToolsSkillsRegistryView reload', () => {
    it('renders an error line in the column whose registry threw, and the other column normally', async () => {
        const { view, host, root } = makeView();
        host.skillRegistry.listVaultSkills.mockRejectedValue(new Error('EACCES: skills folder'));
        await expect(view.onOpen()).resolves.toBeUndefined();

        const [skills, enrichers] = columns(root);
        expect(skills.querySelector('.osint-copilot-registry-error')!.textContent).toContain('EACCES: skills folder');
        expect(skills.querySelector('h3')!.textContent).toBe('Vault skills');
        expect(enrichers.textContent).toContain('No enricher JSON files found.');
    });

    it('never rejects, so the callers that discard the promise cannot leave an unhandled rejection', async () => {
        const { view, host } = makeView();
        await view.onOpen();
        host.enricherRegistry.listAll.mockRejectedValue(new Error('bad json'));
        await expect((view as any).reload()).resolves.toBeUndefined();
    });

    it('puts the accent on Add skill, trails a plain Refresh, and marks it busy while reloading', async () => {
        const { view, host, root } = makeView();
        await view.onOpen();

        const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.osint-copilot-registry-toolbar button'));
        expect(buttons.map((b) => b.textContent)).toEqual(['Add skill', 'Add enricher draft', 'Refresh']);
        expect(buttons[0].classList.contains('mod-cta')).toBe(true);
        const refresh = buttons[2];
        expect(refresh.classList.contains('mod-cta')).toBe(false);
        expect(refresh.closest('.osint-copilot-registry-toolbar-trailing')).toBeTruthy();

        let release!: (v: never[]) => void;
        host.skillRegistry.listVaultSkills.mockReturnValueOnce(new Promise<never[]>((r) => { release = r; }));
        refresh.click();
        expect(refresh.disabled).toBe(true);
        expect(refresh.textContent).toBe('Refreshing…');

        release([]);
        await new Promise((r) => setTimeout(r, 0));
        expect(refresh.disabled).toBe(false);
        expect(refresh.textContent).toBe('Refresh');
    });
});

describe('submitOnEnter', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

    it('submits on Enter and claims the event', () => {
        const input = document.createElement('input');
        const submit = vi.fn();
        submitOnEnter(input, submit);
        const ev = key({ key: 'Enter' });
        input.dispatchEvent(ev);
        expect(submit).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(true);
    });

    it('ignores other keys, key repeat, and IME composition commits', () => {
        const input = document.createElement('input');
        const submit = vi.fn();
        submitOnEnter(input, submit);
        input.dispatchEvent(key({ key: 'a' }));
        // Holding Enter must not create the file once per repeat.
        input.dispatchEvent(key({ key: 'Enter', repeat: true }));
        input.dispatchEvent(key({ key: 'Enter', isComposing: true }));
        expect(submit).not.toHaveBeenCalled();
    });
});
