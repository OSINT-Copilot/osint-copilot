import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Notice } from 'obsidian';
import { EnricherDraftRequestModal, EnricherStateModal } from '../modals/enricher-command-modals';
import { normalizeEnricherSpec, type EnricherSpec } from '../services/enrichers/enricher-schema';
import VaultAIPlugin from '../plugin/vault-ai-plugin';
import { createTestAppAsync } from '../obsidian-shim/testing/create-test-app';

// The mock's Modal and Setting are no-op stubs; the shim's real ones build the DOM.
vi.mock('obsidian', async (importOriginal) => {
    const mock = await importOriginal<Record<string, unknown>>();
    const { Modal } = await import('../obsidian-shim/ui/modal');
    const setting = await import('../obsidian-shim/ui/setting');
    return {
        ...mock,
        Modal,
        Setting: setting.Setting,
        TextComponent: setting.TextComponent,
        DropdownComponent: setting.DropdownComponent,
        ButtonComponent: setting.ButtonComponent,
        Notice: vi.fn(),
    };
});

function settingControl<T extends Element>(root: HTMLElement, name: string, selector: string): T {
    const item = Array.from(root.querySelectorAll<HTMLElement>('.setting-item'))
        .find((el) => el.querySelector('.setting-item-name')?.textContent === name);
    return item!.querySelector(selector) as T;
}

function type(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    input.value = text;
    input.dispatchEvent(new Event('input'));
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === text)!;
}

function spec(id: string, status: 'draft' | 'active' | 'disabled', enabled: boolean): EnricherSpec {
    return normalizeEnricherSpec({
        id,
        name: id.toUpperCase(),
        status,
        enabled,
        request: { method: 'GET', urlTemplate: `https://${id}.example/?q={{query}}` },
    })!;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
    document.body.innerHTML = '';
    vi.mocked(Notice).mockClear();
});

describe('EnricherDraftRequestModal', () => {
    function open() {
        const onSubmit = vi.fn();
        const modal = new EnricherDraftRequestModal({} as never, onSubmit);
        modal.open();
        const root = modal.contentEl;
        return {
            modal,
            onSubmit,
            root,
            url: settingControl<HTMLInputElement>(root, 'API documentation URL', 'input'),
            details: settingControl<HTMLTextAreaElement>(root, 'Requirements', 'textarea'),
        };
    }

    it('submits the trimmed URL and requirements once, on Enter', async () => {
        const { onSubmit, url, details } = open();
        type(details, '  Look up an e-mail address  ');
        type(url, '  https://leakcheck.example/api/docs ');
        url.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        // A second press before the first settles must not draft twice.
        url.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await flush();

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith('https://leakcheck.example/api/docs', 'Look up an e-mail address');
        expect(document.querySelector('.modal-container')).toBeNull();
    });

    it('submits from the Draft button', async () => {
        const { onSubmit, root, url, details } = open();
        type(url, 'http://api.example/docs');
        type(details, 'Return the registrar');
        button(root, 'Draft').click();
        await flush();
        expect(onSubmit).toHaveBeenCalledWith('http://api.example/docs', 'Return the registrar');
    });

    it('refuses a URL that is not http(s), or no requirements, with a notice', () => {
        const { modal, onSubmit, root, url, details } = open();
        type(details, 'Return the registrar');
        for (const bad of ['', 'api.example/docs', 'ftp://api.example/docs', 'javascript:alert(1)']) {
            type(url, bad);
            button(root, 'Draft').click();
        }
        type(url, 'https://api.example/docs');
        type(details, '   ');
        button(root, 'Draft').click();

        expect(onSubmit).not.toHaveBeenCalled();
        expect(Notice).toHaveBeenCalledTimes(5);
        expect(vi.mocked(Notice).mock.calls[0][0]).toContain('http(s)');
        expect(vi.mocked(Notice).mock.calls[4][0]).toContain('Describe');
        expect(document.querySelector('.modal-container')).not.toBeNull();
        modal.close();
    });
});

