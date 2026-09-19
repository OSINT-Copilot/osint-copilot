import type VaultAIPlugin from "../plugin/vault-ai-plugin";
import { executeEnricherHttp } from "../services/enrichers/enricher-executor";
import { parseEnrichToolId } from "../services/enrichers/enricher-schema";

export async function executeEnricherTool(
	plugin: VaultAIPlugin,
	toolId: string,
	query: string,
	attachmentsContext: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const id = parseEnrichToolId(toolId);
	if (!id) return `Invalid enricher tool id: ${toolId}`;
	const spec = await plugin.enricherRegistry.getById(id);
	if (!spec) {
		const runnable = await plugin.enricherRegistry.listRunnable();
		const ids = runnable.map((e) => e.id).join(", ");
		const folder = plugin.settings.enrichersFolder?.trim() || "OSINTCopilot/custom/enrichers";
		const hint = ids
			? `\n\n**Available enricher ids** (use \`enricher_id\` exactly as in JSON — lowercase, hyphens): ${ids}`
			: `\n\nNo **active** enricher specs found under \`${folder}\`. Add or enable a JSON file; \`id\` must match \`enricher_id\`.`;
		return `Unknown enricher \`${id}\`.${hint}`;
	}
	return executeEnricherHttp(
		spec,
		query,
		attachmentsContext,
		signal,
		plugin.settings.credentialsFolder,
	);
}
