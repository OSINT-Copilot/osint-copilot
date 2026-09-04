import {
  Notice,
  TFile,
  TFolder,
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  normalizePath,
} from "obsidian";
import { importMiroBoard, miroImportPrompt, parseMiroBoardId, MiroImportError } from "../services/miro-import-service";
import { DEFAULT_MIRO_BOARDS_FOLDER } from "../constants/vault-layout";
import { openVaultLink } from "../integration/open-view";
import { capConversationMemory } from "../services/agent-runtime/conversation-memory";

import {
  EntityType,
  type Entity,
  type ProcessTextResponse,
  validateEntityName,
  getEntityLabel,
  type GraphWriteContext,
} from '../entities/types';
import { isLikelyExpectedUrlFetchFailure } from '../services/api-service';
import type { ExtractionLogEvent } from '../services/claude-code-service';
import { ensureFolderExists } from '../utils/vault-bootstrap-fs';
import {
  type Conversation,
  type ConversationMetadata,
  type ConversationMessage,
  type CopilotChatMode,
  legacyFlagsForChatMode,
} from '../services/conversation-service';
import { ConfirmModal } from '../modals/confirm-modal';
import {
  ORCHESTRATION_TOOL_DISPLAY_NAMES,
  type OrchestrationProgressMeta,
} from '../services/orchestration-service';
import {
  getChatRuntimeAvailability,
  type ChatRuntimeAvailability,
} from '../services/agent-runtime/chat-runtime-availability';
import {
  CLAUDE_RUNTIME_ID,
  CODEX_RUNTIME_ID,
  getConfiguredRuntimeOptions,
} from '../services/agent-runtime/runtime-registry';
import type { CustomVaultOperation } from '../services/custom-vault-operations';
import { normalizeCustomVaultOperations, summarizeCustomVaultOperation } from '../services/custom-vault-operations';
import { applyCustomVaultOperations } from '../services/custom-vault-writer';
import { isTaskAgentRunnable } from '../task-agents/task-agent-settings';
import type { TaskAgentManifest } from '../task-agents/types';
import type { IndexedNote } from '../chat/indexed-note';
import type { ChatHistoryItem } from '../chat/chat-types';
import { RenameConversationModal } from '../modals/rename-conversation-modal';
import { appendVaultOpPreviewBlock } from '../ui/vault-op-previews';
import type VaultAIPlugin from '../plugin/vault-ai-plugin';

export const CHAT_VIEW_TYPE = "vault-ai-chat-view";


export class ChatView extends ItemView {
  plugin: VaultAIPlugin;
  chatHistory: ChatHistoryItem[] = [];
  inputEl!: HTMLTextAreaElement;
  miroButtonEl!: HTMLButtonElement;
  messagesContainer!: HTMLDivElement;
  sidebarContainer!: HTMLDivElement;
  conversationListEl!: HTMLDivElement;
  /** Tri-mode chat: general (orchestration), graph (entity extract only), local (vault Q&A). */
  chatMode: CopilotChatMode = 'general';
  // Legacy flags — kept in sync with `chatMode` via `legacyFlagsForChatMode` for YAML and older code paths
  localSearchMode: boolean = false;
  customChatMode: boolean = false;
  activeCheckpointId: string | undefined;
  orchestrationMode: boolean = true;
  vaultGraphIngestMode: boolean = false;
  /** Legacy: persisted on conversations; task agents are configured in settings only. */
  selectedTaskAgentId: string = "";
  graphGenerationMode: boolean = false;
  currentConversation: Conversation | null = null;
  sidebarVisible: boolean = true;
  uploadButtonEl!: HTMLElement;
  urlButtonEl!: HTMLElement; // URL extraction button
  /** Send button (used to disable when no agent CLI is available). */
  sendButtonEl!: HTMLButtonElement;
  dragOverlay!: HTMLElement;
  // Attached files display
  attachmentsContainer!: HTMLElement;
  // Stores attached files - content is extracted only when sending
  attachedFiles: { file: TFile | File; extracted: boolean; content?: string }[] = [];

  // Track active operations for cancellation
  activeAbortControllers: Map<number, AbortController> = new Map();

  private abortAllActiveOperations(): void {
    for (const controller of this.activeAbortControllers.values()) {
      controller.abort();
    }
    this.activeAbortControllers.clear();
  }

  private shouldDisplayDetailedExtractionLogs(): boolean {
    return this.plugin.settings.extractionLogVerbosity === 'detailed';
  }

  private formatExtractionLogLine(ev: ExtractionLogEvent): string {
    const t = new Date(ev.timestamp).toLocaleTimeString();
    const base = `[${t}] ${ev.level.toUpperCase()} ${ev.phase}: ${ev.message}`;
    if (!ev.details) return base;
    return `${base}\n${ev.details}`;
  }

  /**
   * Builds a log-event appender for the collapsible "Agent logs" panel rendered under a
   * chat message's progress bar. Shared by attachment extraction and unified-agent turns so
   * the verbosity filter and entry cap can't drift between the two.
   */
  private makeLogAppender(messageIndex: number): (ev: ExtractionLogEvent) => void {
    return (ev: ExtractionLogEvent) => {
      if (!this.activeAbortControllers.has(messageIndex)) return;
      const item = this.chatHistory[messageIndex];
      if (!item) return;
      const include = this.shouldDisplayDetailedExtractionLogs()
        ? true
        : (ev.phase === 'invoke_start' || ev.phase === 'invoke_exit' || ev.phase === 'invoke_error' || ev.phase === 'invoke_aborted');
      if (!include) return;
      if (!item.extractionLogs) item.extractionLogs = [];
      item.extractionLogs.push(ev);
      if (item.extractionLogs.length > 80) {
        item.extractionLogs = item.extractionLogs.slice(-80);
      }
      void this.renderMessages();
    };
  }

