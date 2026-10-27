import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolsSkillsRegistryView } from '../views/tools-skills-registry-view';
import { submitOnEnter } from '../utils/submit-on-enter';
import { SkillRegistry } from '../skills/skill-registry';
import { createTestAppAsync, type TestApp } from '../obsidian-shim/testing/create-test-app';

vi.mock('obsidian', async (importOriginal) => {
    const mock = await importOriginal<Record<string, unknown>>();
    return { ...mock, Notice: vi.fn() };
});

function makeView(app: TestApp | { vault: { on: () => { detach(): void } } } = { vault: { on: () => ({ detach() {} }) } }) {
    const host = {
        app: app as any,
        skillRegistry: { invalidate: vi.fn(), listVaultSkills: vi.fn(async (): Promise<unknown[]> => []) },
        enricherRegistry: { invalidate: vi.fn(), listAll: vi.fn(async (): Promise<unknown[]> => []) },
        settings: { skillsFolder: '', enrichersFolder: '' },
    };
    const view = new ToolsSkillsRegistryView({} as any, host as any);
    const containerEl = document.createElement('div');
    containerEl.createDiv({ cls: 'view-header' });
    containerEl.createDiv({ cls: 'view-content' });
    (view as any).containerEl = containerEl;
    // What the shim's ItemView provides and the mock's lacks. Listeners stay attached
    // to the vault; registerEvent only records them for unload.
    (view as any).app = app;
    (view as any).registerEvent = vi.fn();
    document.body.appendChild(containerEl);
    return { view, host, root: containerEl.children[1] as HTMLElement };
}

const columns = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('.osint-copilot-registry-column'));

afterEach(() => {
    vi.useRealTimers();
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

describe('ToolsSkillsRegistryView follows the vault', () => {
    const SKILL = (id: string) => `---\nskill_kind: vault\nid: ${id}\nname: ${id}\ndescription: d\n---\n\nSteps.\n`;

    async function openOnVault() {
        const app = await createTestAppAsync({
            files: { 'OSINTCopilot/custom/skills/old.md': SKILL('old_skill') },
        });
        const made = makeView(app);
        await made.view.onOpen();
        made.host.skillRegistry.listVaultSkills.mockClear();
        made.host.enricherRegistry.listAll.mockClear();
        return { app, ...made };
    }

    it('reloads once, 400 ms after a burst of skill and enricher writes', async () => {
        const { app, host } = await openOnVault();
        vi.useFakeTimers();
        await app.vault.create('OSINTCopilot/custom/skills/new.md', SKILL('new_skill'));
        await app.vault.create('OSINTCopilot/custom/enrichers/leakcheck.json', '{"id":"leakcheck"}');
        await vi.advanceTimersByTimeAsync(399);
        expect(host.skillRegistry.listVaultSkills).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(host.skillRegistry.listVaultSkills).toHaveBeenCalledTimes(1);
        expect(host.enricherRegistry.listAll).toHaveBeenCalledTimes(1);
    });

    it('reloads after a skill is renamed out of the folder or deleted', async () => {
        const { app, host } = await openOnVault();
        vi.useFakeTimers();
        const file = app.vault.getAbstractFileByPath('OSINTCopilot/custom/skills/old.md')!;
        await app.vault.rename(file, 'Archive/old.md');
        await vi.advanceTimersByTimeAsync(400);
        expect(host.skillRegistry.listVaultSkills).toHaveBeenCalledTimes(1);
    });

    it('ignores writes outside both folders, and the enrichers audit log', async () => {
        const { app, host } = await openOnVault();
        vi.useFakeTimers();
        await app.vault.create('Notes/other.md', 'x');
        await app.vault.create('OSINTCopilot/custom/skills/notes.txt', 'x');
        await app.vault.create('OSINTCopilot/custom/enrichers/audit.log.md', '# Enricher audit log');
        await vi.advanceTimersByTimeAsync(1000);
        expect(host.skillRegistry.listVaultSkills).not.toHaveBeenCalled();

        await app.vault.modify(app.vault.getAbstractFileByPath('OSINTCopilot/custom/skills/old.md') as any, SKILL('renamed_id'));
        await vi.advanceTimersByTimeAsync(400);
        expect(host.skillRegistry.listVaultSkills).toHaveBeenCalledTimes(1);
    });

    it('stops reloading once closed', async () => {
        const { app, host, view } = await openOnVault();
        vi.useFakeTimers();
        await app.vault.create('OSINTCopilot/custom/skills/a.md', SKILL('a'));
        await vi.advanceTimersByTimeAsync(400);
        expect(host.skillRegistry.listVaultSkills).toHaveBeenCalledTimes(1);

        // A write whose reload is still pending when the view closes.
        await app.vault.create('OSINTCopilot/custom/skills/b.md', SKILL('b'));
        await view.onClose();
        await vi.advanceTimersByTimeAsync(1000);
        expect(host.skillRegistry.listVaultSkills).toHaveBeenCalledTimes(1);
    });

    it('shows a skill added while it is open, read by the real registry', async () => {
        const app = await createTestAppAsync({
            files: { 'OSINTCopilot/custom/skills/old.md': SKILL('old_skill') },
        });
        const { view, host, root } = makeView(app);
        const registry = new SkillRegistry(app as any, () => '');
        (host as any).skillRegistry = registry;
        await view.onOpen();
        expect(columns(root)[0].textContent).toContain('old_skill');

        vi.useFakeTimers();
        await app.vault.create('OSINTCopilot/custom/skills/new.md', SKILL('breach_lookup_triage'));
        await vi.advanceTimersByTimeAsync(400);
        vi.useRealTimers();
        await vi.waitFor(() => expect(columns(root)[0].textContent).toContain('breach_lookup_triage'));
    });

    it('runs once more after a reload that was asked for while one ran', async () => {
        const { view, host } = makeView();
        await view.onOpen();
        host.skillRegistry.listVaultSkills.mockClear();

        let release!: (v: unknown[]) => void;
        host.skillRegistry.listVaultSkills.mockReturnValueOnce(new Promise<unknown[]>((r) => { release = r; }));
        const first = (view as any).reload();
        // Two more asks while it runs: they coalesce into one more run, not two.
        (view as any).reload();
        (view as any).reload();
        release([]);
        await first;
        await vi.waitFor(() => expect(host.skillRegistry.listVaultSkills).toHaveBeenCalledTimes(2));
        await new Promise((r) => setTimeout(r, 10));
        expect(host.skillRegistry.listVaultSkills).toHaveBeenCalledTimes(2);
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
