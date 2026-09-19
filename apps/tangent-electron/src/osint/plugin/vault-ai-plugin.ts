import {
  Notice,
  Plugin,
  TFile,
  type CachedMetadata,
  normalizePath,
} from "obsidian";
import { parseMetadata } from '../obsidian-shim/core/metadata-cache';

// Graph plugin imports
import {
  type Entity,
  getEntityIconForEntity,
  getEntityColor,
} from '../entities/types';
import { EntityManager } from '../services/entity-manager';
import { WaybackArchiveService } from '../services/wayback-archive-service';
import { GraphApiService } from '../services/api-service';
import {
  ClaudeCodeService,
  type LocalCliService,
} from '../services/claude-code-service';
import { CodexCliService } from '../services/codex-cli-service';
import {
  ConversationService,
  type Conversation,
} from '../services/conversation-service';
import { GraphView, GRAPH_VIEW_TYPE } from '../views/graph-view';
import { TimelineView, TIMELINE_VIEW_TYPE } from '../views/timeline-view';
import { MapView, MAP_VIEW_TYPE } from '../views/map-view';
import { ToolsSkillsRegistryView, TOOLS_SKILLS_REGISTRY_VIEW_TYPE } from '../views/tools-skills-registry-view';
import { DocsView, DOCS_VIEW_TYPE } from '../views/docs-view';
import { ConfirmModal } from '../modals/confirm-modal';
import { CustomTypesService } from '../services/custom-types-service';
import { OrchestrationService } from '../services/orchestration-service';
import { VaultPromptLoader } from '../services/vault-prompt-loader';
import { VaultPromptBootstrapService } from '../services/vault-prompt-bootstrap';
import { TaskAgentRegistry } from '../task-agents/task-agent-registry';
import { TaskAgentRunner } from '../task-agents/task-agent-runner';
import { TaskAgentBootstrapService } from '../task-agents/task-agent-bootstrap';
import { SkillRegistry } from '../skills/skill-registry';
import { SkillBootstrapService } from '../skills/skill-bootstrap';
import { invalidateChatRuntimeAvailabilityCache } from '../services/agent-runtime/chat-runtime-availability';
import {
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  HERMES_RUNTIME_ID,
  normalizeCustomAgentRuntimes,
  type CustomAgentRuntime,
} from '../services/agent-runtime/runtime-registry';
import {
  DEFAULT_ENRICHERS_FOLDER,
  OSINT_COPILOT_VAULT_ROOT,
} from '../constants/vault-layout';
import { ensureCredentialsFolder } from '../services/custom-vault-writer';
import { ensureFolderExists, ensureFolderChainForFile } from '../utils/vault-bootstrap-fs';
import { VaultLockService } from '../services/vault-lock-service';
import { SchemaBootstrapService } from '../services/schema-bootstrap-service';
import { SchemaCatalogService, mergeEnabledFamilies } from '../services/schema-catalog-service';
import type { EnabledSchemaFamilies } from '../services/schema-catalog-types';
import { EnricherRegistry } from '../services/enrichers/enricher-registry';
import { enrichToolId, normalizeEnricherSpec, type EnricherSpec } from '../services/enrichers/enricher-schema';
import {
  mergeOidsfModalLayers,
  type OIDSFModalLayers,
} from '../services/schema-catalog-types';
import { LEGACY_SCHEMA_NAME_ALIASES } from '../services/schema-name-aliases';
import {
  DEFAULT_SETTINGS,
  type VaultAISettings,
} from '../settings/vault-ai-settings';
import { publishOsintPluginState } from "../integration/osint-plugin-state";
import { VaultAISettingTab } from '../settings/vault-ai-setting-tab';
import type { IndexedNote } from '../chat/indexed-note';
import { AskModal } from '../modals/ask-modal';
import { CHAT_VIEW_TYPE, ChatView } from '../views/chat-view';
import { OsintWorkspaceController } from './osint-workspace-controller';
import { host as osintHost } from '../host';
import { InboxService, readExtensionActivity } from '../services/inbox-service';
import { ExtensionActivityModal } from '../modals/extension-activity-modal';

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ============================================================================
// MAIN PLUGIN CLASS
// ============================================================================

export default class VaultAIPlugin extends Plugin {
  settings!: VaultAISettings;
  index: Map<string, IndexedNote> = new Map();

  // Graph plugin components
  entityManager!: EntityManager;
  graphApiService!: GraphApiService;
  conversationService!: ConversationService;
  customTypesService!: CustomTypesService;
  orchestrationService!: OrchestrationService;
  claudeCodeService: ClaudeCodeService | null = null;
  codexCliService: CodexCliService | null = null;
  vaultPromptLoader!: VaultPromptLoader;
  taskAgentRegistry!: TaskAgentRegistry;
  taskAgentRunner!: TaskAgentRunner;
  skillRegistry!: SkillRegistry;
  enricherRegistry!: EnricherRegistry;
  vaultLockService!: VaultLockService;
  schemaCatalogService!: SchemaCatalogService;
  waybackArchiveService!: WaybackArchiveService;
  /** Applies what the browser extension sends; started once the entity store has loaded. */
  extensionInbox: InboxService | null = null;
  /** Set by the Wayback toggle, so the next save writes this window's choice. */
  private extensionAllowWaybackChanged = false;

  attachVaultSkillFromVault(): void {
    if (!this.vaultPromptLoader) return;
    const resolver = () => this.vaultPromptLoader.getGraphExtractionSkill();
    for (const service of [this.claudeCodeService, this.codexCliService]) {
      service?.setVaultSkillResolver(resolver);
    }
  }

  /**
   * Leaf names of the non-entity folders (conversations, prompts, skills, task-agents,
   * enrichers, credentials, scripts, and the browser extension's Sources and Evidence) that
   * currently sit directly under the entity base path, so EntityManager's top-level folder
   * scan doesn't try to parse their files as entity notes.
   * Computed from the live settings rather than hardcoded defaults, so renaming e.g. the
   * conversation folder in Settings doesn't reintroduce that exact scan.
   */
  private getReservedEntityFolderNames(): string[] {
    const base = normalizePath(OSINT_COPILOT_VAULT_ROOT);
    const prefix = `${base}/`;
    const leafName = (path: string): string | null => {
      const normalized = normalizePath(path.trim());
      if (!normalized.startsWith(prefix)) return null;
      return normalized.slice(prefix.length).split('/')[0] || null;
    };
    const candidates = [
      this.settings.conversationFolder,
      this.settings.promptsFolder,
      this.settings.skillsFolder,
      this.settings.taskAgentsFolder,
      this.settings.enrichersFolder,
      this.settings.credentialsFolder,
      this.settings.scriptsFolder,
    ];
    // Sources holds one note per web page the browser extension sent something from, and
    // Evidence its captures: records about pages, never entities.
    return [...new Set([...candidates.map(leafName), 'Sources', 'Evidence'].filter((n): n is string => !!n))];
  }