  /** Keep the full-message and incremental progress render paths identical. */
  private renderSingleProgress(
    progressContainer: HTMLElement,
    messageIndex: number,
    progress: { message: string; percent: number },
  ): void {
    progressContainer.empty();

    const progressBar = progressContainer.createDiv("vault-ai-progress-bar");
    progressBar.style.width = `${progress.percent}%`;

    const infoContainer = progressContainer.createDiv("vault-ai-progress-info");
    infoContainer.style.display = "flex";
    infoContainer.style.justifyContent = "space-between";
    infoContainer.style.alignItems = "center";
    infoContainer.style.marginTop = "4px";

    infoContainer.createEl("span", {
      cls: "vault-ai-progress-text",
      text: `${progress.message || "Processing..."} (${progress.percent}%)`,
    });

    if (!this.activeAbortControllers.has(messageIndex)) return;

    const cancelBtn = infoContainer.createEl("button", {
      text: "✕ Cancel", // eslint-disable-line obsidianmd/ui/sentence-case
      cls: "vault-ai-cancel-btn",
    });
    cancelBtn.style.fontSize = "11px";
    cancelBtn.style.padding = "2px 6px";
    cancelBtn.style.height = "auto";
    cancelBtn.style.marginLeft = "8px";
    cancelBtn.style.color = "var(--text-muted)";
    cancelBtn.style.background = "transparent";
    cancelBtn.style.border = "1px solid var(--background-modifier-border)";
    cancelBtn.style.borderRadius = "4px";
    cancelBtn.style.cursor = "pointer";

    cancelBtn.addEventListener("mouseenter", () => {
      cancelBtn.style.color = "var(--text-error)";
      cancelBtn.style.borderColor = "var(--text-error)";
    });
    cancelBtn.addEventListener("mouseleave", () => {
      cancelBtn.style.color = "var(--text-muted)";
      cancelBtn.style.borderColor = "var(--background-modifier-border)";
    });
    cancelBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void this.handleCancel(messageIndex);
    });
  }

  constructor(leaf: WorkspaceLeaf, plugin: VaultAIPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "OSINT Copilot";
  }

  getIcon(): string {
    return "message-square";
  }

  private applyChatMode(mode: CopilotChatMode) {
    this.chatMode = mode;
    const f = legacyFlagsForChatMode(mode);
    this.localSearchMode = f.localSearchMode;
    this.graphGenerationMode = f.graphGenerationMode;
    this.orchestrationMode = f.orchestrationMode;
    this.vaultGraphIngestMode = f.vaultGraphIngestMode;
    this.customChatMode = false;
    this.activeCheckpointId = undefined;
  }

  private syncModesFromConversation(_conv: ConversationMetadata) {
    this.applyChatMode("general");
  }

  private runtimeDisplayName(runtimeId: string): string {
    const opt = getConfiguredRuntimeOptions(this.plugin).find((r) => r.id === runtimeId);
    return opt?.displayName || "Claude Code";
  }

  /** Keep a removed runtime id valid, but never fail over a valid user selection. */
  private async syncRuntimeSelectionToAvailability(_av: ChatRuntimeAvailability): Promise<void> {
    const configured = getConfiguredRuntimeOptions(this.plugin).map((r) => r.id);
    const cur = this.plugin.settings.agentRuntimeProvider;
    if (!configured.includes(cur)) {
      this.plugin.settings.agentRuntimeProvider = CLAUDE_RUNTIME_ID;
      await this.plugin.saveSettings();
      return;
    }
  }

  /** Applied once the runtime probe settles; see the note in render(). */
  private applyRuntimeAvailabilityToSendButton(av: ChatRuntimeAvailability): void {
    if (!this.sendButtonEl) return;
    const none = av.availableIds.length === 0;
    this.noRuntimeAvailable = none;
    this.syncSendControls();
    this.sendButtonEl.title = none
      ? "Install and configure Claude, Codex, Hermes, or a custom runtime in Settings → OSINT Copilot."
      : "";
  }

  private buildRuntimeHeaderRow(buttonGroup: HTMLElement, av: ChatRuntimeAvailability): void {
    const wrap = buttonGroup.createDiv({ cls: "vault-ai-runtime-header" });
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.gap = "8px";
    wrap.style.flexWrap = "wrap";

    const configured = getConfiguredRuntimeOptions(this.plugin);
    if (av.availableIds.length === 0) {
      wrap.createEl("span", {
        text: "No agent CLI detected. Configure Claude, Codex, Hermes, or a custom runtime under Settings → OSINT Copilot.",
        cls: "setting-item-description",
      });
    }
    // A bare label + select, not a Setting row: Setting is a full-width settings-list
    // row with vertical padding and a border-top, which drew a stray rule across the
    // header and squeezed the title in a narrow pane.
    const select = this.headerField(wrap, "Runtime");
    for (const rt of configured) {
      select.createEl("option", { value: rt.id, text: av.byId[rt.id] ? rt.displayName : `${rt.displayName} (unavailable)` });
    }
    select.value = this.plugin.settings.agentRuntimeProvider;
    select.addEventListener("change", async () => {
      const v = select.value;
      if (this.plugin.settings.agentRuntimeProvider === v) return;
      this.plugin.settings.agentRuntimeProvider = v;
      if (v === CLAUDE_RUNTIME_ID || v === CODEX_RUNTIME_ID) {
        this.plugin.settings.apiProvider = v;
      }
      await this.plugin.saveSettings();
    });
  }

  private headerField(parent: HTMLElement, label: string): HTMLSelectElement {
    const field = parent.createEl("label", { cls: "vault-ai-header-field" });
    field.createSpan({ text: label });
    return field.createEl("select", { cls: "dropdown" });
  }

  /** Select a vault task agent, or leave the unified agent as the conversation workflow. */
  private async buildTaskAgentHeaderRow(buttonGroup: HTMLElement): Promise<void> {
    if (!this.plugin.settings.taskAgentsEnabled) {
      this.selectedTaskAgentId = "";
      return;
    }
    let agents: TaskAgentManifest[];
    try {
      agents = (await this.plugin.taskAgentRegistry.listAgents())
        .filter((agent) => isTaskAgentRunnable(agent, this.plugin.settings));
    } catch (error) {
      console.warn('[ChatView] Could not list task agents:', error);
      return;
    }
    if (!agents.some((agent) => agent.id === this.selectedTaskAgentId)) {
      this.selectedTaskAgentId = "";
    }
    if (agents.length === 0) return;

    const wrap = buttonGroup.createDiv({ cls: "vault-ai-task-agent-header" });
    const select = this.headerField(wrap, "Workflow");
    select.createEl("option", { value: "", text: "Unified agent" });
    for (const agent of agents) select.createEl("option", { value: agent.id, text: agent.name });
    select.value = this.selectedTaskAgentId;
    select.addEventListener("change", async () => {
      const value = select.value;
      this.selectedTaskAgentId = value;
      this.plugin.settings.preferredTaskAgentId = value;
      if (this.currentConversation) {
        this.currentConversation.taskAgentId = value || undefined;
        await this.plugin.conversationService.saveConversation(this.currentConversation);
      }
      await this.plugin.saveSettings();
    });
  }

  async onOpen() {
    await this.loadMostRecentConversation();
    await this.render();
  }

  async loadMostRecentConversation() {
    const conversation = await this.plugin.conversationService.getMostRecentConversation();
    if (conversation) {
      this.currentConversation = conversation;
      this.chatHistory = this.conversationMessagesToHistory(conversation.messages);
      this.syncModesFromConversation(conversation);
      this.selectedTaskAgentId =
        conversation.taskAgentId ?? this.plugin.settings.preferredTaskAgentId ?? "";
    } else {
      this.applyChatMode('general');
      this.selectedTaskAgentId = this.plugin.settings.preferredTaskAgentId ?? "";
    }
  }

  conversationMessagesToHistory(messages: ConversationMessage[]): ChatHistoryItem[] {
    return messages.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      notes: m.notes as IndexedNote[],
      jobId: m.jobId,
      status: m.status,
      progress: m.progress as { message: string, percent: number } | undefined,
      reportFilePath: m.reportFilePath,
      usedEntities: m.usedEntities,
      proposedModifications: m.proposedModifications,
      proposedCustomVaultOps:
        Array.isArray(m.proposedCustomVaultOps) && m.proposedCustomVaultOps.length > 0
          ? normalizeCustomVaultOperations(m.proposedCustomVaultOps)
          : undefined,
      savedQuery: m.savedQuery,
    }));
  }

  historyToConversationMessages(): ConversationMessage[] {
    return this.chatHistory.map(h => {
      // Assign a timestamp once, on first save, then keep it — otherwise every
      // re-save (e.g. after each new turn) would stamp the whole history with
      // the current time, collapsing all messages onto one identical value.
      if (h.timestamp === undefined) h.timestamp = Date.now();
      return {
        role: h.role,
        content: h.content,
        timestamp: h.timestamp,
        notes: h.notes,
        jobId: h.jobId,
        status: h.status,
        progress: h.progress,
        reportFilePath: h.reportFilePath,
        usedEntities: h.usedEntities,
        proposedModifications: h.proposedModifications,
        proposedCustomVaultOps: h.proposedCustomVaultOps as unknown as Record<string, unknown>[] | undefined,
        // Without this, Apply after a reload fell back to a placeholder provenance query.
        savedQuery: h.savedQuery,
      };
    });
  }

  async saveCurrentConversation() {
    this.applyChatMode("general");
    if (!this.currentConversation) {
      this.currentConversation = await this.plugin.conversationService.createConversation(
        this.chatHistory.length > 0 ? this.chatHistory[0].content : undefined,
        this.chatMode,
        this.selectedTaskAgentId,
      );
    }
    this.currentConversation.messages = this.historyToConversationMessages();
    this.currentConversation.chatMode = "general";
    this.currentConversation.taskAgentId = this.selectedTaskAgentId.trim() || undefined;
    const f = legacyFlagsForChatMode(this.chatMode);
    this.currentConversation.localSearchMode = f.localSearchMode;
    this.currentConversation.graphGenerationMode = f.graphGenerationMode;
    this.currentConversation.orchestrationMode = f.orchestrationMode;
    this.currentConversation.vaultGraphIngestMode = f.vaultGraphIngestMode;
    await this.plugin.conversationService.saveConversation(this.currentConversation);
    this.renderConversationList();
  }

  /**
   * Re-renders while keeping what the user was in the middle of: the draft, the
   * attachment chips and the scroll position. render() rebuilds the textarea and resets
   * attachedFiles, so a settings save -- the header dropdowns cause one -- used to
   * silently discard a half-written prompt and three attached PDFs.
   */
  async refresh() {
    const draft = this.inputEl?.value ?? "";
    const files = this.attachedFiles;
    const scrollTop = this.messagesContainer?.scrollTop;
    await this.render();
    if (draft) this.inputEl.value = draft;
    if (files.length > 0) {
      this.attachedFiles = files;
      this.renderAttachments();
    }
    if (scrollTop !== undefined && this.messagesContainer) this.messagesContainer.scrollTop = scrollTop;
  }

  /**
   * Links in answers. Wikilinks are rendered as <a class="internal-link" data-href> by the
   * markdown shim, which leaves resolution to the shell -- and no shell handler existed, so
   * every [[note]] in an answer was dead. Web links are auto-linked by markdown-it and a
   * plain click on one is a top-level navigation; window.open goes through main's
   * window-open handler, which denies it and opens the browser instead.
   */
  private handleTranscriptClick(e: MouseEvent): void {
    const anchor = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
    if (!anchor || !this.messagesContainer.contains(anchor)) return;
    const internal = anchor.getAttribute("data-href");
    if (anchor.classList.contains("internal-link") && internal) {
      e.preventDefault();
      if (!openVaultLink(internal)) new Notice(`No note found for "${internal.split('#')[0].split('|')[0].trim()}".`);
      return;
    }
    const href = anchor.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      window.open(href);
    }
  }

  async render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("vault-ai-chat-view");
    container.addClass("vault-ai-chat-with-sidebar");

    // Main layout: sidebar + chat area
    const mainLayout = container.createDiv("vault-ai-chat-layout");

    // Sidebar
    this.sidebarContainer = mainLayout.createDiv("vault-ai-chat-sidebar");
    if (!this.sidebarVisible) this.sidebarContainer.addClass("hidden");
    this.renderSidebar();

    // Chat area
    const chatArea = mainLayout.createDiv("vault-ai-chat-area");

    // Header
    const header = chatArea.createDiv("vault-ai-chat-header");

    // Toggle sidebar button
    const toggleSidebarBtn = header.createEl("button", { cls: "vault-ai-sidebar-toggle" });
    toggleSidebarBtn.setText("☰");
    toggleSidebarBtn.title = "Toggle conversation history";
    toggleSidebarBtn.addEventListener("click", () => {
      this.sidebarVisible = !this.sidebarVisible;
      if (this.sidebarVisible) {
        this.sidebarContainer.removeClass("hidden");
      } else {
        this.sidebarContainer.addClass("hidden");
      }
    });

    header.createEl("h3", { text: "OSINT Copilot" });

    const buttonGroup = header.createDiv("vault-ai-chat-header-buttons");

    // New Chat button
    const newChatBtn = buttonGroup.createEl("button", { text: "New chat", cls: "vault-ai-new-chat-btn" });
    newChatBtn.addEventListener("click", () => {
      void this.startNewConversation();
    });

    // Detecting which agent runtimes are available means spawning a health check for
    // each of Claude, Codex, Hermes and any custom runtime. That took ~8 seconds here,
    // and awaiting it before building the rest of the view left the chat with a header
    // and nothing else for that whole time -- no message list, no input box. It now runs
    // alongside, and fills in its row and the Send button when it lands.
    const runtimeRow = buttonGroup.createDiv({ cls: "vault-ai-runtime-header-slot" });
    runtimeRow.createEl("span", {
      text: "Checking agent runtimes…",
      cls: "setting-item-description",
    });
    const runtimeReady = (async () => {
      const availability = await getChatRuntimeAvailability(this.plugin);
      await this.syncRuntimeSelectionToAvailability(availability);
      runtimeRow.empty();
      this.buildRuntimeHeaderRow(runtimeRow, availability);
      this.applyRuntimeAvailabilityToSendButton(availability);
      return availability;
    })();
    runtimeReady.catch((e) => {
      runtimeRow.empty();
      runtimeRow.createEl("span", {
        text: "Could not detect agent runtimes. See Settings → OSINT Copilot.",
        cls: "setting-item-description",
      });
      console.error("[OSINT Copilot] runtime availability probe failed:", e);
    });
    await this.buildTaskAgentHeaderRow(buttonGroup);

    // Settings shortcut button
    const settingsBtn = buttonGroup.createEl("button", {
      text: "⚙️",
      cls: "vault-ai-settings-btn",
      attr: { "aria-label": "Open settings" }
    });
    settingsBtn.addEventListener("click", () => {
      // @ts-ignore
      this.app.setting.open();
      // @ts-ignore
      this.app.setting.openTabById(this.plugin.manifest.id);
    });

    // Messages container
    this.messagesContainer = chatArea.createDiv("vault-ai-chat-messages");
    this.messagesContainer.addEventListener("click", (e) => this.handleTranscriptClick(e));
    await this.renderMessages();

    // Input area
    const inputContainer = chatArea.createDiv("vault-ai-chat-input");

    // Mode disclaimer (shows what the current mode will do)
    const modeDisclaimer = this.getModeDisclaimer();
    if (modeDisclaimer) {
      const disclaimerEl = inputContainer.createDiv("vault-ai-mode-disclaimer");
      disclaimerEl.createSpan({ text: modeDisclaimer.icon + " " });
      disclaimerEl.createEl("strong", { text: modeDisclaimer.title + " " });
      disclaimerEl.createSpan({ text: modeDisclaimer.text });
    }

    this.inputEl = inputContainer.createEl("textarea", {
      placeholder: this.getInputPlaceholder(),
    });
    this.inputEl.rows = 3;

    // File upload for Graph Generation mode
    const fileInput = inputContainer.createEl("input", {
      type: "file",
      cls: "vault-ai-file-upload",
      attr: {
        "accept": ChatView.acceptAttribute(),
        "style": "display: none;"
      }
    });
    fileInput.addEventListener("change", (e) => void this.handleFileUpload(e));

    // Attachments container - shows attached files below input
    this.attachmentsContainer = inputContainer.createDiv("vault-ai-attachments");
    this.attachedFiles = []; // Reset on render

    // Action Row for Buttons (Upload, URL, Send)
    const actionRow = inputContainer.createDiv("vault-ai-action-row");

    // Upload Button
    this.uploadButtonEl = actionRow.createEl("button", {
      text: "📎",
      cls: "vault-ai-upload-btn",
      attr: {
        "aria-label": "Upload file for graph generation",
        "title": "Upload file for graph generation (.md, .txt, .pdf, .docx)" // eslint-disable-line obsidianmd/ui/sentence-case
      }
    });
    // Only show in Graph Generation mode (or Graph Only mode)
    this.updateUploadButtonVisibility();
    this.uploadButtonEl.addEventListener("click", () => fileInput.click());

    // URL Button
    this.urlButtonEl = actionRow.createEl("button", {
      text: "🔗",
      cls: "vault-ai-url-btn",
      attr: {
        "aria-label": "Extract from URL",
        "title": "Extract content from web URL for graph generation"
      }
    });
    this.urlButtonEl.addEventListener("click", () => this.showUrlInputModal());
    this.updateUrlButtonVisibility();

    // Miro import: the importer already existed, reachable only from Settings. A board is
    // context for the conversation, so it belongs beside the other ways of bringing content
    // in -- file upload and URL extraction.
    this.miroButtonEl = actionRow.createEl("button", {
      text: "📋",
      cls: "vault-ai-miro-btn",
      attr: {
        "aria-label": "Import from Miro",
        "title": "Import a Miro board into the vault and reference it in the chat (needs a Miro API token)"
      }
    });
    this.miroButtonEl.addEventListener("click", () => this.showMiroImportModal());

    // Spacer to push Send button to the right
    const spacer = actionRow.createDiv("vault-ai-action-spacer");
    spacer.style.flexGrow = "1";

    // Send Button
    const sendBtn = actionRow.createEl("button", {
      text: "Send",
      cls: "vault-ai-send-btn"
    });
    this.sendButtonEl = sendBtn;
    // Enabled optimistically: the probe above settles a moment later and disables Send
    // only if nothing is actually available. Starting disabled would make the button
    // look broken for the first few seconds.
    sendBtn.disabled = false;
    sendBtn.title = "";
    sendBtn.addEventListener("click", () => void this.handleSend());

    // Drag and Drop Overlay
    this.dragOverlay = inputContainer.createDiv("vault-ai-drag-overlay");
    this.dragOverlay.createDiv({ text: "Drop file to extract text", cls: "vault-ai-drag-text" });

    inputContainer.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      if (!this.dragOverlay.hasClass("active")) {
        this.dragOverlay.addClass("active");
      }
    });

    inputContainer.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!inputContainer.contains(e.relatedTarget as Node)) {
        this.dragOverlay.removeClass("active");
      }
    });

    inputContainer.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      if (!this.dragOverlay.hasClass("active")) {
        this.dragOverlay.addClass("active");
      }
    });

    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragOverlay.removeClass("active");

      let handled = false;

      // 1) Internal Obsidian drag manager (check first — takes priority over dataTransfer)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dragManager = (this.app as any).dragManager;
      if (dragManager?.draggable) {
        const draggable = dragManager.draggable;

        // Single item: .file can be TFile or TFolder regardless of .type string
        if (draggable.file instanceof TFolder) {
          await this.handleDroppedFolder(draggable.file);
          handled = true;
        } else if (draggable.file instanceof TFile) {
          await this.handleDroppedAbstractFile(draggable.file);
          handled = true;
        }

        // Multi-select: .files array
        if (!handled && Array.isArray(draggable.files) && draggable.files.length > 0) {
          for (const f of draggable.files) {
            if (f instanceof TFolder) await this.handleDroppedFolder(f);
            else if (f instanceof TFile) await this.handleDroppedAbstractFile(f);
          }
          handled = true;
        }

        // Some Obsidian versions put folder info under .info
        if (!handled && draggable.info) {
          const info = draggable.info;
          if (typeof info === 'string') {
            const resolved = this.app.vault.getAbstractFileByPath(info);
            if (resolved instanceof TFolder) {
              await this.handleDroppedFolder(resolved);
              handled = true;
            } else if (resolved instanceof TFile) {
              await this.handleDroppedAbstractFile(resolved);
              handled = true;
            }
          }
        }
      }

      // 2) text/plain data (Obsidian often puts the vault path here)
      if (!handled && e.dataTransfer) {
        const data = e.dataTransfer.getData("text/plain");
        if (data) {
          const abstractFile = this.app.vault.getAbstractFileByPath(data);
          if (abstractFile instanceof TFolder) {
            await this.handleDroppedFolder(abstractFile);
            handled = true;
          } else if (abstractFile instanceof TFile) {
            await this.handleDroppedAbstractFile(abstractFile);
            handled = true;
          }
        }
      }

      // 3) External OS files (only if nothing internal matched)
      if (!handled && e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          this.handleDroppedFile(e.dataTransfer.files[i]);
        }
        handled = true;
      }

      if (!handled) new Notice("Nothing usable was dropped. Drop files, or notes from the file tree.");
    };
    inputContainer.addEventListener("drop", (e) => void onDrop(e));

    // The transcript is by far the largest drop target on screen. Without these, a file
    // dropped there was a navigation to its file:// URL, replacing the whole app.
    for (const type of ["dragenter", "dragover"] as const) {
      chatArea.addEventListener(type, (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        this.dragOverlay.addClass("active");
      });
    }
    chatArea.addEventListener("dragleave", (e) => {
      if (!chatArea.contains(e.relatedTarget as Node | null)) this.dragOverlay.removeClass("active");
    });
    chatArea.addEventListener("drop", (e) => {
      if (inputContainer.contains(e.target as Node | null)) return; // its own listener handles it
      void onDrop(e);
    });

    // Handle Enter key (Shift+Enter for new line)
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // The same gate as the button: with no runtime the button is greyed out, but
        // Enter still ran a full probe before saying so.
        if (this.sendButtonEl?.disabled) return;
        void this.handleSend();
      }
    });


    // Hosted OSINT options panel removed
  }

  /**
   * Get the mode disclaimer text based on current mode settings.
   * Returns HTML string or null if no disclaimer needed.
   */
  /**
   * Get the mode disclaimer text based on current mode settings.
   * Returns object with content parts or null if no disclaimer needed.
   */
  private getModeDisclaimer(): { icon: string; title: string; text: string } | null {
    if (this.selectedTaskAgentId.trim()) {
      return {
        icon: "🤖",
        title: "Task agent:",
        text: `The selected vault task agent runs through ${this.runtimeDisplayName(this.plugin.settings.apiProvider)} and may automatically create or update files, limited by both configured output allowlists.`,
      };
    }
    const p = this.runtimeDisplayName(this.plugin.settings.agentRuntimeProvider);
    return {
      icon: "🤖",
      title: "Unified agent:",
      text: `One local ${p} turn per message. Search vs graph work follows your message and attachments; vault prompts under ${this.plugin.settings.promptsFolder} still augment the agent.`,
    };
  }

  updateUploadButtonVisibility() {
    if (this.uploadButtonEl) {
      this.uploadButtonEl.style.display = "block";
    }
  }

  updateUrlButtonVisibility() {
    if (this.urlButtonEl) {
      this.urlButtonEl.style.display = "block";
    }
  }

  /**
   * Show modal for URL input to extract content from webpage.
   * Extracted content is sent directly to graph generation.
   */
  /**
   * Import a Miro board and hand the chat a link to it.
   *
   * Modelled on showUrlInputModal. The token lives in settings (miroAccessToken); if none
   * is set the modal asks for it and saves it, so the first import does not detour through
   * Settings. The board input is remembered the way the settings tab remembers it.
   */
  showMiroImportModal() {
    const overlay = document.createElement("div");
    overlay.className = "vault-ai-modal-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.6); display: flex; align-items: center;
      justify-content: center; z-index: 9999;
    `;

    const modal = document.createElement("div");
    modal.className = "vault-ai-url-modal vault-ai-miro-modal";
    modal.style.cssText = `
      background: var(--background-primary); border-radius: 8px; padding: 20px;
      min-width: 420px; max-width: 600px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    `;

    const hasToken = Boolean(this.plugin.settings.miroAccessToken?.trim());
    const fieldStyle = "width: 100%; padding: 10px; border: 1px solid var(--background-modifier-border); border-radius: 4px; background: var(--background-secondary); color: var(--text-normal); margin-bottom: 12px; box-sizing: border-box;";

    // Static template only: every user-supplied value is set through .value below, never
    // interpolated into markup.
    modal.innerHTML = `
      <h3 style="margin-top: 0; margin-bottom: 12px;">📋 Import from Miro</h3>
      <p style="color: var(--text-muted); margin-bottom: 14px; font-size: 0.9em;">
        Fetches the board's items and connectors into a note under ${DEFAULT_MIRO_BOARDS_FOLDER},
        then puts a link to it in the chat so the agent can read it. Re-importing a board overwrites its note.
      </p>
      <label style="display: block; font-size: 0.85em; color: var(--text-muted); margin-bottom: 4px;">Board URL or ID</label>
      <input type="text" id="miro-board" placeholder="https://miro.com/app/board/uXjV.../" style="${fieldStyle}" />
      <div id="miro-token-row">
        <label style="display: block; font-size: 0.85em; color: var(--text-muted); margin-bottom: 4px;">Miro access token</label>
        <input type="password" id="miro-token" placeholder="Personal access token from your Miro account" autocomplete="off" style="${fieldStyle}" />
        <p style="color: var(--text-muted); margin: -6px 0 12px; font-size: 0.8em;">Saved to this plugin's settings, in plain text. You can change or clear it under Settings → OSINT Copilot → Miro import.</p>
      </div>
      <div id="miro-token-set" style="display: none; color: var(--text-muted); font-size: 0.85em; margin-bottom: 12px;">
        Token: set · <a href="#" id="miro-token-change">change</a>
      </div>
      <div id="miro-status" style="color: var(--text-muted); margin-bottom: 14px; min-height: 20px;"></div>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button id="miro-cancel" style="padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; background: var(--background-modifier-border);">Cancel</button>
        <button id="miro-import" style="padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; background: var(--interactive-accent); color: white;">Import</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const boardInput = modal.querySelector("#miro-board") as HTMLInputElement;
    const tokenRow = modal.querySelector("#miro-token-row") as HTMLElement;
    const tokenInput = modal.querySelector("#miro-token") as HTMLInputElement;
    const tokenSet = modal.querySelector("#miro-token-set") as HTMLElement;
    const tokenChange = modal.querySelector("#miro-token-change") as HTMLAnchorElement;
    const statusEl = modal.querySelector("#miro-status") as HTMLElement;
    const cancelBtn = modal.querySelector("#miro-cancel") as HTMLButtonElement;
    const importBtn = modal.querySelector("#miro-import") as HTMLButtonElement;

    boardInput.value = this.plugin.settings.miroLastBoardInput ?? "";
    if (hasToken) {
      tokenRow.style.display = "none";
      tokenSet.style.display = "block";
    }
    tokenChange.addEventListener("click", (e) => {
      e.preventDefault();
      tokenSet.style.display = "none";
      tokenRow.style.display = "block";
      tokenInput.focus();
    });

    // The Escape listener is removed on EVERY close path, so a cancelled dialog does not
    // leave a keydown handler on the document for the rest of the session.
    //
    // preventDefault matters: Tangent's window-level Escape handler (WorkspaceView
    // onWindowKeydown) skips events that are already handled, and otherwise treats a bare
    // Escape as "toggle Thread/Map focus" -- so dismissing this dialog would also yank
    // the user out of their thread and unmount the chat panel underneath it.
    const escHandler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeModal();
    };
    const closeModal = () => {
      document.removeEventListener("keydown", escHandler);
      overlay.remove();
    };
    document.addEventListener("keydown", escHandler);
    cancelBtn.addEventListener("click", closeModal);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
    (hasToken ? boardInput : tokenInput).focus();

    const fail = (message: string) => {
      statusEl.textContent = `❌ ${message}`;
      statusEl.style.color = "var(--text-error)";
    };

    importBtn.addEventListener("click", async () => {
      const board = boardInput.value.trim();
      // A freshly typed token wins; otherwise the stored one.
      const typed = tokenRow.style.display !== "none" ? tokenInput.value.trim() : "";
      const token = typed || this.plugin.settings.miroAccessToken?.trim() || "";

      if (!board) { fail("Paste a Miro board URL or ID."); return; }
      if (!parseMiroBoardId(board)) { fail("That does not look like a Miro board URL or ID."); return; }
      if (!token) { fail("A Miro access token is required."); return; }

      importBtn.disabled = true;
      cancelBtn.disabled = true;
      importBtn.textContent = "Importing...";
      statusEl.textContent = "📋 Fetching the board from Miro...";
      statusEl.style.color = "var(--text-muted)";

      try {
        const outcome = await importMiroBoard(this.plugin.app, board, token, DEFAULT_MIRO_BOARDS_FOLDER);

        // Remember what worked, the same way the settings tab does; the token only once it
        // has actually been accepted by Miro, so a typo is not persisted.
        this.plugin.settings.miroLastBoardInput = board;
        if (typed) this.plugin.settings.miroAccessToken = typed;
        await this.plugin.saveSettings();

        // Appended, never over a draft the user was in the middle of typing.
        const draft = this.inputEl.value.trim();
        this.inputEl.value = draft ? `${draft}\n\n${miroImportPrompt(outcome)}` : miroImportPrompt(outcome);
        this.updateInputPlaceholder();
        new Notice(
          `Imported "${outcome.snapshot.board.name || outcome.snapshot.board.id}" `
          + `(${outcome.snapshot.items.length} items, ${outcome.snapshot.connectors.length} connectors) `
          + `to ${outcome.path}${outcome.overwritten ? " (overwritten)" : ""}.`,
          8000,
        );
        closeModal();
        this.inputEl.focus();
      } catch (error) {
        const msg = error instanceof MiroImportError ? error.message
          : error instanceof Error ? error.message : String(error);
        fail(msg);
        importBtn.disabled = false;
        cancelBtn.disabled = false;
        importBtn.textContent = "Import";
      }
    });
  }

  showUrlInputModal() {
    // Create modal overlay
    const overlay = document.createElement("div");
    overlay.className = "vault-ai-modal-overlay";
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    `;

    // Create modal
    const modal = document.createElement("div");
    modal.className = "vault-ai-url-modal";
    modal.style.cssText = `
      background: var(--background-primary);
      border-radius: 8px;
      padding: 20px;
      min-width: 400px;
      max-width: 600px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    `;

    modal.innerHTML = `
      <h3 style="margin-top: 0; margin-bottom: 15px;">🔗 Extract from URL</h3>
      <p style="color: var(--text-muted); margin-bottom: 15px; font-size: 0.9em;">
        Paste a URL to extract article content and generate entities.
      </p>
      <input type="url" id="url-input" placeholder="https://medium.com/@author/article..." 
        style="width: 100%; padding: 10px; border: 1px solid var(--background-modifier-border); border-radius: 4px; background: var(--background-secondary); color: var(--text-normal); margin-bottom: 15px;" />
      <div id="url-status" style="color: var(--text-muted); margin-bottom: 15px; min-height: 20px;"></div>
      <div style="display: flex; gap: 10px; justify-content: flex-end;">
        <button id="url-cancel" style="padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; background: var(--background-modifier-border);">Cancel</button>
        <button id="url-extract" style="padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; background: var(--interactive-accent); color: white;">Extract & Generate</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const urlInput = modal.querySelector("#url-input") as HTMLInputElement;
    const statusEl = modal.querySelector("#url-status") as HTMLElement;
    const cancelBtn = modal.querySelector("#url-cancel") as HTMLButtonElement;
    const extractBtn = modal.querySelector("#url-extract") as HTMLButtonElement;

    // Focus input
    urlInput.focus();

    // Removed on EVERY close path. Only the Escape branch removed it, so each cancelled
    // dialog left a permanent document listener whose stopPropagation then swallowed
    // Escape for the whole app.
    const closeModal = () => {
      document.removeEventListener("keydown", escHandler);
      overlay.remove();
    };

    // Cancel button
    cancelBtn.addEventListener("click", closeModal);

    // Click outside to close
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });

    // Escape key to close. Marked handled so Tangent's window-level Escape does not also
    // toggle Thread/Map focus underneath the dialog (see the Miro modal for the detail).
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeModal();
      }
    };
    document.addEventListener("keydown", escHandler);

    // Extract button
    extractBtn.addEventListener("click", async () => {
      const url = urlInput.value.trim();

      if (!url) {
        statusEl.textContent = "❌ Please enter a URL"; // eslint-disable-line obsidianmd/ui/sentence-case
        statusEl.style.color = "var(--text-error)";
        return;
      }

      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        statusEl.textContent = "❌ URL must start with http:// or https://"; // eslint-disable-line obsidianmd/ui/sentence-case
        statusEl.style.color = "var(--text-error)";
        return;
      }

      // Disable buttons and show loading
      extractBtn.disabled = true;
      cancelBtn.disabled = true;
      extractBtn.textContent = "Extracting...";
      statusEl.textContent = "🔗 Fetching content from URL..."; // eslint-disable-line obsidianmd/ui/sentence-case
      statusEl.style.color = "var(--text-muted)";

      try {
        // Extract text from URL
        const extractedText = await this.plugin.graphApiService.extractTextFromUrl(url);

        if (!extractedText || extractedText.trim().length === 0) {
          throw new Error("No content could be extracted from this URL");
        }

        // Close modal
        closeModal();

        // Show user message in chat with the full URL
        const displayUrl = url;
        this.chatHistory.push({ role: "user", content: `🔗 ${displayUrl}` });
        await this.renderMessages();

        // Send extracted content directly to graph generation
        new Notice(`Extracted content from URL. Processing entities...`);
        await this.handleGraphOnlyMode(extractedText);

        // Save conversation
        await this.saveCurrentConversation();

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (isLikelyExpectedUrlFetchFailure(errorMsg)) {
          console.debug("URL extraction skipped:", errorMsg.slice(0, 120));
          statusEl.textContent =
            "Could not open this link (login or site protection). Copy the page text into the chat instead."; // eslint-disable-line obsidianmd/ui/sentence-case
          statusEl.style.color = "var(--text-muted)";
        } else {
          console.error("URL extraction error:", error);
          if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
            statusEl.textContent = "❌ Request timed out. Try a simpler page."; // eslint-disable-line obsidianmd/ui/sentence-case
          } else if (errorMsg.includes("429")) {
            statusEl.textContent = "❌ Server busy. Please wait and try again."; // eslint-disable-line obsidianmd/ui/sentence-case
          } else {
            statusEl.textContent = `❌ ${errorMsg}`;
          }
          statusEl.style.color = "var(--text-error)";
        }

        // Re-enable buttons
        extractBtn.disabled = false;
        cancelBtn.disabled = false;
        extractBtn.textContent = "Extract & generate";
      }
    });

    // Enter key to submit
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        extractBtn.click();
      }
    });
  }


  async handleFileUpload(event: Event) {
    const target = event.target as HTMLInputElement;
    if (!target.files || target.files.length === 0) return;

    const file = target.files[0];
    target.value = '';

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ChatView.ALLOWED_EXTENSIONS.has(ext)) {
      new Notice(`File type .${ext} not supported. Use images or documents.`);
      return;
    }

    this.attachedFiles.push({ file, extracted: false });
    this.renderAttachments();
    new Notice(`Attached: ${file.name}`);
  }

  private static readonly IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico']);
  /** Read as text straight from the vault. */
  private static readonly TEXT_EXTENSIONS = new Set(['md', 'txt', 'csv', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml', 'toml', 'ini']);
  private static readonly DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'doc']);
  /**
   * One list, derived. The picker's accept attribute, the drop filter and the extractor
   * each kept their own, and they disagreed: a CSV -- the file the size warning was
   * written for -- was refused at attach time with "Use images or documents".
   */
  private static readonly ALLOWED_EXTENSIONS = new Set([
    ...ChatView.IMAGE_EXTENSIONS, ...ChatView.TEXT_EXTENSIONS, ...ChatView.DOCUMENT_EXTENSIONS,
  ]);
  static acceptAttribute(): string {
    return [...ChatView.ALLOWED_EXTENSIONS].map((ext) => `.${ext}`).join(',');
  }

  static isImageFile(name: string): boolean {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ChatView.IMAGE_EXTENSIONS.has(ext);
  }

  /** Rough English-text heuristic; good enough to size a "this will take a while" warning, not exact billing. */
  private static readonly CHARS_PER_TOKEN_ESTIMATE = 4;
  private static readonly LARGE_ATTACHMENT_WARNING_CHARS = 150_000;

  /**
   * Null below the size threshold; otherwise the warning text to show. Pulled out from
   * warnIfAttachmentContextIsLarge as a pure function so the threshold/message logic is testable
   * without needing to spy on the Notice constructor.
   */
  static largeAttachmentWarningMessage(attachmentsContextLength: number): string | null {
    if (attachmentsContextLength < ChatView.LARGE_ATTACHMENT_WARNING_CHARS) return null;
    const approxTokens = Math.round(attachmentsContextLength / ChatView.CHARS_PER_TOKEN_ESTIMATE);
    return (
      `Large attachment content (~${approxTokens.toLocaleString()} estimated tokens). This may take ` +
      `several minutes to process, especially with slower models like opus. If it times out, try a faster ` +
      `model, a longer "Claude Code timeout" in Settings, or sending large files separately.`
    );
  }

  /**
   * The unified agent sends extracted attachment text as one prompt in a single turn -- there's
   * no chunking for chat attachments (unlike vault graph ingest). A large, dense attachment (e.g.
   * a big CSV export) can legitimately take many minutes for the CLI to process, especially with
   * a slower model, and previously the only feedback was total silence until either a response or
   * a timeout. Surface the size up front instead of leaving the user guessing whether it's stuck.
   */
  private warnIfAttachmentContextIsLarge(attachmentsContext: string): void {
    const message = ChatView.largeAttachmentWarningMessage(attachmentsContext.length);
    if (message) new Notice(message, 15000);
  }

  async handleDroppedFile(file: File) {
    if (!file) return;

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ChatView.ALLOWED_EXTENSIONS.has(ext)) {
      new Notice(`File type .${ext} not supported. Use images (.jpg, .png, etc.) or documents (.pdf, .docx, .txt)`);
      return;
    }

    this.attachedFiles.push({ file, extracted: false });
    this.renderAttachments();
    new Notice(`Attached: ${file.name}`);
  }

  private getVaultAbsolutePath(): string {
    const adapter = this.app.vault.adapter as any;
    return typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
  }

  /** Preserve prior evidence when a browser upload reuses an existing filename. */
  private getAvailableEvidencePath(evidenceFolder: string, rawName: string): string {
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, '_');
    const dot = safeName.lastIndexOf('.');
    const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
    const extension = dot > 0 ? safeName.slice(dot) : '';
    let candidate = normalizePath(`${evidenceFolder}/${safeName}`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${evidenceFolder}/${stem}-${suffix}${extension}`);
      suffix++;
    }
    return candidate;
  }

  /**
   * Handle dropped internal file (TFile) from Obsidian Vault
   */
  async handleDroppedAbstractFile(file: TFile) {
    if (!file) return;

    const ext = (file.extension || '').toLowerCase();
    if (!ChatView.ALLOWED_EXTENSIONS.has(ext)) {
      new Notice(`File type .${ext} not supported. Use images or documents.`);
      return;
    }

    this.attachedFiles.push({ file, extracted: false });
    this.renderAttachments();
    new Notice(`Attached: ${file.name}`);
  }

  /**
   * Handle a dropped folder — recursively collect all allowed files and attach them.
   */
  async handleDroppedFolder(folder: TFolder) {
    if (!folder) return;

    const files = this.collectFilesFromFolder(folder);
    if (files.length === 0) {
      new Notice(`No supported files found in folder "${folder.name}"`);
      return;
    }

    for (const file of files) {
      this.attachedFiles.push({ file, extracted: false });
    }
    this.renderAttachments();
    new Notice(`Attached ${files.length} file${files.length > 1 ? 's' : ''} from folder "${folder.name}"`);
  }

  private collectFilesFromFolder(folder: TFolder): TFile[] {
    const results: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile) {
        const ext = (child.extension || '').toLowerCase();
        if (ChatView.ALLOWED_EXTENSIONS.has(ext)) {
          results.push(child);
        }
      } else if (child instanceof TFolder) {
        results.push(...this.collectFilesFromFolder(child));
      }
    }
    return results;
  }

  /**
   * Render the attached files display.
   */
  private renderAttachments() {
    this.attachmentsContainer.empty();

    if (this.attachedFiles.length === 0) {
      return;
    }

    for (let i = 0; i < this.attachedFiles.length; i++) {
      const attachment = this.attachedFiles[i];
      const attachmentEl = this.attachmentsContainer.createDiv("vault-ai-attachment-item");

      const isImage = ChatView.isImageFile(attachment.file.name);
      const fileInfo = attachmentEl.createDiv("vault-ai-attachment-info");
      fileInfo.createSpan({ text: isImage ? "🖼️ " : "📄 ", cls: "vault-ai-attachment-icon" });
      fileInfo.createSpan({ text: attachment.file.name, cls: "vault-ai-attachment-name" });

      if (attachment.extracted && attachment.content) {
        const preview = attachment.content.substring(0, 100).replace(/\n/g, ' ').trim();
        if (preview) {
          attachmentEl.createDiv({
            text: preview + (attachment.content.length > 100 ? '...' : ''),
            cls: "vault-ai-attachment-preview"
          });
        }
      } else {
        attachmentEl.createDiv({
          text: isImage ? "🔍 Will analyze with AI on send" : "📋 Ready to extract on send",
          cls: "vault-ai-attachment-preview"
        });
      }

      // Remove button
      const removeBtn = attachmentEl.createEl("button", {
        text: "✕",
        cls: "vault-ai-attachment-remove",
        attr: { "aria-label": "Remove attachment", "title": "Remove attachment" }
      });
      removeBtn.addEventListener("click", () => {
        this.attachedFiles.splice(i, 1);
        this.renderAttachments();
      });
    }
  }



  // Get the appropriate input placeholder based on current mode
  getInputPlaceholder(): string {
    return "Ask for an investigation — search or graph work follows from your wording and attachments. Enter sends, Shift+Enter adds a line…";
  }

  // Update the input placeholder text
  updateInputPlaceholder() {
    if (this.inputEl) {
      this.inputEl.placeholder = this.getInputPlaceholder();
    }
  }





  renderSidebar() {
    this.sidebarContainer.empty();

    // Sidebar header
    const sidebarHeader = this.sidebarContainer.createDiv("vault-ai-chat-sidebar-header");
    sidebarHeader.createEl("h4", { text: "Conversations" });

    // Conversation list
    this.conversationListEl = this.sidebarContainer.createDiv("vault-ai-conversation-list");
    this.renderConversationList();
  }

  renderConversationList() {
    this.conversationListEl.empty();
    const conversations = this.plugin.conversationService.getConversationList();

    if (conversations.length === 0) {
      this.conversationListEl.createEl("p", {
        text: "No conversations yet",
        cls: "vault-ai-no-conversations"
      });
      return;
    }

    for (const conv of conversations) {
      const convItem = this.conversationListEl.createDiv("vault-ai-conversation-item");
      if (this.currentConversation && this.currentConversation.id === conv.id) {
        convItem.addClass("active");
      }

      // Title and preview
      const convContent = convItem.createDiv("vault-ai-conversation-content");
      convContent.createEl("div", { text: conv.title, cls: "vault-ai-conversation-title" });

      const meta = convContent.createDiv("vault-ai-conversation-meta");
      const date = new Date(conv.updatedAt);
      meta.createEl("span", { text: this.formatDate(date), cls: "vault-ai-conversation-date" });

      // Click to load conversation
      convContent.addEventListener("click", () => {
        void this.loadConversation(conv.id);
      });

      // Actions (delete, rename)
      const actions = convItem.createDiv("vault-ai-conversation-actions");

      const renameBtn = actions.createEl("button", { cls: "vault-ai-conv-action-btn" });
      renameBtn.setText("✏️");
      renameBtn.title = "Rename";
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.renameConversation(conv.id, conv.title);
      });

      const deleteBtn = actions.createEl("button", { cls: "vault-ai-conv-action-btn" });
      deleteBtn.setText("🗑️");
      deleteBtn.title = "Delete";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.deleteConversation(conv.id);
      });
    }
  }

  formatDate(date: Date): string {
    return ChatView.formatRelativeDate(date);
  }

  /**
   * Calendar days, not elapsed hours: a conversation touched at 02:00 yesterday is 23h old
   * at 01:00 today and used to be shown as a bare "02:00", indistinguishable from today.
   */
  static formatRelativeDate(date: Date, now: Date = new Date()): string {
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
    if (days <= 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (days === 1) return "Yesterday";
    if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  async loadConversation(id: string) {
    // Don't reload if already viewing this conversation
    if (this.currentConversation && this.currentConversation.id === id) {
      return;
    }

    const conversation = await this.plugin.conversationService.loadConversation(id);
    if (conversation) {
      this.abortAllActiveOperations();
      this.currentConversation = conversation;
      this.chatHistory = this.conversationMessagesToHistory(conversation.messages);
      this.syncModesFromConversation(conversation);
      this.selectedTaskAgentId =
        conversation.taskAgentId ?? this.plugin.settings.preferredTaskAgentId ?? "";
      this.plugin.conversationService.setCurrentConversationId(id);
      await this.render();
    } else {
      new Notice("Failed to load conversation");
    }
  }

  async startNewConversation() {
    this.abortAllActiveOperations();
    // Save current conversation first if it has messages
    if (this.currentConversation && this.chatHistory.length > 0) {
      await this.saveCurrentConversation();
    }
    this.currentConversation = null;
    this.chatHistory = [];
    this.applyChatMode('general');
    this.selectedTaskAgentId = this.plugin.settings.preferredTaskAgentId ?? "";
    this.plugin.conversationService.setCurrentConversationId(null);
    await this.render();
    new Notice("Started new conversation");
  }

  async deleteConversation(id: string) {
    new ConfirmModal(
      this.app,
      "Delete Conversation",
      "Are you sure you want to delete this conversation?",
      async () => {
        const success = await this.plugin.conversationService.deleteConversation(id);

        // Clear current conversation if it was deleted
        if (this.currentConversation && this.currentConversation.id === id) {
          this.abortAllActiveOperations();
          this.currentConversation = null;
          this.chatHistory = [];
        }

        // Always refresh the UI (the service already updated its internal list)
        this.renderConversationList();
        await this.renderMessages();

        if (success) {
          new Notice("Conversation deleted");
        } else {
          new Notice("Failed to delete conversation");
        }
      },
      undefined,
      true // destructive
    ).open();
  }

  renameConversation(id: string, currentTitle: string) {
    new RenameConversationModal(this.app, currentTitle, (newTitle: string) => {
      void (async () => {
        const success = await this.plugin.conversationService.renameConversation(id, newTitle);
        if (success) {
          if (this.currentConversation && this.currentConversation.id === id) {
            this.currentConversation.title = newTitle;
          }
          await this.plugin.conversationService.loadConversationList();
          this.renderConversationList();
          new Notice("Conversation renamed");
        }
      })();
    }).open();
  }

  private renderMessagesInFlight: Promise<void> | null = null;
  private renderMessagesQueued = false;

  /**
   * Coalesces concurrent callers instead of letting two passes run at once. `doRenderMessages`
   * empties `messagesContainer` synchronously up front but repopulates it across many `await`
   * points (one MarkdownRenderer.render per message) -- with 48 call sites across this file,
   * many fire-and-forget (rapid progress updates chief among them), two overlapping passes were
   * a real, frequently-hit race: the second pass's `empty()` clears the container while the
   * first pass's loop is still mid-flight and keeps appending into it, producing duplicated
   * message bubbles (and orphaned cancel buttons attached to nodes that already got detached).
   * A caller that arrives mid-pass marks another pass queued and awaits the same in-flight
   * promise; the loop below re-runs once more after settling so the queued caller's state is
   * still guaranteed to be reflected before its await resolves.
   */
  async renderMessages(): Promise<void> {
    if (this.renderMessagesInFlight) {
      this.renderMessagesQueued = true;
      return this.renderMessagesInFlight;
    }
    this.renderMessagesInFlight = (async () => {
      do {
        this.renderMessagesQueued = false;
        await this.doRenderMessages();
      } while (this.renderMessagesQueued);
    })();
    try {
      await this.renderMessagesInFlight;
    } finally {
      this.renderMessagesInFlight = null;
    }
  }

  private async doRenderMessages() {
    // Whether the user was reading the end; only then does a re-render follow it. A pass
    // ran for every progress line, and it always slammed to the bottom, yanking anyone who
    // had scrolled up to re-read an earlier answer.
    const box = this.messagesContainer;
    const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const previousTop = box.scrollTop;
    this.messagesContainer.empty();

    if (this.chatHistory.length === 0) {
      this.messagesContainer.createEl("p", {
        text: "Start an investigation, or ask a question about your vault.",
        cls: "vault-ai-chat-empty",
      });
      return;
    }

    for (let i = 0; i < this.chatHistory.length; i++) {
      const item = this.chatHistory[i];
      const messageDiv = this.messagesContainer.createDiv(
        `vault-ai-chat-message vault-ai-chat-${item.role}`
      );
      messageDiv.setAttribute("data-message-index", i.toString());

      const roleLabel = messageDiv.createEl("strong", {
        text: item.role === "user" ? "You: " : "AI: ",
      });

      const contentDiv = messageDiv.createDiv("vault-ai-chat-content");

      // Render content as Markdown for rich formatting
      // Use MarkdownRenderer to properly render headings, lists, bold, italic, links, code blocks, etc.
      await MarkdownRenderer.render(
        this.app,
        item.content,
        contentDiv,
        "", // sourcePath - empty string for non-file content
        this // component for lifecycle management
      );

      // Show progress bar and intermediate results for report generation
      if (item.role === "assistant" && item.progress && typeof item.progress === "object" && "percent" in item.progress) {
        const progressContainer = messageDiv.createDiv("vault-ai-progress-container");
        this.renderSingleProgress(progressContainer, i, item.progress);
      }

      if (item.role === "assistant" && item.extractionLogs && item.extractionLogs.length > 0) {
        const details = messageDiv.createEl("details", { cls: "vault-ai-extraction-logs" });
        details.style.cssText =
          "margin-top: 8px; padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 6px; background: var(--background-secondary);";
        details.open = !!item.extractionLogsExpanded;
        const summary = details.createEl("summary", {
          text: `Agent logs (${item.extractionLogs.length})`,
        });
        summary.style.cssText = "cursor: pointer; font-size: 12px; color: var(--text-muted);";
        details.addEventListener("toggle", () => {
          item.extractionLogsExpanded = details.open;
        });

        const logList = details.createEl("div", { cls: "vault-ai-extraction-log-list" });
        logList.style.cssText =
          "margin-top: 8px; max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;";
        for (const ev of item.extractionLogs) {
          const row = logList.createEl("pre", { text: this.formatExtractionLogLine(ev) });
          row.style.cssText =
            "margin: 0; white-space: pre-wrap; font-size: 11px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 6px;";
        }
      }

      // Show intermediate results for report generation
      if (item.role === "assistant" && item.intermediateResults && item.intermediateResults.length > 0) {
        const resultsContainer = messageDiv.createDiv("vault-ai-intermediate-results-container");
        resultsContainer.createEl("strong", { text: "Intermediate results:" });
        const resultsList = resultsContainer.createEl("ul", { cls: "vault-ai-intermediate-results" });
        item.intermediateResults.forEach((result) => {
          resultsList.createEl("li", { text: result });
        });
      }

      // Show matching notes for assistant responses
      if (item.role === "assistant" && item.notes && item.notes.length > 0) {
        const notesDiv = messageDiv.createDiv("vault-ai-chat-notes");
        notesDiv.createEl("small", { text: "Referenced notes:" });

        for (const note of item.notes) {
          const noteLink = notesDiv.createEl("a", {
            text: note.path,
            cls: "vault-ai-note-link",
          });
          noteLink.addEventListener("click", (e) => {
            e.preventDefault();
            void (async () => {
              const file = this.app.vault.getAbstractFileByPath(note.path);
              if (file instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(file);
              }
            })();
          });
        }
      }

      // Show Used Graph Entities (Advanced Graph Search)
      if (item.role === "assistant" && item.usedEntities && item.usedEntities.length > 0) {
        const entitiesDiv = messageDiv.createDiv("vault-ai-used-entities");
        entitiesDiv.style.marginTop = "8px";
        entitiesDiv.createEl("small", { text: "Graph sources:" });

        const chipsContainer = entitiesDiv.createDiv("vault-ai-entity-chips-container");
        chipsContainer.style.cssText = `
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-top: 4px;
        `;

        for (const usedEntity of item.usedEntities) {
          const fullEntity = this.plugin.entityManager.getEntity(usedEntity.id);
          if (!fullEntity) continue;

          const chip = chipsContainer.createDiv("vault-ai-entity-chip");
          chip.style.cssText = `
                display: inline-flex;
                align-items: center;
                padding: 2px 8px;
                border-radius: 12px;
                background: var(--background-modifier-border);
                font-size: 11px;
                cursor: pointer;
                border: 1px solid var(--background-modifier-border-hover);
                transition: background 0.2s;
            `;
          chip.setAttribute("aria-label", `Open ${fullEntity.label}`);

          // Icon based on type (simple mapping if helper not available)
          const iconSpan = chip.createEl("span", { text: "🔗" });
          iconSpan.style.marginRight = "4px";
          iconSpan.style.opacity = "0.7";

          chip.createEl("span", { text: fullEntity.label });

          chip.addEventListener("mouseenter", () => {
            chip.style.background = "var(--background-modifier-hover)";
          });
          chip.addEventListener("mouseleave", () => {
            chip.style.background = "var(--background-modifier-border)";
          });

          chip.addEventListener("click", (e) => {
            e.preventDefault();
            if (fullEntity.filePath) {
              void (async () => {
                const file = this.app.vault.getAbstractFileByPath(fullEntity.filePath!);
                if (file instanceof TFile) {
                  await this.app.workspace.getLeaf().openFile(file);
                } else {
                  new Notice("Linked note file not found");
                }
              })();
            }
          });
        }
      }

      // Show created entities with clickable graph view links
      if (item.role === "assistant" && item.createdEntities && item.createdEntities.length > 0) {
        const entitiesDiv = messageDiv.createDiv("vault-ai-created-entities");
        entitiesDiv.style.cssText = `
          margin-top: 10px;
          padding: 10px;
          background: var(--background-secondary);
          border-radius: 6px;
          border-left: 3px solid var(--interactive-accent);
        `;

        for (const entity of item.createdEntities) {
          const entityRow = entitiesDiv.createDiv("vault-ai-entity-row");
          entityRow.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
            flex-wrap: wrap;
          `;

          // Entity type badge
          const typeBadge = entityRow.createEl("span", {
            text: entity.type,
            cls: "vault-ai-entity-type-badge",
          });
          typeBadge.style.cssText = `
            background: var(--interactive-accent);
            color: var(--text-on-accent);
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
          `;

          // Entity label
          const labelSpan = entityRow.createEl("span", {
            text: entity.label,
            cls: "vault-ai-entity-label",
          });
          labelSpan.style.cssText = `
            font-weight: 500;
            flex: 1;
            min-width: 100px;
          `;

          // Open Note button
          const noteBtn = entityRow.createEl("button", {
            text: "📄 note",
            cls: "vault-ai-entity-note-btn",
          });
          noteBtn.style.cssText = `
            padding: 3px 8px;
            font-size: 11px;
            background: var(--background-modifier-border);
            border: none;
            border-radius: 4px;
            cursor: pointer;
          `;
          noteBtn.title = "Open entity note";
          noteBtn.addEventListener("click", (e) => {
            e.preventDefault();
            void (async () => {
              const file = this.app.vault.getAbstractFileByPath(entity.filePath);
              if (file instanceof TFile) {
                await this.app.workspace.getLeaf().openFile(file);
              }
            })();
          });

          // Open in Graph View button
          const graphBtn = entityRow.createEl("button", {
            text: "🔗 graph",
            cls: "vault-ai-entity-graph-btn",
          });
          graphBtn.style.cssText = `
            padding: 3px 8px;
            font-size: 11px;
            background: var(--interactive-accent);
            color: var(--text-on-accent);
            border: none;
            border-radius: 4px;
            cursor: pointer;
          `;
          graphBtn.title = "View in graph";
          graphBtn.addEventListener("click", (e) => {
            e.preventDefault();
            void this.plugin.openGraphViewWithEntity(entity.id);
          });
        }

        // Add hint text
        const hintText = entitiesDiv.createEl("small", {
          text: "Click 'graph' to view entity in the graph, or 'note' to open its file.",
          cls: "vault-ai-entity-hint",
        });
        hintText.style.cssText = `
          display: block;
          margin-top: 8px;
          color: var(--text-muted);
          font-style: italic;
        `;
      }

      // Round 4: Show proposed graph modifications (persistent box)
      if (item.role === "assistant" && item.proposedModifications && item.proposedModifications.length > 0) {
        const proposedDiv = messageDiv.createDiv("vault-ai-proposed-modifications");
        proposedDiv.style.cssText = `
          margin-top: 12px;
          padding: 12px;
          background: var(--background-secondary-alt);
          border: 1px solid var(--background-modifier-border-hover);
          border-radius: 8px;
          border-left: 4px solid var(--interactive-accent);
        `;

        proposedDiv.createEl("h4", {
          text: "📊 Proposed Graph Changes",
          cls: "vault-ai-proposed-title"
        }).style.marginTop = "0";

        proposedDiv.createEl("p", {
          text: "Review and apply the following graph modifications:",
          cls: "vault-ai-proposed-subtitle"
        }).style.fontSize = "small";

        const listContainer = proposedDiv.createDiv("vault-ai-proposed-list");
        listContainer.style.marginBottom = "12px";

        const selectedIndices: number[] = [];

        item.proposedModifications.forEach((cmd, idx) => {
          const row = listContainer.createDiv();
          row.style.cssText = `
            display: flex;
            align-items: flex-start;
            gap: 8px;
            margin-bottom: 6px;
            padding: 4px;
            border-bottom: 1px solid var(--background-modifier-border);
          `;

          const cb = row.createEl("input");
          cb.type = "checkbox";
          cb.checked = true;
          selectedIndices.push(idx);
          cb.style.marginTop = "4px";

          const label = row.createEl("span");
          label.style.fontSize = "13px";

          let labelText = `❓ ${cmd}`;
          try {
            if (cmd.startsWith("@@create_entity")) {
              const data = JSON.parse(cmd.replace("@@create_entity", "").trim());
              labelText = `➕ Create ${data.type}: **${data.label || 'Entity'}**`;
            } else if (cmd.startsWith("@@delete_entity")) {
              const data = JSON.parse(cmd.replace("@@delete_entity", "").trim());
              const name = this.plugin.entityManager.getEntity(data.id)?.label || `ID: ${data.id}`;
              labelText = `🗑️ Delete Entity: **${name}**`;
            } else if (cmd.startsWith("@@create_link")) {
              const data = JSON.parse(cmd.replace("@@create_link", "").trim());
              labelText = `🔗 Connect: [**${data.from}**] ──(${data.relationship})──> [**${data.to}**]`;
            } else if (cmd.startsWith("@@delete_link")) {
              const data = JSON.parse(cmd.replace("@@delete_link", "").trim());
              labelText = `✂️ Delete Link (ID: ${data.id})`;
            }
          } catch (e) { labelText = `⚠️ Raw: ${cmd}`; }

          const parts = labelText.split(/(\*\*.*?\*\*)/g);
          parts.forEach(p => {
            if (p.startsWith('**') && p.endsWith('**')) {
              label.createEl('strong', { text: p.substring(2, p.length - 2) });
            } else {
              label.appendChild(document.createTextNode(p));
            }
          });

          cb.addEventListener("change", () => {
            if (cb.checked) selectedIndices.push(idx);
            else {
              const iIdx = selectedIndices.indexOf(idx);
              if (iIdx > -1) selectedIndices.splice(iIdx, 1);
            }
          });
        });

        const actionRow = proposedDiv.createDiv();
        actionRow.style.display = "flex";
        actionRow.style.gap = "10px";

        const applyBtn = actionRow.createEl("button", {
          text: "Apply Selected Changes",
          cls: "mod-cta"
        });
        applyBtn.addEventListener("click", () => {
          void this.applyProposedModifications(i, selectedIndices);
        });

        const dismissBtn = actionRow.createEl("button", {
          text: "Dismiss"
        });
        dismissBtn.addEventListener("click", () => {
          this.chatHistory[i].proposedModifications = undefined;
          void this.renderMessages();
          // Persisted, like the vault-ops Dismiss: otherwise the box came back, all
          // boxes re-checked, on the next conversation switch.
          void this.saveCurrentConversation();
        });
      }

      if (item.role === "assistant" && item.proposedCustomVaultOps && item.proposedCustomVaultOps.length > 0) {
        const vaultOpsDiv = messageDiv.createDiv("vault-ai-proposed-custom-vault");
        vaultOpsDiv.style.cssText = `
          margin-top: 12px;
          padding: 12px;
          background: var(--background-secondary-alt);
          border: 1px solid var(--background-modifier-border-hover);
          border-radius: 8px;
          border-left: 4px solid var(--text-accent);
        `;
        vaultOpsDiv.createEl("h4", { text: "📁 Proposed vault changes (skills / credentials / enrichers / scripts)" }).style.marginTop = "0";
        vaultOpsDiv.createEl("p", {
          text: "Review and apply file writes under your OSINT Copilot custom folder. Credential file contents are not shown here. Script proposals show a side-by-side diff (current vault vs proposed); the plugin does not run scripts.",
        }).style.fontSize = "small";

        const listEl = vaultOpsDiv.createDiv();
        listEl.style.marginBottom = "12px";
        const selectedVaultOpIndices = new Set<number>(item.proposedCustomVaultOps.map((_, idx) => idx));

        for (let idx = 0; idx < item.proposedCustomVaultOps.length; idx++) {
          const op = item.proposedCustomVaultOps[idx];
          const outer = listEl.createDiv();
          outer.style.cssText = `
            display: flex;
            flex-direction: column;
            margin-bottom: 10px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--background-modifier-border);
          `;
          const row = outer.createDiv();
          row.style.cssText = `
            display: flex;
            align-items: flex-start;
            gap: 8px;
            padding: 4px 0 0 0;
          `;
          const cb = row.createEl("input");
          cb.type = "checkbox";
          cb.checked = true;
          cb.style.marginTop = "4px";
          const label = row.createEl("span", { text: summarizeCustomVaultOperation(op) });
          label.style.fontSize = "13px";
          cb.addEventListener("change", () => {
            if (cb.checked) selectedVaultOpIndices.add(idx);
            else selectedVaultOpIndices.delete(idx);
          });
          await appendVaultOpPreviewBlock(this.plugin, outer, op);
        }

        const vaultActionRow = vaultOpsDiv.createDiv();
        vaultActionRow.style.display = "flex";
        vaultActionRow.style.gap = "10px";
        const applyVaultBtn = vaultActionRow.createEl("button", { text: "Apply selected", cls: "mod-cta" });
        applyVaultBtn.addEventListener("click", () => {
          void this.applyProposedCustomVaultOps(i, Array.from(selectedVaultOpIndices));
        });
        const dismissVaultBtn = vaultActionRow.createEl("button", { text: "Dismiss" });
        dismissVaultBtn.addEventListener("click", () => {
          this.chatHistory[i].proposedCustomVaultOps = undefined;
          void this.renderMessages();
          void this.saveCurrentConversation();
        });
      }

      // Show "Open Companies&People" button for report generation messages
      if (item.role === "assistant" && item.reportFilePath) {
        const reportButtonContainer = messageDiv.createDiv("vault-ai-report-button-container");
        reportButtonContainer.setCssProps({
          "margin-top": "12px",
          padding: "10px",
          background: "var(--background-secondary)",
          "border-radius": "6px",
          "border-left": "3px solid var(--interactive-accent)"
        });

        const reportButton = reportButtonContainer.createEl("button", {
          text: "📄 open companies&people",
          cls: "vault-ai-open-report-btn",
        });
        reportButton.setCssProps({
          padding: "8px 16px",
          "font-size": "13px",
          "font-weight": "500",
          background: "var(--interactive-accent)",
          color: "var(--text-on-accent)",
          border: "none",
          "border-radius": "4px",
          cursor: "pointer",
          transition: "opacity 0.2s"
        });
        reportButton.title = `Open report: ${item.reportFilePath}`;

        // Add hover effect
        reportButton.addEventListener("mouseenter", () => {
          reportButton.setCssProps({ opacity: "0.8" });
        });
        reportButton.addEventListener("mouseleave", () => {
          reportButton.setCssProps({ opacity: "1" });
        });

        // Add click handler to open the report
        reportButton.addEventListener("click", (e) => {
          e.preventDefault();
          void (async () => {
            const file = this.app.vault.getAbstractFileByPath(item.reportFilePath!);
            if (file instanceof TFile) {
              await this.app.workspace.getLeaf().openFile(file);
              new Notice(`Opened report: ${item.reportFilePath}`);
            } else {
              new Notice(`Companies&People file not found: ${item.reportFilePath}`);
            }
          })();
        });

        // Add file path label below button
        const filePathLabel = reportButtonContainer.createEl("small", {
          text: `File: ${item.reportFilePath}`,
          cls: "vault-ai-report-path-label",
        });
        filePathLabel.style.cssText = `
          display: block;
          margin-top: 6px;
          color: var(--text-muted);
          font-style: italic;
          font-size: 11px;
        `;
      }
    }

    this.messagesContainer.scrollTop = wasAtBottom ? this.messagesContainer.scrollHeight : previousTop;
  }

  updateProgressBar(messageIndex: number, progress?: { message: string; percent: number }, intermediateResults?: string[]) {
    // Find the message element by data attribute
    const messageDiv = this.messagesContainer.querySelector(
      `.vault-ai-chat-message[data-message-index="${messageIndex}"]`
    ) as HTMLElement;

    if (!messageDiv) return;

    // Use progress from parameter, or fallback to saved progress in chatHistory
    const currentProgress = progress ||
      (messageIndex < this.chatHistory.length &&
        this.chatHistory[messageIndex].progress &&
        typeof this.chatHistory[messageIndex].progress === "object" &&
        "percent" in this.chatHistory[messageIndex].progress
        ? this.chatHistory[messageIndex].progress as { message: string; percent: number }
        : undefined);

    // Find or create progress container FIRST (before updating content)
    let progressContainer = messageDiv.querySelector(".vault-ai-progress-container") as HTMLElement;

    if (currentProgress) {
      if (!progressContainer) {
        // Create progress container if it doesn't exist - insert after contentDiv
        const contentDiv = messageDiv.querySelector(".vault-ai-chat-content") as HTMLElement;
        if (contentDiv) {
          progressContainer = document.createElement("div");
          progressContainer.className = "vault-ai-progress-container";
          // Insert after contentDiv using insertAdjacentElement
          contentDiv.insertAdjacentElement("afterend", progressContainer);
        } else {
          progressContainer = messageDiv.createDiv("vault-ai-progress-container");
        }
      }
      this.renderSingleProgress(progressContainer, messageIndex, currentProgress);

      const vaultLive = this.chatHistory[messageIndex]?.vaultIngestLiveLog;
      const vaultPreviewCmds = this.chatHistory[messageIndex]?.vaultIngestPreviewCommands;
      const existingIngestPreview = messageDiv.querySelector(".vault-ai-vault-ingest-preview") as HTMLElement;
      if (vaultLive && vaultLive.length > 0) {
        const ingestPreview = existingIngestPreview || (() => {
          const el = document.createElement("div");
          el.className = "vault-ai-vault-ingest-preview";
          progressContainer.insertAdjacentElement("afterend", el);
          return el;
        })();
        ingestPreview.empty();
        ingestPreview.style.marginTop = "10px";
        ingestPreview.style.padding = "10px 12px";
        ingestPreview.style.border = "1px solid var(--background-modifier-border)";
        ingestPreview.style.borderRadius = "8px";
        ingestPreview.style.background = "var(--background-secondary)";
        ingestPreview.style.maxHeight = "240px";
        ingestPreview.style.overflowY = "auto";
        ingestPreview.style.fontSize = "12px";
        ingestPreview.createEl("div", {
          text: `Applied to graph (${vaultLive.length}) — one line per entity or link`,
        }).style.marginBottom = "8px";
        const mdBox = ingestPreview.createDiv();
        void MarkdownRenderer.render(this.app, vaultLive.join("\n\n"), mdBox, "", this);
      } else if (vaultPreviewCmds && vaultPreviewCmds.length > 0) {
        const ingestPreview = existingIngestPreview || (() => {
          const el = document.createElement("div");
          el.className = "vault-ai-vault-ingest-preview";
          progressContainer.insertAdjacentElement("afterend", el);
          return el;
        })();
        ingestPreview.empty();
        ingestPreview.style.marginTop = "10px";
        ingestPreview.style.padding = "10px 12px";
        ingestPreview.style.border = "1px solid var(--background-modifier-border)";
        ingestPreview.style.borderRadius = "8px";
        ingestPreview.style.background = "var(--background-secondary)";
        ingestPreview.style.maxHeight = "240px";
        ingestPreview.style.overflowY = "auto";
        ingestPreview.style.fontSize = "12px";
        ingestPreview.createEl("div", {
          text: `Proposed graph commands (${vaultPreviewCmds.length}) — grows as each file/chunk is processed`,
        }).style.marginBottom = "8px";
        const pre = ingestPreview.createEl("pre");
        pre.style.whiteSpace = "pre-wrap";
        pre.style.wordBreak = "break-word";
        pre.style.margin = "0";
        pre.textContent = vaultPreviewCmds.join("\n");
      } else if (existingIngestPreview) {
        existingIngestPreview.remove();
      }
    }
    // Don't remove progress container if progress is not available - keep the last known progress

    // Update content AFTER progress bar is set up (so it doesn't interfere)
    // Only update if content actually changed to avoid unnecessary DOM manipulation
    if (messageIndex < this.chatHistory.length) {
      const contentDiv = messageDiv.querySelector(".vault-ai-chat-content") as HTMLElement;
      if (contentDiv) {
        const newContent = this.chatHistory[messageIndex].content;
        // Only update if content changed
        if (contentDiv.textContent !== newContent) {
          // Update content - textContent should not affect sibling elements
          contentDiv.textContent = newContent;
        }
      }
    }

    // Use intermediate results from parameter, or fallback to saved results in chatHistory
    const currentIntermediateResults = intermediateResults ||
      (messageIndex < this.chatHistory.length &&
        this.chatHistory[messageIndex].intermediateResults &&
        this.chatHistory[messageIndex].intermediateResults!.length > 0
        ? this.chatHistory[messageIndex].intermediateResults
        : undefined);

    // Update intermediate results
    let resultsContainer = messageDiv.querySelector(".vault-ai-intermediate-results-container") as HTMLElement;

    if (currentIntermediateResults && currentIntermediateResults.length > 0) {
      if (!resultsContainer) {
        // Create results container if it doesn't exist
        resultsContainer = messageDiv.createDiv("vault-ai-intermediate-results-container");
      } else {
        // Clear existing content
        resultsContainer.empty();
      }

      resultsContainer.createEl("strong", { text: "Intermediate results:" });
      const resultsList = resultsContainer.createEl("ul", { cls: "vault-ai-intermediate-results" });
      currentIntermediateResults.forEach((result) => {
        resultsList.createEl("li", { text: result });
      });
    }
    // Don't remove results container if no new results - keep the last known results
  }





  async handleCancel(index: number) {
    const controller = this.activeAbortControllers.get(index);
    if (!controller) return;

    new ConfirmModal(
      this.app,
      "Cancel Operation",
      "Are you sure you want to cancel this operation?",
      () => {
        // user confirmed
        controller.abort();
        this.activeAbortControllers.delete(index);

        // Update UI to show cancelled state
        if (this.chatHistory[index]) {
          const hist = this.chatHistory[index];
          const currentContent = hist.content || "";
          hist.content = currentContent + "\n\n❌ **Cancelled by user**";
          hist.progress = undefined;
          void this.renderMessages();
        }

        new Notice("Operation cancelled");
      },
      () => {
        // user cancelled the modal (did not confirm)
      },
      true // destructive action
    ).open();
  }

  /** True while a send is in flight: the double-submit guard. */
  private sending = false;
  private noRuntimeAvailable = false;

  private syncSendControls(): void {
    if (this.sendButtonEl) this.sendButtonEl.disabled = this.sending || this.noRuntimeAvailable;
  }

  /** Puts a message and its attachments back after a send that could not go ahead. */
  private restoreDraft(draft: string, files: typeof this.attachedFiles): void {
    if (draft && !this.inputEl.value.trim()) this.inputEl.value = draft;
    if (files.length > 0) {
      this.attachedFiles = files;
      this.renderAttachments();
    }
  }

  async handleSend() {
    // The guard, the button state and the error boundary all live here; the actual send
    // is doSend. Without the guard, Enter twice during the runtime probe sent the same
    // message twice and ran two CLI processes; without the boundary a vault write failure
    // left the user bubble on screen and nothing else, not even a console line.
    if (this.sending) return;
    const value = this.inputEl.value.trim();
    if (!value && this.attachedFiles.length === 0) return;
    this.sending = true;
    this.syncSendControls();
    try {
      await this.doSend(value);
    } catch (e) {
      console.error("[ChatView] send failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Could not send: ${msg}`, 8000);
      this.chatHistory.push({ role: "assistant", content: `❌ **Send failed:** ${msg}` });
      await this.renderMessages().catch(() => undefined);
    } finally {
      this.sending = false;
      this.syncSendControls();
    }
  }

  private async doSend(value: string) {
    const requestRuntimeId = this.selectedTaskAgentId.trim()
      ? this.plugin.settings.apiProvider
      : this.plugin.settings.agentRuntimeProvider;

    // The cached answer first. Forcing a re-probe on every send spawned `--version` for
    // every configured runtime -- up to ~16s with a Hermes or custom runtime -- with the
    // input still showing the text and nothing in the transcript. A fresh probe is only
    // worth the wait when the cache says the selected runtime is missing.
    let availability = await getChatRuntimeAvailability(this.plugin);
    if (!availability.byId[requestRuntimeId]) {
      availability = await getChatRuntimeAvailability(this.plugin, true);
    }
    if (availability.availableIds.length === 0) {
      new Notice(
        "No agent runtime is available. Install Claude, Codex, Hermes, or a custom runtime and confirm settings under OSINT Copilot.",
        8000,
      );
      return;
    }
    if (!availability.byId[requestRuntimeId]) {
      new Notice(
        `${this.runtimeDisplayName(requestRuntimeId)} is unavailable, so your message was not sent. ` +
        'Check its executable and login, or explicitly select another runtime.',
        9000,
      );
      return;
    }
    // Images are read by the extraction CLI (apiProvider), not necessarily the chat
    // runtime. Checked here rather than per file: the per-file failure emptied the
    // input and dropped every attachment before saying anything.
    const needsImageRuntime = this.attachedFiles.some(
      (a) => ChatView.isImageFile(a.file.name) && !(a.extracted && a.content),
    );
    const imageRuntimeId = this.plugin.settings.apiProvider;
    if (needsImageRuntime && !availability.byId[imageRuntimeId]) {
      new Notice(
        `Image attachments are read by ${this.runtimeDisplayName(imageRuntimeId)}, which is unavailable, ` +
        'so your message was not sent. Remove the images or configure that CLI in Settings → OSINT Copilot.',
        9000,
      );
      return;
    }

    const draft = this.inputEl.value;
    this.inputEl.value = "";

    // Build processed value - keep file content separate from chat display
    let displayValue = value; // What user sees in chat
    let processingValue = value; // Combined text for task-agent routes that accept one input string
    let attachmentsContext = ""; // Extracted files stay separate from the user's instruction
    const processedFileNames: string[] = []; // Track file names for display
    const extractedContents: string[] = []; // Extracted text

    if (this.attachedFiles.length > 0) {
      const filesToProcess = [...this.attachedFiles];
      this.attachedFiles = [];
      this.renderAttachments();

      const fileCount = filesToProcess.length;
      const extractionMsgIndex = this.chatHistory.length;

      this.chatHistory.push({
        role: "assistant",
        content: `📄 Extracting text from ${fileCount} file${fileCount > 1 ? 's' : ''}...`,
        progress: { message: `Processing 1/${fileCount}...`, percent: 5 },
        extractionLogs: [],
      });
      await this.renderMessages();

      const extractionController = new AbortController();
      this.activeAbortControllers.set(extractionMsgIndex, extractionController);

      const updateExtractionProgress = (message: string, percent: number) => {
        if (!this.activeAbortControllers.has(extractionMsgIndex)) return;
        if (this.chatHistory[extractionMsgIndex]) {
          this.chatHistory[extractionMsgIndex].progress = { message, percent };
          this.updateProgressBar(extractionMsgIndex, { message, percent });
        }
      };

      const appendExtractionLog = this.makeLogAppender(extractionMsgIndex);

      let extractedCount = 0;
      let failedCount = 0;
      let cancelled = false;

      for (const attachment of filesToProcess) {
        if (extractionController.signal.aborted) { cancelled = true; break; }

        const fileName = attachment.file.name;
        const fileProgress = Math.round(5 + (extractedCount / fileCount) * 85);
        const isImage = ChatView.isImageFile(fileName);
        const icon = isImage ? '🖼️' : '📄';

        this.chatHistory[extractionMsgIndex].content =
          `${icon} Processing (${extractedCount + 1}/${fileCount}): ${fileName}...`;
        updateExtractionProgress(
          `${icon} ${extractedCount + 1}/${fileCount}: ${fileName}`,
          fileProgress
        );

        try {
          let text = "";

          if (attachment.extracted && attachment.content) {
            text = attachment.content;
          } else if (isImage) {
            let absolutePath: string;
            if (attachment.file instanceof TFile) {
              const vaultBase = this.getVaultAbsolutePath();
              absolutePath = vaultBase ? `${vaultBase}/${attachment.file.path}` : attachment.file.path;
            } else {
              const evidencePath = normalizePath(`${this.plugin.entityManager.getBasePath()}/Evidence`);
              await ensureFolderExists(this.app, evidencePath);
              const destPath = this.getAvailableEvidencePath(evidencePath, fileName);
              const buffer = await (attachment.file as File).arrayBuffer();
              const tFile = await this.app.vault.createBinary(destPath, buffer);
              const vaultBase = this.getVaultAbsolutePath();
              absolutePath = vaultBase ? `${vaultBase}/${tFile.path}` : tFile.path;
            }

            text = await this.plugin.graphApiService.extractTextFromImage(
              absolutePath,
              extractionController.signal,
              {
                emit: appendExtractionLog,
                rawCli: this.plugin.settings.extractionDebugRawCli,
              },
            );
          } else if (attachment.file instanceof TFile) {
            const ext = (attachment.file.extension || '').toLowerCase();
            if (ChatView.TEXT_EXTENSIONS.has(ext)) {
              text = await this.app.vault.read(attachment.file);
            } else {
              const arrayBuffer = await this.app.vault.readBinary(attachment.file);
              const blob = new Blob([arrayBuffer]);
              const syntheticFile = new File([blob], attachment.file.name, { type: 'application/octet-stream' });
              text = await this.plugin.graphApiService.extractTextFromFile(syntheticFile);
            }
          } else {
            text = await this.plugin.graphApiService.extractTextFromFile(attachment.file);
          }

          extractedContents.push(`\n\n--- Content from ${fileName} ---\n${text}`);
          processedFileNames.push(fileName);
          extractedCount++;

        } catch (error) {
          failedCount++;
          console.error(`Error extracting ${fileName}:`, error);

          const errorStr = error instanceof Error ? error.message : String(error);
          if (errorStr.includes('Aborted') || errorStr.includes('Cancelled')) {
            cancelled = true;
            break;
          }

          const userMessage = `${fileName}: ${errorStr}`;
          new Notice(userMessage, 8000);
        }
      }

      this.activeAbortControllers.delete(extractionMsgIndex);

      if (cancelled) {
        if (this.chatHistory[extractionMsgIndex]) {
          this.chatHistory[extractionMsgIndex].progress = undefined;
          this.chatHistory[extractionMsgIndex].content = `❌ **File extraction cancelled.**`;
        }
        // The message and the files come back; cancelling extraction is not discarding
        // the prompt the user typed.
        this.restoreDraft(draft, filesToProcess);
        await this.renderMessages();
        return;
      }

      if (extractedCount > 0) {
        if (extractionMsgIndex < this.chatHistory.length) {
          this.chatHistory.splice(extractionMsgIndex, 1);
        }
      } else {
        if (extractionMsgIndex < this.chatHistory.length && this.chatHistory[extractionMsgIndex]) {
          this.chatHistory[extractionMsgIndex].progress = undefined;
          this.chatHistory[extractionMsgIndex].content =
            `❌ Failed to extract text from ${failedCount} file${failedCount > 1 ? 's' : ''}. Please try again.`;
        } else {
          this.chatHistory.push({
            role: "assistant",
            content: `❌ Failed to extract text from ${failedCount} file${failedCount > 1 ? 's' : ''}. Please try again.`,
          });
        }
        this.restoreDraft(draft, filesToProcess);
        await this.renderMessages();
        return;
      }

      attachmentsContext = extractedContents.join('\n');
      processingValue = processingValue + attachmentsContext;
      this.warnIfAttachmentContextIsLarge(attachmentsContext);

      if (processedFileNames.length > 0) {
        const fileList = processedFileNames.map(f => {
          const icon = ChatView.isImageFile(f) ? '🖼️' : '📎';
          return `${icon} ${f}`;
        }).join('\n');
        displayValue = displayValue ? `${displayValue}\n\n${fileList}` : fileList;
      }

      if (extractedCount > 0 && failedCount === 0) {
        new Notice(`Processed ${extractedCount} file${extractedCount > 1 ? 's' : ''}`);
      } else if (extractedCount > 0 && failedCount > 0) {
        new Notice(`Processed ${extractedCount} file${extractedCount > 1 ? 's' : ''}, ${failedCount} failed`);
      }
    }

    // Add user message to chat (shows file names, NOT content)
    this.chatHistory.push({ role: "user", content: displayValue });

    // Save conversation after user message
    await this.saveCurrentConversation();

    if (this.selectedTaskAgentId.trim()) {
      await this.handleVaultTaskAgent(processingValue);
    } else {
      const orchestrationQuery = value || "Extract entities and relationships from the attached content.";
      await this.handleOrchestrationAgent(orchestrationQuery, attachmentsContext);
    }

    // Save conversation after assistant response
    await this.saveCurrentConversation();
  }

  async handleVaultTaskAgent(query: string) {
    const assistantIndex = this.chatHistory.length;
    this.chatHistory.push({
      role: "assistant",
      content: "",
      progress: { message: "Running task agent (local AI CLI)...", percent: 15 },
    });
    await this.renderMessages();

    const controller = new AbortController();
    try {
      this.activeAbortControllers.set(assistantIndex, controller);

      const id = this.selectedTaskAgentId.trim();
      const manifest = await this.plugin.taskAgentRegistry.getById(id);
      if (!manifest) {
        this.chatHistory[assistantIndex].content = `Unknown task agent: \`${id}\`. Check the task agents folder and settings.`;
        this.chatHistory[assistantIndex].progress = undefined;
        this.activeAbortControllers.delete(assistantIndex);
        await this.renderMessages();
        return;
      }
      if (!isTaskAgentRunnable(manifest, this.plugin.settings)) {
        this.chatHistory[assistantIndex].content =
          `Task agent **${manifest.name}** is disabled. Enable it under Settings → Task agents.`;
        this.chatHistory[assistantIndex].progress = undefined;
        this.activeAbortControllers.delete(assistantIndex);
        await this.renderMessages();
        return;
      }

      const { assistantText } = await this.plugin.taskAgentRunner.run(
        manifest,
        query,
        controller.signal,
      );
      this.activeAbortControllers.delete(assistantIndex);
      this.chatHistory[assistantIndex].content = assistantText;
      this.chatHistory[assistantIndex].progress = undefined;
      await this.renderMessages();
    } catch (e) {
      // handleCancel() already finalizes content/progress for a genuine user cancel — it
      // aborts this exact controller synchronously before this catch runs. Checking the
      // controller's own signal (rather than map membership, which the success path also
      // mutates) avoids misclassifying an unrelated later error as a cancel.
      const wasUserCancelled = controller.signal.aborted;
      this.activeAbortControllers.delete(assistantIndex);
      const msg = e instanceof Error ? e.message : String(e);
      if (wasUserCancelled || msg === "Cancelled by user") return;
      this.chatHistory[assistantIndex].content = `Task agent error: ${msg}`;
      this.chatHistory[assistantIndex].progress = undefined;
      await this.renderMessages();
    }
  }

  async handleOrchestrationAgent(query: string, attachmentsContext: string = "") {
    const assistantIndex = this.chatHistory.length;

    const pendingItem: ChatHistoryItem = {
      role: "assistant",
      content: "",
      progress: { message: "Starting unified agent…", percent: 10 }
    };
    this.chatHistory.push(pendingItem);
    await this.renderMessages();
    if (this.chatHistory[assistantIndex] !== pendingItem) return;

    const controller = new AbortController();
    const isLive = (): boolean =>
      this.chatHistory[assistantIndex] === pendingItem &&
      this.activeAbortControllers.get(assistantIndex) === controller;
    const releaseController = (): void => {
      if (this.activeAbortControllers.get(assistantIndex) === controller) {
        this.activeAbortControllers.delete(assistantIndex);
      }
    };

    const updateProgress = (message: string, percent: number, _meta?: OrchestrationProgressMeta) => {
      if (!isLive()) return;
      const item = this.chatHistory[assistantIndex];
      item.progress = { message, percent };
      this.updateProgressBar(assistantIndex, { message, percent });
    };

    // Live CLI activity shown in a collapsible log panel under the progress bar while the
    // agent is thinking, instead of only a single static progress line.
    const appendLiveAgentLog = this.makeLogAppender(assistantIndex);
    const appendAgentLog: typeof appendLiveAgentLog = (event) => {
      if (isLive()) appendLiveAgentLog(event);
    };

    try {
      this.activeAbortControllers.set(assistantIndex, controller);

      const currentGraphState = {
        entities: this.plugin.entityManager.getAllEntities(), // Send the current graph state
        connections: this.plugin.entityManager.getAllConnections() // Send connections to find orphaned nodes
      };

      // Extract conversational memory
      const conversationMemory = capConversationMemory(
        this.chatHistory
          .slice(0, assistantIndex) // All messages before this current pending assistant response
          .map(msg => ({ role: msg.role, content: msg.content })),
      );

      const result = await this.plugin.orchestrationService.processRequest(
        query,
        attachmentsContext,
        currentGraphState, // Also pass the graph state
        conversationMemory, // Send the memory history
        this.currentConversation,
        updateProgress,
        {
          abortSignal: controller.signal,
          onLog: appendAgentLog,
        }
      );

      releaseController();
      const item = this.chatHistory[assistantIndex];
      if (item !== pendingItem) return;
      // A cancel that landed while the CLI was already exiting: handleCancel has written
      // "Cancelled by user"; the late result must not overwrite it with an answer and
      // a set of proposals for a run the user threw away.
      if (controller.signal.aborted) return;

      item.content = result.finalResponse || "Done.";
      item.proposedModifications = result.proposedCommands;
      item.proposedCustomVaultOps = result.proposedCustomVaultOps;
      item.savedQuery = query; // Save query for tool execution
      item.progress = undefined;
      await this.renderMessages();

    } catch (e) {
      // handleCancel() already finalizes content/progress for a genuine user cancel — it
      // aborts this exact controller synchronously before this catch runs. Checking the
      // controller's own signal (rather than map membership, which the success path also
      // mutates) avoids misclassifying an unrelated later error as a cancel.
      const wasUserCancelled = controller.signal.aborted;
      releaseController();
      const item = this.chatHistory[assistantIndex];
      if (item !== pendingItem) return;
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (wasUserCancelled || errorMsg === 'Cancelled by user') return;

      item.content = `Orchestration Error: ${errorMsg}`;
      item.progress = undefined;
      await this.renderMessages();
    }
  }


  /**
   * Phase 2: Continue after the user has reviewed tool results.
   * Calls continueAfterToolReview on the OrchestrationService to synthesize + generate graph.
   */



  private buildGraphWriteContextFromSavedQuery(savedQuery: string | undefined): GraphWriteContext {
    const q = (savedQuery ?? "").trim() || "Graph modification apply";
    const extracted_urls = q.match(/(https?:\/\/[^\s]+)/g) ?? undefined;
    return {
      query: q,
      extracted_urls: extracted_urls ?? undefined,
      captured_at: new Date().toISOString(),
      conversation_id: this.currentConversation?.id,
    };
  }

  async applyProposedModifications(index: number, selectedIndices: number[]) {
    const item = this.chatHistory[index];
    if (!item.proposedModifications) return;

    const cmdsToExecute = item.proposedModifications.filter((_, idx) => selectedIndices.includes(idx));
    if (cmdsToExecute.length === 0) return;

    const graphWriteContext = this.buildGraphWriteContextFromSavedQuery(item.savedQuery);
    await this.plugin.orchestrationService.executeGraphModifications(cmdsToExecute, {
      graphWriteContext,
      skipConfirmation: true,
    });
    item.proposedModifications = undefined; // Clear after applying
    await this.renderMessages();
    await this.saveCurrentConversation();
  }

  async applyProposedCustomVaultOps(index: number, selectedIndices: number[]) {
    const item = this.chatHistory[index];
    if (!item.proposedCustomVaultOps?.length) return;
    const ops = item.proposedCustomVaultOps.filter((_, idx) => selectedIndices.includes(idx));
    if (ops.length === 0) return;
    try {
      const { applied, errors } = await applyCustomVaultOperations(this.plugin, ops);
      if (errors.length) {
        new Notice(`Applied ${applied} change(s). Errors: ${errors.join("; ")}`, 8000);
      } else {
        new Notice(`Applied ${applied} vault change(s).`);
      }
    } catch (e) {
      new Notice(`Vault apply failed: ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
    item.proposedCustomVaultOps = undefined;
    await this.renderMessages();
    await this.saveCurrentConversation();
  }

  /**
   * Handle Graph only Mode: Extract entities from user input text without sending to AI.
   * This mode is active when graphGenerationMode is ON and all main modes are OFF.
   */
  async handleGraphOnlyMode(inputText: string) {
    const messageIndex = this.chatHistory.length;
    this.chatHistory.push({
      role: "assistant",
      content: "🏷️ Extracting entities from your text...",
      progress: { message: "Analyzing text...", percent: 10 },
    });
    await this.renderMessages();

    const updateProgress = (message: string, percent: number) => {
      this.chatHistory[messageIndex].progress = { message, percent };
      this.chatHistory[messageIndex].content = `🏷️ ${message}`;
      this.updateProgressBar(messageIndex, { message, percent });
    };

    let controller: AbortController | undefined;
    try {
      const existingEntities = this.plugin.entityManager.getAllEntities();
      updateProgress("Checking existing entities...", 20);

      const onRetry = (attempt: number, maxAttempts: number, reason: string, nextDelayMs: number) => {
        const delaySeconds = Math.round(nextDelayMs / 1000);
        let reasonText = 'Network interrupted';
        if (reason === 'timeout') {
          reasonText = 'Request takes longer than usual, please wait';
        } else if (reason === 'network') {
          reasonText = 'Network connection lost';
        } else if (reason.startsWith('server-error')) {
          reasonText = 'Server temporarily unavailable';
        } else if (reason === 'rate-limited') {
          reasonText = 'Rate limited';
        }
        updateProgress(`⚠️ ${reasonText}. Retrying in ${delaySeconds}s... (${attempt + 1}/${maxAttempts})`, 25);
      };

      updateProgress("Sending text to AI for entity extraction...", 30);

      const onChunkProgress = (chunkIndex: number, totalChunks: number, message: string) => {
        const chunkPercent = 30 + Math.round((chunkIndex / totalChunks) * 20);
        updateProgress(`📦 ${message}`, chunkPercent);
      };

      // Create AbortController so the cancel button in the progress bar works
      controller = new AbortController();
      this.activeAbortControllers.set(messageIndex, controller);
      this.updateProgressBar(messageIndex, { message: "Sending text to AI for entity extraction...", percent: 30 });

      const result: ProcessTextResponse = await this.plugin.graphApiService.processTextInChunks(
        inputText,
        existingEntities,
        undefined,
        onChunkProgress,
        onRetry,
        controller.signal
      );

      this.activeAbortControllers.delete(messageIndex); // Clean up after success

      updateProgress("Processing API response...", 50);

      if (!result.success) {
        this.chatHistory[messageIndex].progress = undefined; // Clear progress bar
        this.chatHistory[messageIndex].content =
          `🏷️ **Graph Generation Failed**\n\n` +
          `**Input:** ${inputText.substring(0, 100)}${inputText.length > 100 ? '...' : ''}\n\n` +
          `**Error:** ${result.error || 'Unknown error'}`;
        await this.renderMessages();
        return;
      }

      if (!result.operations || result.operations.length === 0) {
        this.chatHistory[messageIndex].progress = undefined; // Clear progress bar
        this.chatHistory[messageIndex].content =
          `🏷️ **Graph Generation Complete**\n\n` +
          `**Input:** ${inputText.substring(0, 200)}${inputText.length > 200 ? '...' : ''}\n\n` +
          `No entities detected in the provided text.`;
        await this.renderMessages();
        return;
      }

      const proposedCommands: string[] = [];

      for (let opIdx = 0; opIdx < result.operations.length; opIdx++) {
        const operation = result.operations[opIdx];
        const opEntities = operation.entities || [];

        if (operation.action === "create" && operation.entities) {
          for (const ent of operation.entities) {
            const label = getEntityLabel(ent.type as EntityType, ent.properties || {});
            proposedCommands.push(`@@create_entity ${JSON.stringify({
              type: ent.type,
              properties: ent.properties,
              label,
              sources: ent.sources,
            })}`);
          }
        }

        if (operation.connections) {
          for (const conn of operation.connections) {
            let fromLabel = conn.from_label;
            let toLabel = conn.to_label;

            if (!fromLabel && opEntities[conn.from]) {
              const ent = opEntities[conn.from];
              fromLabel = getEntityLabel(ent.type as EntityType, ent.properties || {});
            }
            if (!toLabel && opEntities[conn.to]) {
              const ent = opEntities[conn.to];
              toLabel = getEntityLabel(ent.type as EntityType, ent.properties || {});
            }

            if (fromLabel && toLabel) {
              proposedCommands.push(`@@create_link ${JSON.stringify({
                from: fromLabel,
                to: toLabel,
                relationship: conn.relationship,
                sources: conn.sources,
              })}`);
            }
          }
        }
      }

      if (proposedCommands.length === 0) {
        this.chatHistory[messageIndex].progress = undefined;
        this.chatHistory[messageIndex].content =
          `🏷️ **Graph Generation Complete**\n\n` +
          `**Input:** ${inputText.substring(0, 200)}${inputText.length > 200 ? '...' : ''}\n\n` +
          `No valid entities or relationships proposed.`;
        await this.renderMessages();
        return;
      }

      // Finalize the message with the proposed changes
      this.chatHistory[messageIndex].progress = undefined;
      this.chatHistory[messageIndex].content =
        `🏷️ **Extraction complete.** I've extracted ${proposedCommands.length} potential graph modifications from the text.\n\n` +
        `**Input:** ${inputText.substring(0, 150)}${inputText.length > 150 ? '...' : ''}\n\n` +
        `Please review and apply the changes below:`;

      this.chatHistory[messageIndex].proposedModifications = proposedCommands;
      this.chatHistory[messageIndex].savedQuery = inputText;

      await this.renderMessages();
      await this.saveCurrentConversation();
    } catch (error) {
      // handleCancel() already finalizes content/progress for a genuine user cancel — it
      // aborts this exact controller synchronously before this catch runs. Checking the
      // controller's own signal (rather than map membership, which the success path also
      // mutates) avoids misclassifying an unrelated later error as a cancel. No controller
      // means the failure happened before one was created, so it can't have been a cancel.
      const wasUserCancelled = controller?.signal.aborted ?? false;
      if (typeof messageIndex !== 'undefined') {
        this.activeAbortControllers.delete(messageIndex); // Ensure controller is cleared on error
      }
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Handle user cancellation gracefully
      if (wasUserCancelled || errorMsg === 'Cancelled by user') {
        return; // UI already handled by handleCancel
      }

      if (typeof messageIndex !== 'undefined' && this.chatHistory[messageIndex]) {
        this.chatHistory[messageIndex].progress = undefined; // Clear progress bar on error
        this.chatHistory[messageIndex].content =
          `🏷️ **Graph Generation Failed**\n\n` +
          `**Input:** ${inputText.substring(0, 100)}${inputText.length > 100 ? '...' : ''}\n\n` +
          `**Error:** ${errorMsg}`;
        await this.renderMessages();
      }
      new Notice(`Graph generation failed: ${errorMsg}`);
    }
  }

  /**
   * Case-insensitively resolve a raw AI-provided type string to its canonical
   * PascalCase EntityType, or null if no such entity type exists.
   * Local models (e.g. Ollama) are less reliable than cloud models at
   * preserving exact enum casing/whitespace, so this tolerates that.
   */
  private static canonicalEntityType(rawType: unknown): EntityType | null {
    if (typeof rawType !== 'string') return null;
    const normalized = rawType.trim().toLowerCase();
    const match = Object.values(EntityType).find((t) => t.toLowerCase() === normalized);
    return match ?? null;
  }



  async onClose() {
    this.abortAllActiveOperations();
  }
}
