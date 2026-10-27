import type { CustomVaultOperation } from "../services/custom-vault-operations";
import type { ExtractionLogEvent } from "../services/claude-code-service";
import type { IndexedNote } from "./indexed-note";

export interface ChatHistoryItem {
	role: "user" | "assistant";
	content: string;
	/** Set once when the message is first persisted; preserved on every later save. */
	timestamp?: number;
	notes?: IndexedNote[];
	jobId?: string;
	status?: string;
	progress?: { message: string; percent: number };
	query?: string;
	reportFilePath?: string;
	usedEntities?: { id: string; label: string; type: string }[];
	proposedModifications?: string[];
	proposedCustomVaultOps?: CustomVaultOperation[];
	savedQuery?: string;
	extractionLogs?: ExtractionLogEvent[];
	extractionLogsExpanded?: boolean;
}