  getLocalCliService(providerId: 'claude-code' | 'codex' = this.settings.apiProvider): LocalCliService | null {
    return providerId === 'codex' ? this.codexCliService : this.claudeCodeService;
  }

  getLocalCliModel(providerId: 'claude-code' | 'codex' = this.settings.apiProvider): string {
    return providerId === 'codex'
      ? this.settings.codexCliModel
      : (this.settings.claudeCodeModel || 'sonnet');
  }

  initLocalCliServices() {
    const adapter = this.app.vault.adapter as any;
    const basePath = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
    const claude = new ClaudeCodeService({
      cliPath: this.settings.claudeCodeCliPath || 'claude',
      model: this.settings.claudeCodeModel || 'sonnet',
      cliWorkingDirectory: basePath || undefined,
      extraCliArgs: this.settings.claudeCodeExtraArgs ?? '',
      timeoutMs: this.settings.claudeCodeTimeoutMs || 300_000,
    });
    const codex = new CodexCliService({
      cliPath: this.settings.codexCliPath || 'codex',
      model: this.settings.codexCliModel || '',
      cliWorkingDirectory: basePath || undefined,
      extraCliArgs: this.settings.codexCliExtraArgs ?? '',
      timeoutMs: this.settings.codexCliTimeoutMs || 300_000,
    });
    this.claudeCodeService = claude;
    this.codexCliService = codex;
    this.graphApiService.setLocalCliService(claude);
    this.graphApiService.setLocalCliService(codex);
    this.attachVaultSkillFromVault();
  }

  getEnabledSchemaFamilies(): EnabledSchemaFamilies {
    return mergeEnabledFamilies(this.settings.enabledSchemaFamilies);
  }

  getGraphEntityVisual(entity: Entity): { color: string; icon: string } {
    const icon = getEntityIconForEntity(entity);
    if (this.schemaCatalogService) {
      const { color } = this.schemaCatalogService.getEntityVisualForGraph(entity);
      return { color, icon };
    }
    return { color: getEntityColor(entity.type as string), icon };
  }

