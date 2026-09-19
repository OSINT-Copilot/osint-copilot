import type VaultAIPlugin from "../plugin/vault-ai-plugin";
import { Notice } from 'obsidian';
import type { UrlExtractFailure } from './api-service';
import {
    type Entity,
    EntityType,
    getEntityLabel,
    isFTMSchema,
    type GraphWriteContext,
    type OsintSourceInput,
} from '../entities/types';
import { buildInferredOsintSources } from './osint-confidence-engine';
import { executeEnricherTool } from '../skills/skill-executor';
import { ENRICHER_INVOCATION_SPACING_MS } from './enrichers/enricher-executor';
import { enrichToolId } from './enrichers/enricher-schema';
import { createAgentProvider } from './agent-runtime/create-agent-provider';
import { HermesAgentProvider } from './agent-runtime/hermes-agent-provider';
import type { AgentTurnContext } from './agent-runtime/provider-types';
import { aiOperationsToGraphCommands } from './graph-commands-from-operations';
import { resolveEntityImage, type ResolvedEntityImage } from './entity-image-service';
import type { CustomVaultOperation } from './custom-vault-operations';
import type { ExtractionLogOptions, ExtractionLogEvent } from './claude-code-service';

export interface OrchestrationResult {
    finalResponse: string;
    proposedCommands?: string[];
    /** Unified agent: proposed skill/credential file ops (applied only after user confirms in chat). */
    proposedCustomVaultOps?: CustomVaultOperation[];
    phase?: "SYNTHESIS_COMPLETE";
}

/** Optional metadata for orchestration progress callbacks (multi-tool UI). */
export interface OrchestrationProgressMeta {
    orchestrationTool?: string;
}

export interface ProcessRequestOptions {
    abortSignal?: AbortSignal;
    /** Live CLI log events for the "agent is thinking" panel under the chat progress bar. */
    onLog?: (event: ExtractionLogEvent) => void;
}

/** Options for applying @@ graph commands (provenance context when sources are omitted). */
export interface ExecuteGraphCommandsOptions {
    showErrorNotices: boolean;
    graphWriteContext?: GraphWriteContext;
}

/** Resolve target entity for @@update_entity (id preferred, else type+label, else label-only). */
function findEntityForGraphUpdate(
    em: { getEntity: (id: string) => Entity | undefined; getAllEntities: () => Entity[]; findEntityByLabel: (l: string) => Entity | undefined },
    data: { id?: string; type?: string; current_label?: string },
): Entity | undefined {
    if (data.id) {
        const byId = em.getEntity(data.id);
        if (byId) return byId;
    }
    if (data.type && data.current_label) {
        const wantType = String(data.type).trim().toLowerCase();
        const wantLabel = data.current_label.trim().toLowerCase();
        for (const e of em.getAllEntities()) {
            if (String(e.type).trim().toLowerCase() !== wantType) continue;
            const el = e.label != null ? String(e.label).trim().toLowerCase() : '';
            if (el === wantLabel) return e;
        }
    }
    if (data.current_label) {
        return em.findEntityByLabel(data.current_label);
    }
    return undefined;
}

export interface ExecuteGraphModificationsOptions {
    graphWriteContext?: GraphWriteContext;
}

function isAbortError(error: unknown): boolean {
    return typeof error === "object" && error !== null &&
        "name" in error && (error as { name?: unknown }).name === "AbortError";
}

export class OrchestrationService {
    private plugin: VaultAIPlugin;

    constructor(plugin: VaultAIPlugin) {
        this.plugin = plugin;
    }

    public async processRequest(
        query: string,
        attachmentsContext: string,
        currentGraphState: any,
        conversationMemory: { role: string, content: string }[],
        onProgress: (msg: string, percent: number, meta?: OrchestrationProgressMeta) => void,
        options?: ProcessRequestOptions
    ): Promise<OrchestrationResult> {
        try {
            return await this.processRequestUnified(
                query,
                attachmentsContext,
                currentGraphState,
                conversationMemory,
                onProgress,
                options,
            );
        } catch (error) {
            if (isAbortError(error)) throw error;
            console.error("[OrchestrationService] Error:", error);
            this.handleError(error);
            throw error;
        }
    }

    private buildGraphEntitiesSummary(graphState: any): string {
        const entities = graphState?.entities;
        if (!Array.isArray(entities) || entities.length === 0) {
            return "Empty graph.";
        }
        const lines = entities
            .slice(0, 50)
            .map((e: { type?: string; label?: string; id?: string }) => `- ${e.type ?? "?"}: ${e.label ?? e.id ?? "?"}`);
        if (entities.length > 50) {
            lines.push(`... and ${entities.length - 50} more entities`);
        }
        return lines.join("\n");
    }

