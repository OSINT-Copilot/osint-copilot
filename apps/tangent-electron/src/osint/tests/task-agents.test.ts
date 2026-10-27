import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import { parseTaskAgentMarkdown } from '../task-agents/parse-manifest';
import { effectiveOutputRoots, isPathAllowedForWrite, normalizeRootList } from '../task-agents/path-allowlist';
import { applyVaultFilesV1 } from '../task-agents/write-applier';
import { TASK_AGENT_DEFAULT_FILES } from '../data/task-agent-defaults';
import { DEFAULT_TASK_AGENT_OUTPUT_ALLOWLIST } from '../constants/vault-layout';
import { createTestAppAsync } from '../obsidian-shim/testing/create-test-app';
import { parseVaultFilesJson } from '../task-agents/json-response';
import { isTaskAgentRunnable } from '../task-agents/task-agent-settings';
import type { TaskAgentManifest } from '../task-agents/types';
import { TaskAgentRunner } from '../task-agents/task-agent-runner';
import type { LocalCliService } from '../services/claude-code-service';

describe('parseTaskAgentMarkdown', () => {
  it('returns null for orchestration agent (no agent_kind task)', () => {
    const raw = `---
id: x
name: X
---
body`;
    expect(parseTaskAgentMarkdown(raw, 'p.md')).toBeNull();
  });

  it('parses valid task manifest', () => {
    const raw = `---
agent_kind: task
id: test-agent
name: Test
output_schema: vault_files_v1
output_roots: OSINTCopilot/custom/out/, Research/r/
max_notes: 5
---
Do the thing.
`;
    const m = parseTaskAgentMarkdown(raw, 'agents/test.md');
    expect(m).not.toBeNull();
    expect(m!.id).toBe('test-agent');
    expect(m!.outputRoots).toEqual(["OSINTCopilot/custom/out", "Research/r"]);
    expect(m!.maxNotes).toBe(5);
    expect(m!.body).toContain('Do the thing');
  });

  it('returns null without output_roots', () => {
    const raw = `---
agent_kind: task
id: x
name: X
output_schema: vault_files_v1
---
b`;
    expect(parseTaskAgentMarkdown(raw, 'p.md')).toBeNull();
  });
});

describe('isPathAllowedForWrite', () => {
  it('allows path under both agent and global roots', () => {
    expect(
      isPathAllowedForWrite(
        'OSINTCopilot/custom/outputs/memos/2024-01-01.md',
        ['OSINTCopilot/custom/outputs/memos/'],
        ['OSINTCopilot/custom/outputs/', 'Research/'],
      ),
    ).toBe(true);
  });

  it('rejects path outside agent root', () => {
    expect(
      isPathAllowedForWrite(
        'Research/secret.md',
        ['OSINTCopilot/custom/outputs/memos/'],
        ['OSINTCopilot/custom/outputs/', 'Research/'],
      ),
    ).toBe(false);
  });

  it('rejects path outside global root', () => {
    expect(
      isPathAllowedForWrite(
        'OSINTCopilot/custom/outputs/memos/x.md',
        ['OSINTCopilot/custom/outputs/memos/'],
        ['Research/'],
      ),
    ).toBe(false);
  });

  it('rejects dotdot', () => {
    expect(
      isPathAllowedForWrite(
        'OSINTCopilot/custom/outputs/../etc/passwd',
        ['OSINTCopilot/custom/outputs/'],
        ['OSINTCopilot/'],
      ),
    ).toBe(false);
  });
});

describe('parseVaultFilesJson', () => {
  it('parses raw JSON', () => {
    const raw = JSON.stringify({
      version: 'vault_files_v1',
      files: [{ path: 'a.md', body: 'hi' }],
    });
    const v = parseVaultFilesJson(raw);
    expect(v?.files).toHaveLength(1);
    expect(v?.files[0].path).toBe('a.md');
  });

  it('extracts from fenced block', () => {
    const raw = 'Here:\n```json\n{"version":"vault_files_v1","files":[]}\n```';
    const v = parseVaultFilesJson(raw);
    expect(v?.files).toEqual([]);
  });
});

