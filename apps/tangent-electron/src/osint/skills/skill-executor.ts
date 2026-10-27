import type VaultAIPlugin from "../plugin/vault-ai-plugin";
import { executeEnricherHttp } from "../services/enrichers/enricher-executor";
import { isEnricherRunnable, parseEnrichToolId, type EnricherSpec } from "../services/enrichers/enricher-schema";

/** Why an enricher the registry has cannot run; thrown, so the turn counts it as failed. */
function notRunnableReason(spec: EnricherSpec): string {
	if (spec.status !== "active" || !spec.enabled) {
		const state = spec.status === "draft" ? "a draft" : spec.status === "active" ? "active but disabled" : "disabled";
		return `Enricher \`${spec.id}\` is ${state}, so no request was made. Only an active enricher can run: check its spec, then activate it with the "Set HTTP enricher enabled state" command.`;
	}
	return `Enricher \`${spec.id}\` has no request URL (request.urlTemplate in its spec), so no request was made.`;
}

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
	// The model only sees active enrichers, but it can name any id; a draft or a disabled
	// one has not been approved to send requests.
	if (!isEnricherRunnable(spec)) throw new Error(notRunnableReason(spec));
	return executeEnricherHttp(
		spec,
		query,
		attachmentsContext,
		signal,
		plugin.settings.credentialsFolder,
	);
}