    /**
     * Single local agent turn: vault search + graph extraction via the external agent's skills.
     */
    private async processRequestUnified(
        query: string,
        attachmentsContext: string,
        currentGraphState: any,
        conversationMemory: { role: string, content: string }[],
        onProgress: (msg: string, percent: number, meta?: OrchestrationProgressMeta) => void,
        options?: ProcessRequestOptions,
    ): Promise<OrchestrationResult> {
        const checkAborted = () => {
            if (options?.abortSignal?.aborted) {
                throw new DOMException("Aborted", "AbortError");
            }
        };

        checkAborted();
        onProgress("Preparing unified local agent...", 10);

        let ctx = attachmentsContext;
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urlMatches = query.match(urlRegex);
        const urls = urlMatches ? [...new Set(urlMatches)] : null;
        if (urls && urls.length > 0) {
            onProgress(`Extracting content from ${urls.length} unique link(s)...`, 15);
            for (const url of urls) {
                checkAborted();
                const extracted = await this.plugin.graphApiService.tryExtractTextFromUrl(url);
                if (extracted.ok) {
                    ctx += `\n\n=== Content from ${url} ===\n${extracted.text}`;
                } else {
                    let host = '';
                    try {
                        host = new URL(url).hostname;
                    } catch {
                        host = '';
                    }
                    console.debug(
                        `[OrchestrationService] URL not loaded${host ? ` (${host})` : ''}: ${(extracted as UrlExtractFailure).shortMessage}`,
                    );
                    ctx += `\n\n=== Linked URL (not loaded) ===\n${url}\nThe page could not be fetched automatically (e.g. login required or bot protection). Paste the text you want analyzed into the chat.\n(${(extracted as UrlExtractFailure).shortMessage})`;
                }
            }
        }

        onProgress("Running unified agent...", 35);
        checkAborted();

        let vaultAug = "";
        try {
            vaultAug = (await this.plugin.vaultPromptLoader?.getOrchestrationAugmentation()) ?? "";
        } catch (e) {
            console.warn("[OrchestrationService] vault prompts:", e);
        }

        let availableEnricherIds: string[] = [];
        try {
            const runnable = await this.plugin.enricherRegistry.listRunnable();
            availableEnricherIds = runnable.map((e) => e.id);
        } catch (e) {
            console.warn("[OrchestrationService] enricher registry:", e);
        }

        const agentCtx: AgentTurnContext = {
            query,
            attachmentsContext: ctx,
            graphEntitiesSummary: this.buildGraphEntitiesSummary(currentGraphState),
            conversationMemory,
            vaultAugmentation: vaultAug,
            availableEnricherIds,
            enrichersFolderDisplay: this.plugin.settings.enrichersFolder,
        };

        const provider = createAgentProvider(this.plugin);
        const logOptions: ExtractionLogOptions | undefined = options?.onLog
            ? { emit: options.onLog, rawCli: this.plugin.settings.extractionDebugRawCli }
            : undefined;
        try {
            const turn = await provider.runTurn(agentCtx, options?.abortSignal, (msg, pct) => onProgress(msg, pct), logOptions);
            checkAborted();

            let answer = turn.answer_markdown || "";
            if (turn.retrieval_hits?.length) {
                const srcLines = turn.retrieval_hits
                    .map((h) => {
                        const sn = h.snippet ? ` — _${h.snippet.slice(0, 200)}${h.snippet.length > 200 ? "…" : ""}_` : "";
                        // A wikilink, not a code span: the transcript resolves these to the note.
                        return `- [[${h.path}]]${sn}`;
                    })
                    .join("\n");
                answer += `\n\n### Retrieval\n${srcLines}`;
            }

            if (turn.enricher_invocations?.length) {
                const n = turn.enricher_invocations.length;
                const blocks: string[] = [];
                let enricherOk = 0;
                let enricherFail = 0;
                for (let i = 0; i < n; i++) {
                    const inv = turn.enricher_invocations[i];
                    const pct = 55 + Math.round(((i + 0.5) / n) * 38);
                    onProgress(`Enricher ${i + 1}/${n} (${inv.enricher_id})…`, Math.min(93, pct));
                    checkAborted();
                    const toolId = enrichToolId(inv.enricher_id);
                    const querySnippet =
                        inv.query.length > 120 ? `${inv.query.slice(0, 117)}…` : inv.query;
                    const heading = `### Enricher \`${inv.enricher_id}\` — \`${querySnippet.replace(/`/g, "'")}\``;
                    try {
                        const out = await executeEnricherTool(
                            this.plugin,
                            toolId,
                            inv.query,
                            ctx,
                            options?.abortSignal,
                        );
                        if (out.includes("Unknown enricher")) enricherFail++;
                        else enricherOk++;
                        blocks.push(`${heading}\n\n${out}`);
                    } catch (err) {
                        enricherFail++;
                        const msg = err instanceof Error ? err.message : String(err);
                        blocks.push(`${heading}\n\n**Error:** ${msg}`);
                    }
                    if (i < n - 1 && ENRICHER_INVOCATION_SPACING_MS > 0) {
                        await new Promise((r) => setTimeout(r, ENRICHER_INVOCATION_SPACING_MS));
                    }
                }
                if (blocks.length) {
                    let statusLine = "";
                    if (enricherOk > 0 && enricherFail === 0) {
                        statusLine = `\n\n**Plugin status:** ${enricherOk} enricher call(s) completed.\n\n`;
                    } else if (enricherFail > 0 && enricherOk === 0) {
                        statusLine = `\n\n**Plugin status:** No enricher HTTP requests succeeded (${enricherFail} failed). The assistant text above may still describe success — rely on this section.\n\n`;
                    } else if (enricherOk > 0 && enricherFail > 0) {
                        statusLine = `\n\n**Plugin status:** ${enricherOk} succeeded, ${enricherFail} failed — verify \`enricher_id\` matches each JSON \`id\`.\n\n`;
                    }
                    answer += `\n\n---\n\n## Enricher results${statusLine}${blocks.join("\n\n---\n\n")}`;
                }
            }

