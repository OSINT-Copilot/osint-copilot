import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/agent-runtime/chat-runtime-availability', () => ({
  getChatRuntimeAvailability: vi.fn().mockResolvedValue({
    byId: { 'claude-code': true, codex: false, 'hermes-agent': false },
    availableIds: ['claude-code'],
  }),
  invalidateChatRuntimeAvailabilityCache: vi.fn(),
}));

import VaultAIPlugin from '../plugin/vault-ai-plugin';
import { ChatView } from '../views/chat-view';
import { App } from './obsidian-mock';
import {
  DEFAULT_CONVERSATION_FOLDER,
  DEFAULT_CREDENTIALS_FOLDER,
  DEFAULT_PROMPTS_FOLDER,
  DEFAULT_SCRIPTS_FOLDER,
  DEFAULT_SKILLS_FOLDER,
  DEFAULT_TASK_AGENTS_FOLDER,
  DEFAULT_TASK_AGENT_OUTPUT_ALLOWLIST,
} from '../constants/vault-layout';
import {
  DEFAULT_ENABLED_SCHEMA_FAMILIES,
  DEFAULT_OIDSF_MODAL_LAYERS,
} from '../services/schema-catalog-types';
import type { VaultAISettings } from '../settings/vault-ai-settings';

/**
 * Send routing: orchestration (handleOrchestrationAgent), or the selected task agent.
 */