  async onload() {
    await this.loadSettings();

    this.vaultLockService = new VaultLockService(this);
    this.vaultLockService.initializeFromSettings();

    // Initialize custom types service (load schemas before entity manager)
    this.customTypesService = new CustomTypesService(this.app);
    await this.customTypesService.initialize();

    try {
      await new SchemaBootstrapService(this.app).ensureDefaultsInstalled();
    } catch (e) {
      console.warn('OSINTCopilot: schema vault bootstrap failed:', e);
    }

    // Initialize graph plugin components
    this.entityManager = new EntityManager(
      this.app,
      OSINT_COPILOT_VAULT_ROOT,
      this.vaultLockService,
      () => this.getReservedEntityFolderNames(),
    );
    this.waybackArchiveService = new WaybackArchiveService(this.app);
    this.entityManager.setWaybackArchiveService(this.waybackArchiveService);
    this.schemaCatalogService = new SchemaCatalogService(this.app);
    this.entityManager.setSchemaCatalogService(this.schemaCatalogService);
    try {
      await this.schemaCatalogService.rebuild();
    } catch (e) {
      console.warn('OSINTCopilot: schema catalog rebuild failed:', e);
    }

    this.graphApiService = new GraphApiService();
    this.graphApiService.setSettings({
      apiProvider: this.settings.apiProvider,
    });
    this.vaultPromptLoader = new VaultPromptLoader(
      this.app,
      () => this.settings.promptsFolder,
      () => this.settings.activeAgentId,
    );
    try {
      await new VaultPromptBootstrapService(this.app, () => this.settings.promptsFolder).ensureDefaultsInstalled();
    } catch (e) {
      console.warn('OSINTCopilot: vault prompt bootstrap failed:', e);
    }
    this.vaultPromptLoader.registerVaultEvents(this);
    this.initLocalCliServices();

    this.taskAgentRegistry = new TaskAgentRegistry(this.app, () => this.settings.taskAgentsFolder);
    this.taskAgentRegistry.registerVaultEvents(this);
    try {
      await new TaskAgentBootstrapService(this.app, () => this.settings.taskAgentsFolder).ensureDefaultsInstalled();
    } catch (e) {
      console.warn('OSINTCopilot: task-agent bootstrap failed:', e);
    }
    this.skillRegistry = new SkillRegistry(this.app, () => this.settings.skillsFolder);
    this.skillRegistry.registerVaultEvents(this);
    try {
      await new SkillBootstrapService(this.app, () => this.settings.skillsFolder).ensureDefaultsInstalled();
    } catch (e) {
      console.warn('OSINTCopilot: skill bootstrap failed:', e);
    }
    try {
      const enricherRoot = this.settings.enrichersFolder.trim() || DEFAULT_ENRICHERS_FOLDER;
      await ensureFolderExists(this.app, enricherRoot);
    } catch (e) {
      console.warn('OSINTCopilot: enricher folder bootstrap failed:', e);
    }
    try {
      await ensureCredentialsFolder(this);
    } catch (e) {
      console.warn('OSINTCopilot: credentials folder bootstrap failed:', e);
    }
    this.enricherRegistry = new EnricherRegistry(this.app, () => this.settings.enrichersFolder);
    this.enricherRegistry.registerVaultEvents(this);
    this.taskAgentRunner = new TaskAgentRunner(
      this.app,
      () => this.getLocalCliService(),
      this.vaultPromptLoader,
      () => this.index,
      () => this.getLocalCliModel(),
      {
        globalOutputAllowlist: this.settings.taskAgentGlobalOutputAllowlist,
        isPathLocked: (p) => this.vaultLockService.isPathLocked(p),
      },
    );

    // Initialize conversation service
    this.conversationService = new ConversationService(this.app, this.settings.conversationFolder);
    try {
      await this.conversationService.initialize();
      console.debug('OSINTCopilot: Conversation service initialized');
    } catch (error) {
      console.warn('OSINTCopilot: Conversation service initialization had issues:', error);
    }

    // Initialize Orchestration Service
    this.orchestrationService = new OrchestrationService(this);

    // Initialize entity manager if graph features are enabled
    // This is done separately from API health check to ensure local features work
    // even when the API is unavailable
    if (this.settings.enableGraphFeatures) {
      // Initialize local entity storage (non-blocking on errors)
      try {
        await this.entityManager.initialize();
        this.graphFeaturesInitialised = true;
        console.debug('OSINTCopilot: Local entity storage initialized');
        this.startExtensionInbox();
      } catch (error) {
        // Log but don't block - entity manager can still work for basic operations
        console.warn('OSINTCopilot: Entity storage initialization had issues:', error);
      }

      // Check API health in background (non-blocking)
      this.graphApiService.checkHealth().then(health => {
        const service = this.getLocalCliService();
        if (health) {
          console.debug(`OSINTCopilot: ${service?.displayName || 'Local AI CLI'} available for extraction`, health);
        } else {
          console.debug(`OSINTCopilot: ${service?.displayName || 'Local AI CLI'} not detected for entity extraction`);
        }
      }).catch(() => {
        console.debug('OSINTCopilot: Local AI CLI health check failed');
      });
    }

    // Register views
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) => new ChatView(leaf, this)
    );

    // Register graph views (always register, but only initialize if enabled)
    this.registerView(
      GRAPH_VIEW_TYPE,
      (leaf) => {
        console.debug('[VaultAIPlugin] Creating GraphView instance');
        if (!this.settings.enableGraphFeatures) {
          console.warn('[VaultAIPlugin] Graph features are disabled in settings');
        }
        return new GraphView(
          leaf,
          this.entityManager,
          (entityId) => this.onEntityClick(entityId),
          (entityId) => { void this.showEntityOnMap(entityId); },
          this,
        );
      }
    );

    this.registerView(
      TIMELINE_VIEW_TYPE,
      (leaf) => new TimelineView(leaf, this.entityManager, (entityId) => this.onEntityClick(entityId))
    );

    this.registerView(
      MAP_VIEW_TYPE,
      (leaf) => new MapView(leaf, this.entityManager, (entityId) => this.onEntityClick(entityId))
    );

    this.registerView(TOOLS_SKILLS_REGISTRY_VIEW_TYPE, (leaf) => new ToolsSkillsRegistryView(leaf, this));

    // The guide takes no host: it renders static content from data/guide-content.ts.
    this.registerView(DOCS_VIEW_TYPE, (leaf) => new DocsView(leaf));

    // No ribbon icons: the shell renders the OSINT views as a button group in Tangent's
    // top bar (integration/OsintViewsPill.svelte), driven by the Tangent-side commands in
    // app/model/commands/OsintViewCommands.ts, and "New canvas board" lives in the New Note
    // menu.

    // Build initial index
    await this.buildIndex();

    // Register file watchers
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        // Notes only. Every saveSettings() writes .osint-copilot/data.json through the
        // vault, and without the filter that file -- Miro token included -- was indexed
        // as a note and could be pasted into a prompt by retrieveNotes().
        if (file instanceof TFile && file.extension === 'md') {
          void this.indexFile(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        // Notes only. Every saveSettings() writes .osint-copilot/data.json through the
        // vault, and without the filter that file -- Miro token included -- was indexed
        // as a note and could be pasted into a prompt by retrieveNotes().
        if (file instanceof TFile && file.extension === 'md') {
          void this.indexFile(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.index.delete(file.path);
        }
      })
    );

    let schemaCatalogDebounce: number | null = null;
    const scheduleSchemaCatalogRebuild = () => {
      if (schemaCatalogDebounce !== null) window.clearTimeout(schemaCatalogDebounce);
      schemaCatalogDebounce = window.setTimeout(() => {
        void this.schemaCatalogService?.rebuild();
      }, 650);
    };
    const isUnderEntitySchemas = (path: string) => {
      const base = normalizePath(OSINT_COPILOT_VAULT_ROOT);
      const prefix = normalizePath(`${base}/schemas`);
      const p = normalizePath(path);
      return p === prefix || p.startsWith(`${prefix}/`);
    };
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && isUnderEntitySchemas(file.path)) {
          scheduleSchemaCatalogRebuild();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && isUnderEntitySchemas(file.path)) {
          scheduleSchemaCatalogRebuild();
        }
      }),
    );

    // Register commands - grouped by feature
    // Main OSINT Copilot commands (Chat, Graph, Timeline, Map)
    // The view-opening commands are registered on Tangent's side
    // (app/model/commands/OsintViewCommands.ts), where they carry shortcuts and an
    // active state. Registering them here too put every view in the palette twice.
    this.addCommand({
      id: "export-investigation",
      name: "Export current investigation",
      callback: () => {
        try {
          const json = this.entityManager.exportToJSON();
          const blob = new Blob([json], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');

          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
          a.href = url;
          a.download = `osint-investigation-${timestamp}.json`;
          a.click();

          URL.revokeObjectURL(url);
          new Notice('Investigation exported successfully');
        } catch (error) {
          console.error('[OSINT Copilot] Export failed:', error);
          new Notice('Failed to export investigation');
        }
      },
    });

    // Utility commands
    this.addCommand({
      id: "ask-vault",
      name: "Ask (remote)",
      callback: () => {
        this.openAskModal();
      },
    });

    this.addCommand({
      id: "reindex-vault",
      name: "Reindex vault",
      callback: () => {
        void this.buildIndex().then(() => {
          new Notice("Vault reindexed successfully.");
        });
      },
    });

    this.addCommand({
      id: "reload-entities",
      name: "Reload entities from notes",
      callback: () => {
        void this.entityManager.loadEntitiesFromNotes().then(() => {
          new Notice("Entities reloaded from notes.");
        });
      },
    });

    this.addCommand({
      id: "oidsf-normalize-legacy-schema-names",
      name: "Normalize legacy OIDSF schema names in entity notes",
      callback: () => {
        void this.normalizeLegacyOidsfSchemaNamesInVault();
      },
    });

    this.addCommand({
      id: "normalize-entity-frontmatter-reserved-keys",
      name: "Normalize entity frontmatter reserved keys (props namespace)",
      callback: () => {
        void (async () => {
          try {
            const summary = await this.entityManager.migrateReservedPropertyFrontmatter();
            new Notice(
              `Frontmatter normalization complete: scanned ${summary.scanned}, fixed ${summary.fixed}, skipped ${summary.skipped}, errors ${summary.errors}.`,
              9000,
            );
            await this.entityManager.loadEntitiesFromNotes();
            await this.refreshOrOpenGraphView();
          } catch (e) {
            new Notice(`Normalization failed: ${e instanceof Error ? e.message : String(e)}`, 9000);
          }
        })();
      },
    });

    this.addCommand({
      id: "reload-vault-prompts",
      name: "Reload vault prompts",
      callback: () => {
        this.vaultPromptLoader?.invalidateAll();
        this.taskAgentRegistry?.invalidate();
        this.skillRegistry?.invalidate();
        this.enricherRegistry?.invalidate();
        this.attachVaultSkillFromVault();
        new Notice("Vault prompts, skills, enrichers, and task-agent registry refreshed.");
      },
    });

    this.addCommand({
      id: "install-missing-vault-prompts",
      name: "Install missing vault prompt files",
      callback: () => {
        void (async () => {
          try {
            await new VaultPromptBootstrapService(this.app, () => this.settings.promptsFolder).ensureDefaultsInstalled();
            await new TaskAgentBootstrapService(this.app, () => this.settings.taskAgentsFolder).ensureDefaultsInstalled();
            await new SkillBootstrapService(this.app, () => this.settings.skillsFolder).ensureDefaultsInstalled();
            const enricherRoot = this.settings.enrichersFolder.trim() || DEFAULT_ENRICHERS_FOLDER;
            await ensureFolderExists(this.app, enricherRoot);
            await ensureCredentialsFolder(this);
            this.vaultPromptLoader?.invalidateAll();
            this.taskAgentRegistry?.invalidate();
            this.skillRegistry?.invalidate();
            this.enricherRegistry?.invalidate();
            this.attachVaultSkillFromVault();
            new Notice("Missing default prompt, skills, enricher, and task-agent folders/files were created (existing files unchanged).");
          } catch (e) {
            new Notice(`Failed: ${e instanceof Error ? e.message : String(e)}`, 5000);
          }
        })();
      },
    });

    this.addCommand({
      id: "show-browser-extension-activity",
      name: "Show browser extension activity",
      callback: () => this.openExtensionActivity(),
    });

    this.addCommand({
      id: "draft-http-enricher-from-api-docs",
      name: "Draft HTTP enricher skill from API documentation",
      callback: () => {
        void this.draftHttpEnricherFromUserDetails();
      },
    });
    this.addCommand({
      id: "set-http-enricher-enabled-state",
      name: "Set HTTP enricher enabled state (approval required)",
      callback: () => {
        void this.setHttpEnricherEnabledState();
      },
    });

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.vaultLockService.onVaultRename(file, oldPath);
      }),
    );

    // Add settings tab
    this.addSettingTab(new VaultAISettingTab(this.app, this));
  }

  private extractJsonObject(raw: string): Record<string, unknown> | null {
    const text = String(raw || "").trim();
    if (!text) return null;
    const fenced = text.match(/```json\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1] || text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  private async appendEnricherAuditLine(line: string): Promise<void> {
    const enricherRoot = this.settings.enrichersFolder.trim() || DEFAULT_ENRICHERS_FOLDER;
    const path = normalizePath(`${enricherRoot}/audit.log.md`);
    const stamped = `- ${new Date().toISOString()} ${line}\n`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const prev = await this.app.vault.read(existing);
      await this.app.vault.modify(existing, prev + stamped);
      return;
    }
    await ensureFolderChainForFile(this.app, path);
    await this.app.vault.create(path, "# Enricher audit log\n\n" + stamped);
  }

  private async draftHttpEnricherFromUserDetails(): Promise<void> {
    const docUrl = (window.prompt("API documentation URL for this enricher:") || "").trim();
    if (!docUrl) {
      new Notice("Cancelled: API documentation URL is required.");
      return;
    }
    const details = (window.prompt("What should this enricher search and return? Include required params.") || "").trim();
    if (!details) {
      new Notice("Cancelled: integration details are required.");
      return;
    }
    const system = [
      "You draft JSON for an OSINT HTTP enricher tool that will run inside Obsidian (plugin HTTP, not a browser tab).",
      "Return ONLY one JSON object with keys:",
      "id, name, description, method, urlTemplate, allowedDomains, authType, authEnvVar, authHeaderName, authQueryParam, vaultRelativePath, inputHints, skillInstructions.",
      "Runtime: Obsidian uses requestUrl (no CORS from app origin). urlTemplate must hit the real API origin — do not rely on browser-only session cookies or front-end-only endpoints.",
      "allowedDomains must list every hostname used in urlTemplate (API host), not only the documentation site host.",
      "Auth: prefer bearer_vault | header_vault | query_vault with vaultRelativePath (relative path under the vault credentials folder); use bearer_env | header_env | query_env only if appropriate. Never put API keys or secrets in the JSON.",
      "Use {{query}} and {{attachments_context}} in urlTemplate or body when relevant.",
      "If the integration is only usable from a logged-in browser UI (cookie/session webmail style), respond with a JSON object whose skillInstructions clearly state the API is not suitable as an HTTP enricher and the user should paste exports instead.",
      "Never include credentials or API keys.",
    ].join("\n");
    const user = `Documentation URL:\n${docUrl}\n\nUser requirements:\n${details}`;
    let parsed: Record<string, unknown> | null = null;
    let docHost = "";
    try { docHost = new URL(docUrl).hostname; } catch { docHost = ""; }
    try {
      const raw = await this.graphApiService.callRemoteModel(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      );
      parsed = this.extractJsonObject(raw);
    } catch (e) {
      console.warn("[EnricherDraft] model draft failed, using fallback:", e);
    }

    const draft = normalizeEnricherSpec({
      id: parsed?.["id"] || details.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: parsed?.["name"] || "Custom Enricher",
      description: parsed?.["description"] || details,
      documentationUrl: docUrl,
      status: "active",
      enabled: true,
      allowedDomains: parsed?.["allowedDomains"] || (docHost ? [docHost] : []),
      auth: {
        type: parsed?.["authType"] || "none",
        envVar: parsed?.["authEnvVar"] || "",
        headerName: parsed?.["authHeaderName"] || "X-API-Key",
        queryParam: parsed?.["authQueryParam"] || "api_key",
        vaultRelativePath:
          typeof parsed?.["vaultRelativePath"] === "string" ? String(parsed["vaultRelativePath"]).trim() : "",
      },
      request: {
        method: String(parsed?.["method"] || "GET").toUpperCase() === "POST" ? "POST" : "GET",
        urlTemplate: parsed?.["urlTemplate"] || docUrl,
        headers: { "User-Agent": "OSINT-Copilot-Enricher/1.0" },
      },
      inputHints: parsed?.["inputHints"] || ["query"],
      skillInstructions: parsed?.["skillInstructions"] || "Use this enricher when the user asks for this data source.",
      limits: {
        timeoutMs: 15000,
        retries: 1,
        maxResponseChars: 8000,
      },
      updatedAt: new Date().toISOString(),
    });
    if (!draft) {
      new Notice("Failed to build enricher draft.");
      return;
    }

    const enricherPath = `${this.settings.enrichersFolder}/${draft.id}.json`;
    const skillPath = `${this.settings.skillsFolder}/${draft.id}.md`;
    const skillMd = `---
skill_kind: vault
id: ${draft.id}
name: ${draft.name}
description: ${draft.description}
---
${draft.skillInstructions}

Tool id: ${enrichToolId(draft.id)}
This skill executes the configured HTTP enricher spec in ${enricherPath}.
Do not tell the user to run raw curl from Obsidian for this API; unified chat should call this tool via enricher_invocations with enricher_id \`${draft.id}\`.
`;
    const confirmMsg = [
      "Is it OK to install this enricher skill into your vault and create or update the files below?",
      `Enricher: "${draft.name}"`,
      `Spec (JSON): ${enricherPath}`,
      `Skill (markdown): ${skillPath}`,
      `Auth mode: ${draft.auth.type}${draft.auth.envVar ? ` (env: ${draft.auth.envVar})` : ""}`,
      "No credentials will be stored; env var references only.",
    ].join("\n");
    new ConfirmModal(
      this.app,
      "Install enricher skill?",
      confirmMsg,
      () => {
        void (async () => {
          try {
            await ensureFolderChainForFile(this.app, enricherPath);
            await ensureFolderChainForFile(this.app, skillPath);
            const existingSpec = this.app.vault.getAbstractFileByPath(enricherPath);
            if (existingSpec instanceof TFile) {
              await this.app.vault.modify(existingSpec, JSON.stringify(draft, null, 2));
            } else {
              await this.app.vault.create(enricherPath, JSON.stringify(draft, null, 2));
            }
            const existingSkill = this.app.vault.getAbstractFileByPath(skillPath);
            if (existingSkill instanceof TFile) {
              await this.app.vault.modify(existingSkill, skillMd);
            } else {
              await this.app.vault.create(skillPath, skillMd);
            }
            this.enricherRegistry.invalidate();
            this.skillRegistry.invalidate();
            await this.appendEnricherAuditLine(`approved create_or_update id=${draft.id} doc=${docUrl}`);
            new Notice(`Enricher ${draft.name} saved and activated.`);
          } catch (e) {
            new Notice(`Failed to save enricher: ${e instanceof Error ? e.message : String(e)}`, 8000);
          }
        })();
      },
      () => new Notice("Enricher draft cancelled."),
      false,
      "Install",
      "Cancel",
    ).open();
  }

  private async setHttpEnricherEnabledState(): Promise<void> {
    const idInput = (window.prompt("Enricher id (without ENRICH_):") || "").trim().toLowerCase();
    if (!idInput) return;
    const nextRaw = (window.prompt("Set state: active or disabled") || "").trim().toLowerCase();
    const nextStatus = nextRaw === "disabled" ? "disabled" : nextRaw === "active" ? "active" : "";
    if (!nextStatus) {
      new Notice("Cancelled: state must be 'active' or 'disabled'.");
      return;
    }
    const path = `${this.settings.enrichersFolder}/${idInput}.json`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Enricher not found: ${path}`);
      return;
    }
    const raw = await this.app.vault.read(file);
    const parsed = normalizeEnricherSpec(JSON.parse(raw));
    if (!parsed) {
      new Notice("Invalid enricher spec JSON.");
      return;
    }
    const nextEnabled = nextStatus === "active";
    const msg = `Change enricher "${parsed.name}" status to ${nextStatus}?`;
    new ConfirmModal(
      this.app,
      "Approve enricher state change",
      msg,
      () => {
        void (async () => {
          parsed.status = nextStatus as EnricherSpec["status"];
          parsed.enabled = nextEnabled;
          parsed.updatedAt = new Date().toISOString();
          await this.app.vault.modify(file, JSON.stringify(parsed, null, 2));
          this.enricherRegistry.invalidate();
          await this.appendEnricherAuditLine(`approved set_state id=${parsed.id} status=${nextStatus}`);
          new Notice(`Enricher ${parsed.name} is now ${nextStatus}.`);
        })();
      },
      () => new Notice("State change cancelled."),
    ).open();
  }

  /**
   * Starts applying the browser extension's inbox. Only after the entity store has loaded:
   * matching an arriving address against the entities already here needs their index, and
   * without it every item would become a duplicate.
   */
  private startExtensionInbox(): void {
    if (this.extensionInbox) return;
    const service = new InboxService({
      app: this.app,
      entityManager: this.entityManager,
      inbox: osintHost.inbox,
      allowWayback: () => this.readExtensionAllowWayback(),
      notify: (applied, dropped) => this.notifyExtensionItems(applied, dropped),
    });
    this.extensionInbox = service;
    void service.start().catch((e) => {
      console.warn('OSINTCopilot: browser extension inbox did not start:', e);
    });
  }

  /**
   * The investigation's Wayback choice as saved on disk, or null when the file cannot be
   * read. This window's settings are a copy loaded at start, and the toggle may have been
   * changed in another window on the same investigation since. Read directly rather than
   * through loadData, which on a damaged file keeps a backup and raises a notice: this
   * runs on every settings save.
   */
  private async readSavedExtensionAllowWayback(): Promise<boolean | null> {
    try {
      // The shim's settings file (obsidian-shim/core/plugin.ts, DATA_PATH).
      const raw: unknown = JSON.parse(await this.app.vault.adapter.read('.osint-copilot/data.json'));
      if (!raw || typeof raw !== 'object') return null;
      return (raw as Record<string, unknown>).extensionAllowWayback === true;
    } catch {
      return null;
    }
  }

  private async readExtensionAllowWayback(): Promise<boolean> {
    return (await this.readSavedExtensionAllowWayback()) ?? this.settings.extensionAllowWayback === true;
  }

  /** Asks before the Settings page revokes a paired extension, which cannot be undone. */
  confirmExtensionRevoke(origin: string): Promise<boolean> {
    return new Promise((resolve) => {
      new ConfirmModal(
        this.app,
        'Revoke this extension?',
        `${origin} will no longer be able to send items to OSINT Copilot. To use it again, pair it again.`,
        () => resolve(true),
        () => resolve(false),
        true,
        'Revoke',
      ).open();
    });
  }

  /** The Settings toggle. The one place this window changes the saved Wayback choice. */
  async setExtensionAllowWayback(allow: boolean): Promise<void> {
    this.settings.extensionAllowWayback = allow;
    this.extensionAllowWaybackChanged = true;
    await this.saveSettings();
  }

  private notifyExtensionItems(applied: number, dropped: number): void {
    if (dropped > 0) {
      // The extension reported these as accepted; the investigator should not assume
      // they are in the case.
      new Notice(
        `${dropped} ${dropped === 1 ? 'item' : 'items'} from the browser extension could not be added to this investigation: this version of the app does not know that kind of item.`,
        10_000,
      );
    }
    if (applied === 0) return;
    const notice = new Notice(
      `${applied} ${applied === 1 ? 'item' : 'items'} added from the browser extension. Click to review.`,
      10_000,
    );
    // The Notice hides itself on click; the dialog is what the click is for.
    notice.noticeEl?.addEventListener('click', () => this.openExtensionActivity());
    // Open views only: an item arriving from the browser must not open the graph.
    if (this.settings.autoRefreshGraph) void this.refreshOpenInsightViews();
  }

  openExtensionActivity(): void {
    new ExtensionActivityModal(this.app, {
      // Read fresh each time the list is shown: any window may have added or removed items.
      items: () => readExtensionActivity(osintHost.inbox),
      remove: async (bundleId) => {
        if (!this.extensionInbox) throw new Error('The investigation\'s entities have not loaded yet.');
        const removed = await this.extensionInbox.remove(bundleId);
        if (removed && this.settings.autoRefreshGraph) void this.refreshOpenInsightViews();
        return removed;
      },
    }).open();
  }

  async loadSettings() {
    const loaded = await this.loadData();
    const raw = (
      loaded !== null && typeof loaded === "object" && !Array.isArray(loaded)
        ? { ...(loaded as Record<string, unknown>) }
        : {}
    ) as Record<string, unknown>;
    const legacyKeys = [
      "reportApiKey",
      "graphApiUrl",
      "reportOutputDir",
      "subscriptionPlan",
      "subscriptionStatus",
      "subscriptionCredits",
      "subscriptionExpires",
    ] as const;
    let stripped = false;
    for (const k of legacyKeys) {
      if (k in raw) {
        delete raw[k];
        stripped = true;
      }
    }
    const merged = Object.assign({}, DEFAULT_SETTINGS, raw) as Record<string, unknown>;
    if (!merged.taskAgentOverrides || typeof merged.taskAgentOverrides !== 'object') {
      merged.taskAgentOverrides = {};
    }
    if (typeof merged.enrichersFolder !== 'string' || !merged.enrichersFolder.trim()) {
      merged.enrichersFolder = DEFAULT_SETTINGS.enrichersFolder;
    }
    if (typeof merged.credentialsFolder !== 'string' || !merged.credentialsFolder.trim()) {
      merged.credentialsFolder = DEFAULT_SETTINGS.credentialsFolder;
    }
    if (typeof merged.scriptsFolder !== 'string' || !merged.scriptsFolder.trim()) {
      merged.scriptsFolder = DEFAULT_SETTINGS.scriptsFolder;
    }
    if (!Array.isArray(merged.lockedVaultPaths)) {
      merged.lockedVaultPaths = [];
    }
    if (typeof merged.activeGraphId !== 'string' || !merged.activeGraphId) {
      merged.activeGraphId = 'default';
    }
    if (!Array.isArray(merged.graphWorkspaces) || merged.graphWorkspaces.length === 0) {
      merged.graphWorkspaces = [{ id: 'default', name: 'Default' }];
    }
    merged.enabledSchemaFamilies = mergeEnabledFamilies(
      raw.enabledSchemaFamilies as Partial<EnabledSchemaFamilies> | undefined,
    );
    merged.oidsfModalLayers = mergeOidsfModalLayers(
      raw.oidsfModalLayers as Partial<OIDSFModalLayers> | undefined,
    );
    merged.customAgentRuntimes = normalizeCustomAgentRuntimes(raw.customAgentRuntimes);
    const validRuntimeIds = new Set<string>([
      CLAUDE_RUNTIME_ID,
      CODEX_RUNTIME_ID,
      HERMES_RUNTIME_ID,
      // A disabled runtime is not a valid selection: the dropdown hides it, so leaving
      // the setting pointed at it ran the disabled CLI while the UI said Claude.
      ...((merged.customAgentRuntimes as CustomAgentRuntime[]).filter((rt) => rt.enabled !== false).map((rt) => rt.id)),
    ]);
    const arp = typeof merged.agentRuntimeProvider === 'string' ? merged.agentRuntimeProvider : '';
    if (!validRuntimeIds.has(arp)) {
      merged.agentRuntimeProvider = DEFAULT_SETTINGS.agentRuntimeProvider;
    }
    if (typeof merged.hermesAgentCliPath !== 'string' || !merged.hermesAgentCliPath.trim()) {
      merged.hermesAgentCliPath = DEFAULT_SETTINGS.hermesAgentCliPath;
    }
    if (typeof merged.claudeCodeExtraArgs !== 'string') {
      merged.claudeCodeExtraArgs = DEFAULT_SETTINGS.claudeCodeExtraArgs;
    }
    if (merged.apiProvider !== CLAUDE_RUNTIME_ID && merged.apiProvider !== CODEX_RUNTIME_ID) {
      merged.apiProvider = DEFAULT_SETTINGS.apiProvider;
    }
    if (typeof merged.codexCliPath !== 'string' || !merged.codexCliPath.trim()) {
      merged.codexCliPath = DEFAULT_SETTINGS.codexCliPath;
    }
    if (typeof merged.codexCliModel !== 'string') {
      merged.codexCliModel = DEFAULT_SETTINGS.codexCliModel;
    }
    if (typeof merged.codexCliExtraArgs !== 'string') {
      merged.codexCliExtraArgs = DEFAULT_SETTINGS.codexCliExtraArgs;
    }
    if (typeof merged.codexCliTimeoutMs !== 'number' || merged.codexCliTimeoutMs < 5000) {
      merged.codexCliTimeoutMs = DEFAULT_SETTINGS.codexCliTimeoutMs;
    }
    if (typeof merged.hermesAgentExtraArgs !== 'string') {
      merged.hermesAgentExtraArgs = DEFAULT_SETTINGS.hermesAgentExtraArgs;
    }
    if (typeof merged.hermesAgentTimeoutMs !== 'number' || merged.hermesAgentTimeoutMs < 5000) {
      merged.hermesAgentTimeoutMs = DEFAULT_SETTINGS.hermesAgentTimeoutMs;
    }
    if (typeof merged.hermesAgentHealthCheckArgs !== 'string' || !merged.hermesAgentHealthCheckArgs.trim()) {
      merged.hermesAgentHealthCheckArgs = DEFAULT_SETTINGS.hermesAgentHealthCheckArgs;
    }
    if (merged.extractionLogVerbosity !== 'minimal' && merged.extractionLogVerbosity !== 'detailed') {
      merged.extractionLogVerbosity = DEFAULT_SETTINGS.extractionLogVerbosity;
    }
    if (typeof merged.extractionDebugRawCli !== 'boolean') {
      merged.extractionDebugRawCli = DEFAULT_SETTINGS.extractionDebugRawCli;
    }

    // One-time basemap migration.
    //
    // "none" shipped as the default before there was any UI to change it, so every
    // existing vault has it persisted -- and a persisted value beats a changed default,
    // which would leave those users staring at the same empty map the new default exists
    // to fix. The version marker means an analyst who later chooses "none" deliberately
    // keeps it.
    // Tested against `raw`, not `merged`: merged already carries the DEFAULT_SETTINGS
    // value, so asking it whether the key was present always answers yes and the
    // migration silently never runs.
    if (!('mapSettingsVersion' in raw)) {
      if (merged.mapOnlineTileProvider === 'none') {
        merged.mapOnlineTileProvider = DEFAULT_SETTINGS.mapOnlineTileProvider;
      }
      merged.mapSettingsVersion = 1;
      stripped = true;
    }
    // The four OpenFreeMap style names were never used by the renderer; the palette
    // setting that replaced them normalizes anything it does not recognise.
    if ('mapOpenFreeMapStyle' in merged) {
      delete merged.mapOpenFreeMapStyle;
      stripped = true;
    }
    if (merged.mapBasemapTheme !== 'auto' && merged.mapBasemapTheme !== 'light' && merged.mapBasemapTheme !== 'dark') {
      merged.mapBasemapTheme = DEFAULT_SETTINGS.mapBasemapTheme;
    }
    if (typeof merged.extensionAllowWayback !== 'boolean') {
      merged.extensionAllowWayback = DEFAULT_SETTINGS.extensionAllowWayback;
    }

    this.settings = merged as unknown as VaultAISettings;
    // The toolbar and the view commands read the graph-features gate from here.
    publishOsintPluginState({ settings: this.settings });
    if (stripped) {
      await this.saveData(this.settings);
    }
  }

  /**
   * Creates a canvas board and navigates to it.
   *
   * A board is a real `.canvas` file, not one of the singleton marker files the other
   * OSINT views use, so there can be any number of them and each opens as its own document.
   */
  async createCanvasBoard(): Promise<void> {
    try {
      const { createCanvas } = await import("../canvas/canvas-commands");
      const result = await createCanvas(this.app.vault);
      if (!result.opened) {
        new Notice(`Created ${result.path}, but it could not be opened yet.`);
      }
    } catch (e) {
      console.error("[osint] could not create a canvas", e);
      new Notice(`Could not create the canvas: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Keys whose change can alter which agent runtimes exist, are selected, or respond. */
  private static readonly RUNTIME_SETTING_KEYS = [
    'apiProvider', 'agentRuntimeProvider',
    'claudeCodeCliPath', 'claudeCodeModel', 'claudeCodeExtraArgs', 'claudeCodeTimeoutMs',
    'codexCliPath', 'codexCliModel', 'codexCliExtraArgs', 'codexCliTimeoutMs',
    'hermesAgentCliPath', 'hermesAgentExtraArgs', 'hermesAgentTimeoutMs', 'hermesAgentHealthCheckArgs',
    'customAgentRuntimes', 'taskAgentsEnabled', 'preferredTaskAgentId',
  ] as const;
  private lastRuntimeSettingsSnapshot: string | undefined;
  /** Set once the entity store has been loaded; the setting can turn graph features on later. */
  private graphFeaturesInitialised = false;

  async saveSettings() {
    // Only a runtime-affecting change invalidates the availability cache and re-renders
    // open chats. Every text field in the settings tab saves per keystroke, and each save
    // used to re-probe every CLI (spawning `--version` for each) and rebuild the chat
    // view from scratch, wiping the draft message and attachments as it went.
    const snapshot = JSON.stringify(
      VaultAIPlugin.RUNTIME_SETTING_KEYS.map((k) => (this.settings as unknown as Record<string, unknown>)[k]),
    );
    const runtimeChanged = snapshot !== this.lastRuntimeSettingsSnapshot;
    this.lastRuntimeSettingsSnapshot = snapshot;
    if (runtimeChanged) invalidateChatRuntimeAvailabilityCache();
    // The Wayback choice is saved by whichever window changed it last. Every other save
    // takes it from disk, so this window's copy, loaded at start, does not put back a
    // choice another window has since changed.
    if (this.extensionAllowWaybackChanged) {
      this.extensionAllowWaybackChanged = false;
    } else {
      const saved = await this.readSavedExtensionAllowWayback();
      if (saved !== null) this.settings.extensionAllowWayback = saved;
    }
    // Settings are edited in place, so nothing else can notice a change; say so.
    publishOsintPluginState({ settings: this.settings });
    // Turning graph features on used to need a restart: the entity store was loaded only
    // in onload, so the toolbar buttons appeared at once but Entities opened empty.
    if (this.settings.enableGraphFeatures && !this.graphFeaturesInitialised) {
      this.graphFeaturesInitialised = true;
      try {
        await this.entityManager.initialize();
        this.startExtensionInbox();
      } catch (e) {
        this.graphFeaturesInitialised = false;
        console.warn('OSINTCopilot: Entity storage initialization had issues:', e);
      }
    }
    await this.saveData(this.settings);
    if (this.graphApiService) {
      this.graphApiService.setSettings({
        apiProvider: this.settings.apiProvider,
      });
      this.initLocalCliServices();
    }
    if (this.entityManager) {
      this.entityManager.setBasePath(OSINT_COPILOT_VAULT_ROOT);
    }

    if (this.vaultPromptLoader) {
      this.vaultPromptLoader.invalidateAll();
      this.attachVaultSkillFromVault();
    }

    this.taskAgentRegistry?.invalidate();
    this.skillRegistry?.invalidate();
    this.enricherRegistry?.invalidate();
    this.taskAgentRunner?.updateOptions({
      globalOutputAllowlist: this.settings.taskAgentGlobalOutputAllowlist,
      isPathLocked: (p: string) => this.vaultLockService.isPathLocked(p),
    });

    // Refresh the chat header controls -- only when something they show has changed.
    if (runtimeChanged) {
      this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach((leaf) => {
        if (leaf.view instanceof ChatView) {
          leaf.view.refresh().catch((e) => console.error('[VaultAIPlugin] chat refresh failed:', e));
        }
      });
    }
  }

  getActiveGraphId(): string {
    return this.settings.activeGraphId || 'default';
  }

  async setActiveGraphId(id: string): Promise<void> {
    if (!this.settings.graphWorkspaces.some((g) => g.id === id)) return;
    this.settings.activeGraphId = id;
    await this.saveSettings();
  }

  listGraphWorkspaces(): { id: string; name: string }[] {
    return [...this.settings.graphWorkspaces];
  }

  async addGraphWorkspace(name: string): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const id = `graph-${Date.now().toString(36)}`;
    this.settings.graphWorkspaces.push({ id, name: trimmed });
    this.settings.activeGraphId = id;
    await this.saveSettings();
    return id;
  }

  async deleteGraphWorkspace(id: string): Promise<void> {
    if (id === 'default') return;
    this.settings.graphWorkspaces = this.settings.graphWorkspaces.filter((g) => g.id !== id);
    if (this.settings.activeGraphId === id) {
      this.settings.activeGraphId = 'default';
    }
    await this.saveSettings();
  }

  // ============================================================================
  // GRAPH VIEW METHODS (workspace / OSINT panes)
  // ============================================================================

  private readonly osintWorkspace = new OsintWorkspaceController(this);

  async refreshOpenInsightViews(options?: { skipGraph?: boolean }): Promise<void> {
    return this.osintWorkspace.refreshOpenInsightViews(options);
  }

  async refreshOrOpenGraphView() {
    return this.osintWorkspace.refreshOrOpenGraphView();
  }

  async showEntityOnMap(entityId: string) {
    return this.osintWorkspace.showEntityOnMap(entityId);
  }


  /**
   * Rewrites `type` / `ftmSchema` frontmatter under the entity base path from legacy names to OIDSF canonical names.
   */
  async normalizeLegacyOidsfSchemaNamesInVault(): Promise<void> {
    const base = normalizePath(OSINT_COPILOT_VAULT_ROOT);
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(base + '/'));
    let updated = 0;
    for (const file of files) {
      let text = await this.app.vault.read(file);
      const m = /^(---\s*\n)([\s\S]*?)(\n---\s*\n)/.exec(text);
      if (!m) continue;
      let front = m[2];
      let changed = false;
      for (const [legacy, canon] of Object.entries(LEGACY_SCHEMA_NAME_ALIASES)) {
        const reType = new RegExp(`^type:\\s*["']?${legacy}["']?\\s*$`, 'm');
        const reFt = new RegExp(`^ftmSchema:\\s*["']?${legacy}["']?\\s*$`, 'm');
        if (reType.test(front)) {
          front = front.replace(reType, `type: ${canon}`);
          changed = true;
        }
        if (reFt.test(front)) {
          front = front.replace(reFt, `ftmSchema: ${canon}`);
          changed = true;
        }
      }
      if (changed) {
        const rest = text.slice(m[0].length);
        text = m[1] + front + m[3] + rest;
        await this.app.vault.modify(file, text);
        updated++;
      }
    }
    await this.entityManager.loadEntitiesFromNotes();
    if (this.schemaCatalogService) {
      await this.schemaCatalogService.rebuild();
    }
    new Notice(`OIDSF: normalized schema names in ${updated} note(s). Entities reloaded.`);
  }


  onEntityClick(entityId: string) {
    // Open the entity's note when clicked in graph/timeline/map
    void this.entityManager.openEntityNote(entityId);
  }

  // ============================================================================
  // INDEXING
  // ============================================================================

  async buildIndex() {
    this.index.clear();
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      await this.indexFile(file);
    }
  }

  async indexFile(file: TFile) {
    try {
      const content = await this.app.vault.read(file);
      // Parsed from the content just read: the tag-match branch of retrieveNotes scores
      // on these tags, links and frontmatter.
      const cache = parseMetadata(content);

      const tags = this.extractTags(cache);
      const links = this.extractLinks(cache);
      const frontmatter = cache?.frontmatter || undefined;

      this.index.set(file.path, {
        path: file.path,
        content,
        tags,
        links,
        frontmatter,
        updated: file.stat.mtime,
      });
    } catch (error) {
      console.error(`Failed to index file ${file.path}:`, error);
    }
  }

  extractTags(cache: CachedMetadata | null): string[] {
    if (!cache) return [];
    const tags: string[] = [];
    if (cache.tags) {
      cache.tags.forEach((tag) => tags.push(tag.tag));
    }
    if (cache.frontmatter?.tags) {
      const fmTags = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        tags.push(...fmTags.map((t) => (t.startsWith("#") ? t : `#${t}`)));
      } else if (typeof fmTags === "string") {
        tags.push(fmTags.startsWith("#") ? fmTags : `#${fmTags}`);
      }
    }
    return tags;
  }

  extractLinks(cache: CachedMetadata | null): string[] {
    if (!cache || !cache.links) return [];
    return cache.links.map((link) => link.link);
  }

  // ============================================================================
  // RETRIEVAL
  // ============================================================================

  retrieveNotes(query: string): IndexedNote[] {
    const queryLower = query.toLowerCase();
    const queryTokens = this.tokenizeEnglish(queryLower);
    const scored: Array<{ note: IndexedNote; score: number }> = [];

    for (const note of this.index.values()) {
      let score = 0;

      // Content match (2 points)
      const contentLower = note.content.toLowerCase();
      if (
        contentLower.includes(queryLower) ||
        this.fuzzyMatchText(contentLower, queryTokens)
      ) {
        score += 2;
      }

      // Tag match (1 point)
      if (
        note.tags.some((tag) => {
          const t = tag.toLowerCase();
          return t.includes(queryLower) || this.fuzzyMatchText(t, queryTokens);
        })
      ) {
        score += 1;
      }

      // Path match (1 point)
      const pathLower = note.path.toLowerCase();
      if (pathLower.includes(queryLower) || this.fuzzyMatchText(pathLower, queryTokens)) {
        score += 1;
      }

      if (score > 0) {
        scored.push({ note, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, this.settings.maxNotes).map((s) => s.note);
  }

  // English-only tokenization (letters/digits), min length 3
  tokenizeEnglish(text: string): string[] {
    return (text.match(/\b[a-z0-9]{3,}\b/gi) || []).map((t) => t.toLowerCase());
  }

  // Lightweight fuzzy: if any query token is within Levenshtein distance <= 1
  // of any token in the target text. We cap the number of target tokens scanned.
  fuzzyMatchText(textLower: string, queryTokens: string[]): boolean {
    if (queryTokens.length === 0) return false;
    // Only attempt for short queries (<= 3 tokens) to keep it fast
    if (queryTokens.length > 3) return false;

    const tokens = this.tokenizeEnglish(textLower);
    if (tokens.length === 0) return false;

    const MAX_TOKENS = 800; // cap to avoid scanning entire long notes
    const limited = tokens.slice(0, MAX_TOKENS);

    for (const q of queryTokens) {
      // Skip very short tokens to avoid noise
      if (q.length < 3) continue;
      for (const t of limited) {
        if (Math.abs(t.length - q.length) > 2) continue;
        if (this.levenshteinDistance(q, t) <= 1) {
          return true;
        }
      }
    }
    return false;
  }

  levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;

    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const temp = dp[j];
        if (a[i - 1] === b[j - 1]) {
          dp[j] = prev;
        } else {
          dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
        }
        prev = temp;
      }
    }
    return dp[n];
  }

  // ============================================================================
  // REMOTE MODEL INTEGRATION
  // ============================================================================

  async callRemoteModel(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    return this.graphApiService.callRemoteModel(messages, signal);
  }

  // ============================================================================
  // Q&A FUNCTIONALITY
  // ============================================================================

  async askVault(query: string): Promise<{ answer: string; notes: IndexedNote[] }> {

    const contextNotes = this.retrieveNotes(query);

    if (contextNotes.length === 0) {
      return {
        answer: "No relevant notes found for your query.",
        notes: [],
      };
    }

    // Build context
    let contextText = `User query: "${query}"\n\nHere are relevant notes:\n\n`;
    for (const note of contextNotes) {
      contextText += `--- Note: ${note.path} ---\n`;
      if (note.tags.length > 0) {
        contextText += `Tags: ${note.tags.join(", ")}\n`;
      }
      if (note.frontmatter) {
        contextText += `Frontmatter: ${JSON.stringify(note.frontmatter)}\n`;
      }
      // Limit content to 1500 chars
      const excerpt =
        note.content.length > 1500
          ? note.content.substring(0, 1500) + "..."
          : note.content;
      contextText += `Content:\n${excerpt}\n\n`;
    }

    const messages: ChatMessage[] = [
      { role: "system", content: this.settings.systemPrompt },
      { role: "user", content: contextText },
    ];

    const answer = await this.callRemoteModel(messages);

    return { answer, notes: contextNotes };
  }

  // ============================================================================
  // MODALS
  // ============================================================================

  openAskModal() {
    new AskModal(this.app, this).open();
  }


}
