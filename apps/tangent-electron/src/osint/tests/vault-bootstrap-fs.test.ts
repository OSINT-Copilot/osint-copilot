import { describe, expect, it, vi } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import { createFileIfMissing, ensureFolderExists } from '../utils/vault-bootstrap-fs';
import { createTestAppAsync } from '../obsidian-shim/testing/create-test-app';
import { SkillBootstrapService } from '../skills/skill-bootstrap';
import { TaskAgentBootstrapService } from '../task-agents/task-agent-bootstrap';
import { SKILL_DEFAULT_FILES } from '../data/skill-defaults';
import { TASK_AGENT_DEFAULT_FILES } from '../data/task-agent-defaults';
import { SUPERSEDED_SKILL_DEFAULTS, SUPERSEDED_TASK_AGENT_DEFAULTS } from '../data/superseded-defaults';
import { DEFAULT_SKILLS_FOLDER, DEFAULT_TASK_AGENTS_FOLDER } from '../constants/vault-layout';

function makeApp(options: {
    existing?: TFile | TFolder | null;
    createFolder?: () => Promise<void>;
    create?: () => Promise<void>;
    stat?: ((path: string) => Promise<{ type: 'file' | 'folder' } | null>) | undefined;
}) {
    return {
        vault: {
            getAbstractFileByPath: vi.fn().mockReturnValue(options.existing ?? null),
            createFolder: vi.fn(options.createFolder ?? (() => Promise.resolve())),
            create: vi.fn(options.create ?? (() => Promise.resolve())),
            adapter: { stat: options.stat },
        },
    } as any;
}

describe('vault bootstrap filesystem helpers', () => {
    it('treats an inconclusive stat as a benign already-existing folder race', async () => {
        const originalError = new Error('Folder already exists.');
        const app = makeApp({
            createFolder: () => Promise.reject(originalError),
            stat: vi.fn().mockResolvedValue(null),
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(ensureFolderExists(app, 'OSINTCopilot')).resolves.toBeUndefined();
        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });

    it('keeps already-existing races compatible with adapters that do not expose stat', async () => {
        const app = makeApp({
            createFolder: () => Promise.reject(new Error('Folder already exists.')),
            stat: undefined,
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(ensureFolderExists(app, 'OSINTCopilot')).resolves.toBeUndefined();
        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });

    it('warns only when stat positively reports the opposite type', async () => {
        const app = makeApp({
            createFolder: () => Promise.reject(new Error('Folder already exists.')),
            stat: vi.fn().mockResolvedValue({ type: 'file' }),
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(ensureFolderExists(app, 'OSINTCopilot')).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledOnce();

        warn.mockRestore();
    });

    it('does not overwrite a folder that occupies a requested file path', async () => {
        const folder = new TFolder();
        const app = makeApp({ existing: folder });

        await expect(createFileIfMissing(app, 'OSINTCopilot/config.md', 'content'))
            .rejects.toThrow('a folder already exists at that path');
        expect(app.vault.create).not.toHaveBeenCalled();
    });

    it('propagates create failures that are not already-exists races', async () => {
        const app = makeApp({
            createFolder: () => Promise.reject(new Error('Permission denied')),
            stat: vi.fn(),
        });

        await expect(ensureFolderExists(app, 'OSINTCopilot')).rejects.toThrow('Permission denied');
        expect(app.vault.adapter.stat).not.toHaveBeenCalled();
    });
});

describe('stock skill and task-agent files', () => {
    const kinds = [
        {
            name: 'skill',
            folder: DEFAULT_SKILLS_FOLDER,
            defaults: SKILL_DEFAULT_FILES,
            superseded: SUPERSEDED_SKILL_DEFAULTS,
            bootstrap: (app: any) => new SkillBootstrapService(app, () => '').ensureDefaultsInstalled(),
        },
        {
            name: 'task-agent',
            folder: DEFAULT_TASK_AGENTS_FOLDER,
            defaults: TASK_AGENT_DEFAULT_FILES,
            superseded: SUPERSEDED_TASK_AGENT_DEFAULTS,
            bootstrap: (app: any) => new TaskAgentBootstrapService(app, () => '').ensureDefaultsInstalled(),
        },
    ];

    const oldTexts = kinds.flatMap((k) => Object.entries(k.superseded).flatMap(([file, texts]) =>
        texts.map((text, i) => ({ kind: k, file, text, label: `${k.name} ${file} #${i}` }))));

    it('upgrades the old example skill, which told the model it was a workflow sub-agent', () => {
        expect(SUPERSEDED_SKILL_DEFAULTS['example-skill.md'].some((t) => t.includes('specialized sub-agent'))).toBe(true);
        expect(oldTexts.length).toBeGreaterThanOrEqual(6);
    });

    it.each(oldTexts.map((o) => [o.label, o] as const))('replaces an unedited %s with the current default', async (_label, { kind, file, text }) => {
        const current = kind.defaults.find((d) => d.path === file)!.content;
        expect(text).not.toBe(current);
        const path = `${kind.folder}/${file}`;
        const app = await createTestAppAsync({ files: { [path]: text } });
        await kind.bootstrap(app);
        expect(app.storage.peek(path)).toBe(current);
    });

    it.each(oldTexts.map((o) => [o.label, o] as const))('leaves an edited %s alone', async (_label, { kind, file, text }) => {
        const path = `${kind.folder}/${file}`;
        const edited = text + '\nMy own note.\n';
        const app = await createTestAppAsync({ files: { [path]: edited } });
        await kind.bootstrap(app);
        expect(app.storage.peek(path)).toBe(edited);
    });
});