describe('EnricherStateModal', () => {
    it('lists the enrichers, offers the state each is not in, and submits the pick', async () => {
        const onSubmit = vi.fn();
        const enrichers = [spec('leakcheck', 'active', true), spec('shodan-host', 'draft', false)];
        const modal = new EnricherStateModal({} as never, enrichers, onSubmit);
        modal.open();
        const root = modal.contentEl;
        const which = settingControl<HTMLSelectElement>(root, 'Enricher', 'select');
        const state = settingControl<HTMLSelectElement>(root, 'New state', 'select');

        expect(Array.from(which.options).map((o) => o.textContent)).toEqual([
            'LEAKCHECK (leakcheck) · active',
            'SHODAN-HOST (shodan-host) · draft',
        ]);
        expect(which.value).toBe('leakcheck');
        expect(state.value).toBe('disabled');

        which.value = 'shodan-host';
        which.dispatchEvent(new Event('change'));
        expect(state.value).toBe('active');

        which.value = 'leakcheck';
        which.dispatchEvent(new Event('change'));
        button(root, 'Set state').click();
        button(root, 'Set state').click();
        await flush();

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith('leakcheck', 'disabled');
        expect(document.querySelector('.modal-container')).toBeNull();
    });

    it('labels an active enricher that is not enabled as disabled, and offers to activate it', () => {
        const modal = new EnricherStateModal({} as never, [spec('whois', 'active', false)], vi.fn());
        modal.open();
        const which = settingControl<HTMLSelectElement>(modal.contentEl, 'Enricher', 'select');
        const state = settingControl<HTMLSelectElement>(modal.contentEl, 'New state', 'select');
        expect(Array.from(which.options).map((o) => o.textContent)).toEqual(['WHOIS (whois) · disabled']);
        expect(state.value).toBe('active');
        modal.close();
    });

    it('submits the state the user chose over the one offered', async () => {
        const onSubmit = vi.fn();
        const modal = new EnricherStateModal({} as never, [spec('rdap-domain', 'disabled', false)], onSubmit);
        modal.open();
        const state = settingControl<HTMLSelectElement>(modal.contentEl, 'New state', 'select');
        expect(state.value).toBe('active');
        state.value = 'disabled';
        state.dispatchEvent(new Event('change'));
        button(modal.contentEl, 'Set state').click();
        await flush();
        expect(onSubmit).toHaveBeenCalledWith('rdap-domain', 'disabled');
    });
});

describe('enricher palette commands', () => {
    const SPEC_PATH = 'OSINTCopilot/custom/enrichers/leakcheck.json';

    /** The plugin's command methods on a real vault, without the rest of onload. */
    async function pluginOn(files: Record<string, string> = {}) {
        const app = await createTestAppAsync({ files });
        const plugin = Object.create(VaultAIPlugin.prototype) as any;
        plugin.app = app;
        plugin.settings = {
            enrichersFolder: 'OSINTCopilot/custom/enrichers',
            skillsFolder: 'OSINTCopilot/custom/skills',
        };
        plugin.enricherRegistry = { invalidate: vi.fn() };
        plugin.skillRegistry = { invalidate: vi.fn() };
        plugin.graphApiService = {
            callRemoteModel: vi.fn().mockResolvedValue(JSON.stringify({
                id: 'leakcheck',
                name: 'LeakCheck',
                urlTemplate: 'https://leakcheck.example/api?q={{query}}',
                allowedDomains: ['leakcheck.example'],
                skillInstructions: 'Use for an e-mail address.',
            })),
        };
        return { app, plugin };
    }

    it('no longer read input with window.prompt, which Electron does not implement', () => {
        const source = fs.readFileSync(path.join(__dirname, '../plugin/vault-ai-plugin.ts'), 'utf8');
        expect(source).not.toMatch(/window\.prompt\s*\(/);
    });

    it('saves a drafted enricher as a disabled draft and says how to activate it', async () => {
        const { app, plugin } = await pluginOn();
        await plugin.draftHttpEnricherFromUserDetails('https://leakcheck.example/docs', 'Look up an e-mail address');
        button(document.body, 'Install').click();
        await vi.waitFor(() => expect(app.storage.peek('OSINTCopilot/custom/skills/leakcheck.md')).toBeTruthy());

        const saved = JSON.parse(app.storage.peek(SPEC_PATH)!);
        expect(saved.status).toBe('draft');
        expect(saved.enabled).toBe(false);
        const said = vi.mocked(Notice).mock.calls.map((c) => String(c[0]));
        expect(said.at(-1)).toContain('saved as a draft');
        expect(said.at(-1)).toContain('Set HTTP enricher enabled state');
    });

    it('sets the state picked in the modal without a second confirmation, and logs it', async () => {
        const { app, plugin } = await pluginOn({
            [SPEC_PATH]: JSON.stringify(spec('leakcheck', 'draft', false)),
        });
        await plugin.setHttpEnricherEnabledState('leakcheck', 'active');

        const saved = JSON.parse(app.storage.peek(SPEC_PATH)!);
        expect(saved.status).toBe('active');
        expect(saved.enabled).toBe(true);
        expect(document.querySelector('.modal-container')).toBeNull();
        expect(app.storage.peek('OSINTCopilot/custom/enrichers/audit.log.md'))
            .toContain('approved set_state id=leakcheck status=active');
        expect(plugin.enricherRegistry.invalidate).toHaveBeenCalled();
    });
});