describe('isTaskAgentRunnable', () => {
  const base: TaskAgentManifest = {
    agentKind: 'task',
    id: 'a',
    name: 'A',
    description: '',
    outputSchema: 'vault_files_v1',
    outputRoots: ['x/'],
    contextRoots: [],
    maxNotes: 10,
    maxContextChars: 100,
    enabledDefault: true,
    model: '',
    body: '',
    sourcePath: '',
  };

  it('respects master switch', () => {
    expect(
      isTaskAgentRunnable(base, {
        taskAgentsEnabled: false,
        taskAgentOverrides: {},
      }),
    ).toBe(false);
  });

  it('override false disables', () => {
    expect(
      isTaskAgentRunnable(base, {
        taskAgentsEnabled: true,
        taskAgentOverrides: { a: false },
      }),
    ).toBe(false);
  });

  it('override true enables when default false', () => {
    const m = { ...base, enabledDefault: false };
    expect(
      isTaskAgentRunnable(m, {
        taskAgentsEnabled: true,
        taskAgentOverrides: { a: true },
      }),
    ).toBe(true);
  });
});

describe('TaskAgentRunner cancellation', () => {
  it('rethrows an aborted CLI call so the chat cancellation message is preserved', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    const localCli = {
      providerId: 'codex',
      displayName: 'Codex CLI',
      setVaultSkillResolver: vi.fn(),
      updateConfig: vi.fn(),
      extractEntities: vi.fn(),
      chat: vi.fn().mockRejectedValue(abortError),
      extractTextFromImage: vi.fn(),
      isAvailable: vi.fn(),
    } satisfies LocalCliService;
    const runner = new TaskAgentRunner(
      {} as App,
      () => localCli,
      { getGlobalRules: vi.fn().mockResolvedValue('') } as any,
      () => new Map(),
      () => '',
      { globalOutputAllowlist: 'OSINTCopilot/custom/outputs' },
    );
    const manifest: TaskAgentManifest = {
      agentKind: 'task',
      id: 'cancel-test',
      name: 'Cancel test',
      description: '',
      outputSchema: 'vault_files_v1',
      outputRoots: ['OSINTCopilot/custom/outputs'],
      contextRoots: [],
      maxNotes: 1,
      maxContextChars: 100,
      enabledDefault: true,
      model: '',
      body: 'Return output.',
      sourcePath: 'agents/cancel-test.md',
    };
    const controller = new AbortController();
    controller.abort();

    await expect(runner.run(manifest, 'Do work', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

const GLOBAL_ROOTS = normalizeRootList(DEFAULT_TASK_AGENT_OUTPUT_ALLOWLIST);
const MEMO_ROOTS = ['OSINTCopilot/custom/outputs/memos'];

function manifestWith(outputRoots: string[]): TaskAgentManifest {
  return {
    agentKind: 'task',
    id: 'memo-writer',
    name: 'Memo writer',
    description: '',
    outputSchema: 'vault_files_v1',
    outputRoots,
    contextRoots: [],
    maxNotes: 1,
    maxContextChars: 100,
    enabledDefault: true,
    model: '',
    body: 'Write a memo.',
    sourcePath: 'OSINTCopilot/custom/task-agents/memo-writer.md',
  };
}

function cliReturning(raw: string) {
  return {
    providerId: 'codex',
    displayName: 'Codex CLI',
    setVaultSkillResolver: vi.fn(),
    updateConfig: vi.fn(),
    extractEntities: vi.fn(),
    chat: vi.fn().mockResolvedValue(raw),
    extractTextFromImage: vi.fn(),
    isAvailable: vi.fn(),
  } satisfies LocalCliService;
}

describe('task agent output paths', () => {
  it('writes a bare filename into the agent output folder, and still refuses a path outside it', async () => {
    const app = await createTestAppAsync();
    const res = await applyVaultFilesV1(
      app as unknown as App,
      {
        version: 'vault_files_v1',
        files: [
          { path: 'memo.md', body: '# Memo' },
          // A path with folders is not prefixed, so this stays where it was aimed.
          { path: 'Elsewhere/x.md', body: 'x' },
        ],
      },
      MEMO_ROOTS,
      GLOBAL_ROOTS,
    );
    expect(res.created).toEqual(['OSINTCopilot/custom/outputs/memos/memo.md']);
    expect(app.storage.peek('OSINTCopilot/custom/outputs/memos/memo.md')).toBe('# Memo');
    expect(res.errors).toEqual(['Not allowed: Elsewhere/x.md']);
  });

  it.each([
    // The first output root is outside the global allowlist.
    [['Elsewhere', 'OSINTCopilot/custom/outputs/memos'], 'OSINTCopilot/custom/outputs/memos/memo.md'],
    // The output root is wider than the global allowlist.
    [['OSINTCopilot'], 'OSINTCopilot/custom/outputs/memo.md'],
  ])('writes a bare filename into the first folder the model was told of (output roots %j)', async (outputRoots, expected) => {
    const app = await createTestAppAsync();
    const res = await applyVaultFilesV1(
      app as unknown as App,
      { version: 'vault_files_v1', files: [{ path: 'memo.md', body: '# Memo' }] },
      outputRoots,
      GLOBAL_ROOTS,
    );
    expect(effectiveOutputRoots(outputRoots, GLOBAL_ROOTS)[0]).toBe(expected.slice(0, expected.lastIndexOf('/')));
    expect(res.errors).toEqual([]);
    expect(res.created).toEqual([expected]);
    expect(app.storage.peek(expected)).toBe('# Memo');
  });

  it('tells the model the folders it may write to', async () => {
    const cli = cliReturning('{"version":"vault_files_v1","files":[]}');
    const runner = new TaskAgentRunner(
      {} as App,
      () => cli,
      { getGlobalRules: vi.fn().mockResolvedValue('') } as any,
      () => new Map(),
      () => '',
      { globalOutputAllowlist: DEFAULT_TASK_AGENT_OUTPUT_ALLOWLIST },
    );
    await runner.run(manifestWith(MEMO_ROOTS), 'Write a memo');
    const systemPrompt = cli.chat.mock.calls[0][0] as string;
    expect(systemPrompt).toContain('ALLOWED OUTPUT FOLDERS');
    expect(systemPrompt).toContain('OSINTCopilot/custom/outputs/memos/');
  });

  it('explains, without calling the CLI, when no output folder is inside the global allowlist', async () => {
    const cli = cliReturning('');
    const runner = new TaskAgentRunner(
      {} as App,
      () => cli,
      { getGlobalRules: vi.fn().mockResolvedValue('') } as any,
      () => new Map(),
      () => '',
      { globalOutputAllowlist: 'Research/' },
    );
    const out = await runner.run(manifestWith(MEMO_ROOTS), 'Write a memo');
    expect(cli.chat).not.toHaveBeenCalled();
    expect(out.assistantText).toContain('has nowhere to write');
    expect(out.assistantText).toContain('OSINTCopilot/custom/outputs/memos');
  });

  it('takes the deeper of an output root and a global root that overlap', () => {
    expect(effectiveOutputRoots(['OSINTCopilot/custom/outputs/memos/'], GLOBAL_ROOTS))
      .toEqual(['OSINTCopilot/custom/outputs/memos']);
    expect(effectiveOutputRoots(['OSINTCopilot'], ['OSINTCopilot/custom/outputs/', 'Research/']))
      .toEqual(['OSINTCopilot/custom/outputs']);
    expect(effectiveOutputRoots(['Elsewhere'], GLOBAL_ROOTS)).toEqual([]);
  });

  it.each(['memo-writer.md', 'report-drafter.md'])('the stock %s example path is one the agent may write', (file) => {
    const def = TASK_AGENT_DEFAULT_FILES.find((f) => f.path === file)!;
    const m = parseTaskAgentMarkdown(def.content, file)!;
    const example = /"path":\s*"([^"]+)"/.exec(m.body)![1]
      .replace('YYYY-MM-DD', '2026-09-19')
      .replace('<short-slug>', 'northgate');
    expect(isPathAllowedForWrite(example, m.outputRoots, GLOBAL_ROOTS)).toBe(true);
  });
});