            let proposedCommands: string[] | undefined;
            if (this.plugin.settings.enableGraphFeatures && turn.graph_operations?.length) {
                proposedCommands = aiOperationsToGraphCommands(turn.graph_operations);
            }

            const proposedCustomVaultOps =
                turn.custom_vault_operations?.length ? turn.custom_vault_operations : undefined;

            onProgress("Complete", 100);
            return {
                finalResponse: answer,
                proposedCommands,
                proposedCustomVaultOps,
                phase: "SYNTHESIS_COMPLETE",
            };
        } catch (e) {
            if (isAbortError(e)) {
                throw e;
            }
            const msg = e instanceof Error ? e.message : String(e);
            console.error("[OrchestrationService] Unified agent failed:", e);
            onProgress("Complete", 100);
            // HermesAgentProvider.id is always the shared literal 'hermes-agent' for both the
            // built-in Hermes runtime and every user-defined custom runtime -- use its cfg's
            // displayName so the error names the actual configured runtime instead.
            const providerLabel =
                provider instanceof HermesAgentProvider ? provider.cfg.displayName : provider.id;
            return {
                finalResponse: `**Unified agent error (${providerLabel})**\n\n${msg}`,
                phase: "SYNTHESIS_COMPLETE",
            };
        }
    }

    /**
     * Turns an entity's image_url / image into a vault path before the entity is written.
     *
     * Writes beside the Evidence tree the graph's own file drop already uses, so an
     * analyst has one place to look for the pictures attached to a case rather than three.
     *
     * Swallows everything. resolveEntityImage does not throw on its own, but the folder
     * lookup that feeds it touches the plugin, and a half-started plugin must not turn
     * "create these entities" into an exception.
     */
    private async resolveEntityPicture(
        properties: Record<string, unknown>,
    ): Promise<ResolvedEntityImage> {
        try {
            const base = this.plugin.entityManager.getBasePath();
            return await resolveEntityImage(
                { app: this.plugin.app, folder: `${base}/Evidence` },
                properties,
            );
        } catch (error) {
            console.error('[osint] could not resolve an entity picture', error);
            return { properties, outcome: { kind: 'none' } };
        }
    }

    /** Apply @@ graph commands without a confirmation modal. Returns one human-readable line per command. */
    public async executeGraphCommandsImmediate(
        commands: string[],
        options: ExecuteGraphCommandsOptions,
    ): Promise<string[]> {
        const lines: string[] = [];
        const ctx = options.graphWriteContext;

        for (const command of commands) {
            try {
                if (command.startsWith("@@create_entity")) {
                    const jsonStr = command.replace("@@create_entity", "").trim();
                    const data = JSON.parse(jsonStr);
                    if (data.type && data.properties) {
                        let rawSources = data.sources as OsintSourceInput[] | undefined;
                        if (!Array.isArray(rawSources) || rawSources.length === 0) {
                            rawSources = buildInferredOsintSources(ctx);
                        }
                        const osintOpts = {
                            osint_sources: rawSources,
                            osint_captured_at: ctx?.captured_at ?? new Date().toISOString(),
                            conversation_id: ctx?.conversation_id,
                        };
                        // Before the write, so the note is saved with a path that resolves
                        // rather than a URL the graph cannot draw. Never throws: an entity
                        // without a picture is still a good entity, and one unreachable
                        // host must not take the rest of the batch with it.
                        const picture = await this.resolveEntityPicture(data.properties);
                        const properties = picture.properties;
                        // Re-running extraction over the same text proposes the same entities
                        // again. A same-label create used to overwrite the existing note, which
                        // also threw away its id, sources and any edits; it now gets its own
                        // file instead, so an entity this batch already knows is merged into:
                        // its sources are appended and only properties it lacks are filled in.
                        const existing = this.plugin.entityManager.findExistingEntity(String(data.type), properties || {});
                        if (existing) {
                            const em = this.plugin.entityManager;
                            const merged = await em.appendOsintSources(existing.id, rawSources, {
                                captured_at: osintOpts.osint_captured_at,
                                conversation_id: osintOpts.conversation_id,
                            });
                            const missing: Record<string, unknown> = {};
                            // Values that differ from what the entity already has are not
                            // applied (the investigator's value wins), but they are named in
                            // the response so a correction is not dropped without a word.
                            const kept: string[] = [];
                            for (const [k, v] of Object.entries(properties || {})) {
                                const cur = existing.properties[k];
                                if (v === undefined || v === null || v === '') continue;
                                if (cur === undefined || cur === null || cur === '') {
                                    missing[k] = v;
                                } else if (JSON.stringify(cur) !== JSON.stringify(v)) {
                                    kept.push(k);
                                }
                            }
                            const updated = merged && Object.keys(missing).length > 0
                                ? await em.updateEntity(existing.id, missing)
                                : merged;
                            const keptNote = kept.length > 0
                                ? ` (kept existing ${kept.join(', ')}; proposed values differ)`
                                : '';
                            lines.push(updated
                                ? `✓ Merged into existing ${data.type}: **${updated.label}**${keptNote}`
                                : `⚠ Skipped (locked): **${existing.label}**`);
                            continue;
                        }
                        if (isFTMSchema(String(data.type))) {
                            await this.plugin.entityManager.createFTMEntity(data.type, properties, osintOpts);
                        } else {
                            await this.plugin.entityManager.createEntity(data.type, properties, osintOpts);
                        }
                        const name = data.label || getEntityLabel(data.type as EntityType, properties || {});
                        // Say when a promised picture did not arrive. "The AI said it added
                        // a photo and there is no photo" is the confusing case worth words.
                        const note = picture.outcome.kind === 'downloaded' ? ' (image saved)'
                            : picture.outcome.kind === 'failed' ? ' (image unavailable)'
                            : '';
                        lines.push(`✓ Created ${data.type}: **${name}**${note}`);
                    }
                } else if (command.startsWith("@@delete_entity")) {
                    const jsonStr = command.replace("@@delete_entity", "").trim();
                    const data = JSON.parse(jsonStr);
                    if (data.id) {
                        const entity = this.plugin.entityManager.getEntity(data.id);
                        const name = entity ? entity.label : `ID: ${data.id}`;
                        if (entity?.filePath && this.plugin.vaultLockService?.isPathLocked(entity.filePath)) {
                            lines.push(`⚠ Skipped delete (locked): **${name}**`);
                        } else {
                            await this.plugin.entityManager.deleteEntities([data.id]);
                            lines.push(`✓ Removed entity: **${name}**`);
                        }
                    }
                } else if (command.startsWith("@@update_entity")) {
                    const jsonStr = command.replace("@@update_entity", "").trim();
                    const data = JSON.parse(jsonStr) as {
                        id?: string;
                        type?: string;
                        current_label?: string;
                        new_properties?: Record<string, unknown>;
                    };
                    if (data.new_properties && typeof data.new_properties === "object") {
                        const entity = findEntityForGraphUpdate(this.plugin.entityManager, data);
                        if (!entity) {
                            lines.push(
                                `⚠ Skipped update: no entity matched id/type+label/label (${JSON.stringify({ id: data.id, type: data.type, current_label: data.current_label })})`,
                            );
                        } else if (entity.filePath && this.plugin.vaultLockService?.isPathLocked(entity.filePath)) {
                            lines.push(`⚠ Skipped update (locked): **${entity.label}**`);
                        } else {
                            const updated = await this.plugin.entityManager.updateEntity(entity.id, data.new_properties);
                            if (updated) {
                                lines.push(`✓ Updated **${updated.label}** (${String(updated.type)})`);
                            } else {
                                lines.push(`⚠ Update failed for **${entity.label}**`);
                            }
                        }
                    }
                } else if (command.startsWith("@@create_link")) {
                    const jsonStr = command.replace("@@create_link", "").trim();
                    const data = JSON.parse(jsonStr);
                    if (data.from && data.to && data.relationship) {
                        let fromId = data.from;
                        let toId = data.to;

                        if (!this.plugin.entityManager.getEntity(fromId)) {
                            const fromEnt = this.plugin.entityManager.findEntityByLabel(data.from);
                            if (fromEnt) fromId = fromEnt.id;
                        }

                        if (!this.plugin.entityManager.getEntity(toId)) {
                            const toEnt = this.plugin.entityManager.findEntityByLabel(data.to);
                            if (toEnt) toId = toEnt.id;
                        }

                        let rawSources = data.sources as OsintSourceInput[] | undefined;
                        if (!Array.isArray(rawSources) || rawSources.length === 0) {
                            rawSources = buildInferredOsintSources(ctx);
                        }
                        const osintOpts = {
                            osint_sources: rawSources,
                            osint_captured_at: ctx?.captured_at ?? new Date().toISOString(),
                            conversation_id: ctx?.conversation_id,
                        };
                        await this.plugin.entityManager.createConnection(
                            fromId,
                            toId,
                            data.relationship,
                            data.properties as Record<string, unknown> | undefined,
                            osintOpts,
                        );
                        const fromEnt = this.plugin.entityManager.getEntity(fromId);
                        const toEnt = this.plugin.entityManager.getEntity(toId);
                        const fromName = fromEnt ? fromEnt.label : String(data.from);
                        const toName = toEnt ? toEnt.label : String(data.to);
                        lines.push(`✓ Link: **${fromName}** → (${data.relationship}) → **${toName}**`);
                    }
                } else if (command.startsWith("@@delete_link")) {
                    const jsonStr = command.replace("@@delete_link", "").trim();
                    const data = JSON.parse(jsonStr);
                    if (data.id) {
                        const conn = this.plugin.entityManager.getConnection(data.id);
                        const locked =
                            (conn?.filePath && this.plugin.vaultLockService?.isPathLocked(conn.filePath)) ||
                            false;
                        if (locked) {
                            lines.push(`⚠ Skipped delete link (locked): id ${data.id}`);
                        } else {
                            await this.plugin.entityManager.deleteConnectionWithNote(data.id);
                            lines.push(`✓ Removed link (id ${data.id})`);
                        }
                    }
                } else {
                    console.warn(`[OrchestrationService] Unrecognized graph command: ${command}`);
                    lines.push(`⚠ Skipped unrecognized command`);
                }
            } catch (e) {
                console.error(`[OrchestrationService] Failed to execute graph command '${command}':`, e);
                const msg = e instanceof Error ? e.message : String(e);
                lines.push(`⚠ Failed: ${msg.substring(0, 120)}${msg.length > 120 ? "…" : ""}`);
                if (options.showErrorNotices) {
                    new Notice(`Error executing command: ${command.substring(0, 30)}...`);
                }
            }
        }

        return lines;
    }

    public async executeGraphModifications(
        commands: string[],
        execOptions?: ExecuteGraphModificationsOptions,
    ): Promise<void> {
        if (!commands || commands.length === 0) return;

        const lines = await this.executeGraphCommandsImmediate(commands, {
            showErrorNotices: true,
            graphWriteContext: execOptions?.graphWriteContext,
        });
        const successCount = lines.filter((l) => l.startsWith("✓")).length;

        if (successCount > 0) {
            new Notice(`Successfully executed ${successCount} graph modification(s).`);
            await this.plugin.refreshOpenInsightViews();
        }
    }

    private handleError(error: unknown): void {
        const errorMsg = error instanceof Error ? error.message : String(error);
        new Notice(`Orchestrator Error: ${errorMsg}`);
    }
}