describe('ChatView send routing', () => {
  let plugin: VaultAIPlugin;
  let app: App;
  let view: ChatView;

  beforeEach(() => {
    app = new App();
    plugin = new VaultAIPlugin(app as never, { id: 'test-plugin', name: 'Test Plugin' } as any);

    // Only what these tests need; `satisfies` still catches a renamed or mistyped key.
    plugin.settings = {
      systemPrompt: 'You are a vault assistant.',
      maxNotes: 15,
      enableGraphFeatures: true,
      autoRefreshGraph: true,
      autoOpenGraphOnEntityCreation: false,
      conversationFolder: DEFAULT_CONVERSATION_FOLDER,
      promptsFolder: DEFAULT_PROMPTS_FOLDER,
      activeAgentId: 'default',
      taskAgentsFolder: DEFAULT_TASK_AGENTS_FOLDER,
      taskAgentsEnabled: true,
      preferredTaskAgentId: '',
      taskAgentGlobalOutputAllowlist: DEFAULT_TASK_AGENT_OUTPUT_ALLOWLIST,
      taskAgentOverrides: {},
      skillsFolder: DEFAULT_SKILLS_FOLDER,
      enrichersFolder: "OSINTCopilot/custom/enrichers",
      credentialsFolder: DEFAULT_CREDENTIALS_FOLDER,
      scriptsFolder: DEFAULT_SCRIPTS_FOLDER,
      apiProvider: 'claude-code' as const,
      claudeCodeCliPath: 'claude',
      claudeCodeModel: 'sonnet',
      claudeCodeExtraArgs: '',
      claudeCodeTimeoutMs: 300_000,
      codexCliPath: 'codex',
      codexCliModel: '',
      codexCliExtraArgs: '',
      codexCliTimeoutMs: 300_000,
      agentRuntimeProvider: 'claude-code' as const,
      hermesAgentCliPath: 'hermes',
      hermesAgentExtraArgs: '',
      hermesAgentTimeoutMs: 120_000,
      hermesAgentHealthCheckArgs: '--version',
      customAgentRuntimes: [],
      extractionLogVerbosity: 'detailed',
      extractionDebugRawCli: false,
      lockedVaultPaths: [],
      activeGraphId: 'default',
      graphWorkspaces: [{ id: 'default', name: 'Default' }],
      enabledSchemaFamilies: { ...DEFAULT_ENABLED_SCHEMA_FAMILIES },
      oidsfModalLayers: { ...DEFAULT_OIDSF_MODAL_LAYERS },
      miroAccessToken: '',
      miroLastBoardInput: '',
    } satisfies Partial<VaultAISettings> as never;

    plugin.conversationService = {
      getMostRecentConversation: vi.fn(),
      createConversation: vi.fn().mockResolvedValue({ id: 'test-conv', messages: [] }),
      saveConversation: vi.fn(),
      getConversationList: vi.fn().mockReturnValue([]),
      setCurrentConversationId: vi.fn(),
    } as any;

    plugin.entityManager = {
      getAllEntities: vi.fn().mockReturnValue([]),
      getAllConnections: vi.fn().mockReturnValue([]),
      findEntityByLabel: vi.fn().mockReturnValue(null),
      getEntity: vi.fn().mockReturnValue(null),
      createEntity: vi.fn().mockResolvedValue({ id: 'ent-1', type: 'Person', label: 'Test' }),
    } as any;

    plugin.graphApiService = {
      processText: vi.fn().mockResolvedValue({ success: true, operations: [] }),
      extractTextFromUrl: vi.fn(),
      tryExtractTextFromUrl: vi.fn().mockResolvedValue({ ok: true, text: '' }),
      extractTextFromFile: vi.fn(),
      extractTextFromImage: vi.fn(),
      processTextInChunks: vi.fn().mockResolvedValue({ success: true, operations: [] }),
    } as any;

    plugin.orchestrationService = {
      processRequest: vi.fn().mockResolvedValue({
        finalResponse: 'Orchestration done.',
        phase: 'SYNTHESIS_COMPLETE',
      }),
    } as any;

    plugin.refreshOrOpenGraphView = vi.fn().mockResolvedValue(undefined);

    plugin.vaultPromptLoader = {
      listAgents: vi.fn().mockResolvedValue([{ id: 'default', name: 'Default' }]),
      invalidateAll: vi.fn(),
    } as any;

    plugin.taskAgentRegistry = {
      listAgents: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      invalidate: vi.fn(),
      registerVaultEvents: vi.fn(),
    } as any;
    plugin.taskAgentRunner = {
      run: vi.fn(),
      updateOptions: vi.fn(),
    } as any;

    plugin.skillRegistry = {
      listVaultSkills: vi.fn().mockResolvedValue([]),
      getVaultSkillById: vi.fn(),
      invalidate: vi.fn(),
      registerVaultEvents: vi.fn(),
    } as any;

    const leaf = {
      view: null,
      openFile: vi.fn(),
      app,
    } as any;
    view = new ChatView(leaf, plugin);
    view.app = app as never;

    view.inputEl = { value: '' } as any;
    view.messagesContainer = {
      empty: vi.fn(),
      createDiv: vi.fn().mockReturnValue({
        setAttribute: vi.fn(),
        createEl: vi.fn(),
        createDiv: vi.fn(),
        addClass: vi.fn(),
      }),
      createEl: vi.fn(),
      scrollTop: 0,
      scrollHeight: 100,
      querySelector: vi.fn(),
      querySelectorAll: vi.fn().mockReturnValue([]),
      parentElement: { scrollTop: 0, scrollHeight: 100 },
    } as any;
    view.containerEl = {
      children: [
        null,
        {
          empty: vi.fn(),
          addClass: vi.fn(),
          createDiv: vi.fn().mockReturnValue({
            createDiv: vi.fn().mockReturnValue({
              createDiv: vi.fn().mockReturnValue({
                createEl: vi.fn().mockReturnValue({ addEventListener: vi.fn() }),
                createDiv: vi.fn().mockReturnValue({
                  createEl: vi.fn().mockReturnValue({ addEventListener: vi.fn() }),
                  createDiv: vi.fn().mockReturnValue({
                    createEl: vi.fn().mockReturnValue({ addEventListener: vi.fn() }),
                    setAttribute: vi.fn(),
                  }),
                }),
              }),
            }),
          }),
        },
      ],
      querySelector: vi.fn(),
    } as any;

    view.render = vi.fn();
    view.renderMessages = vi.fn();
    view.saveCurrentConversation = vi.fn();
  });

  it('routes general mode to orchestration (processRequest)', async () => {
    view.inputEl.value = 'Investigate ACME';

    await view.handleSend();

    expect(plugin.orchestrationService.processRequest).toHaveBeenCalled();
  });

  it('passes extracted attachment text as context instead of query URLs', async () => {
    view.inputEl.value = 'Extract entities';
    view.attachedFiles = [{
      file: new File([''], 'brief.pdf', { type: 'application/pdf' }),
      extracted: true,
      content: 'Entity evidence cites https://embedded.example/report',
    }];
    (view as any).renderAttachments = vi.fn();
    const orchestration = vi.spyOn(view, 'handleOrchestrationAgent').mockResolvedValue(undefined);

    await view.handleSend();

    expect(orchestration).toHaveBeenCalledWith(
      'Extract entities',
      expect.stringContaining('https://embedded.example/report'),
    );
    expect(orchestration.mock.calls[0][0]).not.toContain('embedded.example');
  });

  it('routes a selected task-agent workflow to the task-agent handler', async () => {
    view.selectedTaskAgentId = 'evidence-report';
    view.inputEl.value = 'Create the evidence report';
    const taskAgent = vi.spyOn(view, 'handleVaultTaskAgent').mockResolvedValue(undefined);
    const orchestration = vi.spyOn(view, 'handleOrchestrationAgent');

    await view.handleSend();

    expect(taskAgent).toHaveBeenCalledWith('Create the evidence report');
    expect(orchestration).not.toHaveBeenCalled();
  });

  it('does not silently fail over or send when the selected runtime is unavailable', async () => {
    plugin.settings.agentRuntimeProvider = 'codex';
    plugin.settings.apiProvider = 'codex';
    view.inputEl.value = 'Keep this prompt with Codex';

    await view.handleSend();

    expect(plugin.settings.agentRuntimeProvider).toBe('codex');
    expect(plugin.orchestrationService.processRequest).not.toHaveBeenCalled();
    expect(view.inputEl.value).toBe('Keep this prompt with Codex');
  });
});
