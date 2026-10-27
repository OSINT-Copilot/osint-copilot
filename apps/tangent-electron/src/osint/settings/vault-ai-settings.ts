import type { CustomAgentRuntime } from "../services/agent-runtime/runtime-registry";
import {
	CLAUDE_RUNTIME_ID,
} from "../services/agent-runtime/runtime-registry";
import type { EnabledSchemaFamilies } from "../services/schema-catalog-types";
import {
	DEFAULT_ENABLED_SCHEMA_FAMILIES,
	DEFAULT_OIDSF_MODAL_LAYERS,
	type OIDSFModalLayers,
} from "../services/schema-catalog-types";
import {
	DEFAULT_CONVERSATION_FOLDER,
	DEFAULT_CREDENTIALS_FOLDER,
	DEFAULT_ENRICHERS_FOLDER,
	DEFAULT_PROMPTS_FOLDER,
	DEFAULT_SCRIPTS_FOLDER,
	DEFAULT_SKILLS_FOLDER,
	DEFAULT_TASK_AGENTS_FOLDER,
	DEFAULT_TASK_AGENT_OUTPUT_ALLOWLIST,
} from "../constants/vault-layout";

/**
 * Where the toolbar's view buttons put a view in the thread.
 *
 * 'switch': a view takes over the whole thread, so the window shows one thing at a time --
 * a note, or a view, never both side by side.
 * 'alongside': every view opens as an extra pane beside the current one, which stacks a
 * new column per click.
 */
export type OsintViewOpenMode = 'switch' | 'alongside';

export interface VaultAISettings {
	systemPrompt: string;
	maxNotes: number;
	viewOpenMode: OsintViewOpenMode;
	enableGraphFeatures: boolean;
	autoRefreshGraph: boolean;
	autoOpenGraphOnEntityCreation: boolean;
	conversationFolder: string;
	promptsFolder: string;
	activeAgentId: string;
	taskAgentsFolder: string;
	taskAgentsEnabled: boolean;
	preferredTaskAgentId: string;
	taskAgentGlobalOutputAllowlist: string;
	taskAgentOverrides: Record<string, boolean>;
	skillsFolder: string;
	enrichersFolder: string;
	credentialsFolder: string;
	scriptsFolder: string;
	apiProvider: "claude-code" | "codex";
	claudeCodeCliPath: string;
	claudeCodeModel: string;
	claudeCodeExtraArgs: string;
	claudeCodeTimeoutMs: number;
	codexCliPath: string;
	codexCliModel: string;
	codexCliExtraArgs: string;
	codexCliTimeoutMs: number;
	agentRuntimeProvider: string;
	hermesAgentCliPath: string;
	hermesAgentExtraArgs: string;
	hermesAgentTimeoutMs: number;
	hermesAgentHealthCheckArgs: string;
	customAgentRuntimes: CustomAgentRuntime[];
	extractionLogVerbosity: "minimal" | "detailed";
	extractionDebugRawCli: boolean;
	lockedVaultPaths: string[];
	activeGraphId: string;
	graphWorkspaces: { id: string; name: string }[];
	/**
	 * Map basemap, defaulting to OpenFreeMap: MIT, no API key, no usage limits, and
	 * commercial use permitted, so it can ship switched on.
	 *
	 * Precedence at runtime is offline archive > online provider > coordinate grid, so
	 * configuring a PMTiles archive silently supersedes this without touching it, and an
	 * air-gapped machine still gets the grid.
	 *
	 * "none" stays available for analysts who must emit no tile traffic at all. It is a
	 * real consideration rather than a hypothetical: protomaps-leaflet fetches the vector
	 * tiles from the renderer, outside net-guard's allowlist (only the TileJSON goes
	 * through guarded IPC), so each tile is outbound HTTP carrying the z/x/y of what the
	 * analyst is looking at.
	 */
	mapOnlineTileProvider: "none" | "openfreemap" | "custom";
	/**
	 * Palette for vector basemaps -- online and offline alike, since both are drawn by
	 * our own rule set. "auto" follows the app theme.
	 */
	mapBasemapTheme: "auto" | "light" | "dark";
	/** Bumped when a map default changes in a way that must reach existing vaults. */
	mapSettingsVersion: number;
	mapCustomTileUrl: string;
	mapCustomTileAttribution: string;
	/** Display copy of the archive main remembers in userData; main is authoritative. */
	mapOfflineBasemapPath: string;
	/** Root URL of an operator-approved Nominatim-compatible service; empty disables geocoding. */
	geocodingBaseUrl: string;
	enabledSchemaFamilies: EnabledSchemaFamilies;
	oidsfModalLayers: OIDSFModalLayers;
	miroAccessToken: string;
	miroLastBoardInput: string;
	/**
	 * Whether the first-run tour has been shown.
	 *
	 * In settings rather than localStorage so it travels with the vault: opening the same
	 * case on a second machine should not replay the tour, and clearing browser storage
	 * should not resurrect it.
	 */
	hasSeenWelcomeGuide: boolean;
	/**
	 * Whether items the browser extension sends may be looked up on the Wayback Machine.
	 * Off by default: a lookup tells archive.org which pages this case is looking at.
	 * Per investigation, like everything here.
	 */
	extensionAllowWayback: boolean;
}

export const DEFAULT_SETTINGS: VaultAISettings = {
	systemPrompt:
		"You are a vault assistant. Answer questions clearly and concisely based on the provided notes. Cite note paths in-line where useful.",
	maxNotes: 15,
	viewOpenMode: 'switch',
	enableGraphFeatures: true,
	autoRefreshGraph: true,
	autoOpenGraphOnEntityCreation: false,
	conversationFolder: DEFAULT_CONVERSATION_FOLDER,
	promptsFolder: DEFAULT_PROMPTS_FOLDER,
	activeAgentId: "default",
	taskAgentsFolder: DEFAULT_TASK_AGENTS_FOLDER,
	taskAgentsEnabled: true,
	preferredTaskAgentId: "",
	taskAgentGlobalOutputAllowlist: DEFAULT_TASK_AGENT_OUTPUT_ALLOWLIST,
	taskAgentOverrides: {},
	skillsFolder: DEFAULT_SKILLS_FOLDER,
	enrichersFolder: DEFAULT_ENRICHERS_FOLDER,
	credentialsFolder: DEFAULT_CREDENTIALS_FOLDER,
	scriptsFolder: DEFAULT_SCRIPTS_FOLDER,
	apiProvider: "claude-code",
	claudeCodeCliPath: "claude",
	claudeCodeModel: "sonnet",
	claudeCodeExtraArgs: "",
	claudeCodeTimeoutMs: 300_000,
	codexCliPath: "codex",
	codexCliModel: "",
	codexCliExtraArgs: "",
	codexCliTimeoutMs: 300_000,
	agentRuntimeProvider: CLAUDE_RUNTIME_ID,
	hermesAgentCliPath: "hermes",
	hermesAgentExtraArgs: "",
	hermesAgentTimeoutMs: 120_000,
	hermesAgentHealthCheckArgs: "--version",
	customAgentRuntimes: [],
	extractionLogVerbosity: "detailed",
	extractionDebugRawCli: false,

	lockedVaultPaths: [],
	activeGraphId: "default",
	graphWorkspaces: [{ id: "default", name: "Default" }],
	mapOnlineTileProvider: "openfreemap",
	mapBasemapTheme: "auto",
	mapSettingsVersion: 1,
	mapCustomTileUrl: "",
	mapCustomTileAttribution: "",
	mapOfflineBasemapPath: "",
	geocodingBaseUrl: "",
	enabledSchemaFamilies: { ...DEFAULT_ENABLED_SCHEMA_FAMILIES },
	oidsfModalLayers: { ...DEFAULT_OIDSF_MODAL_LAYERS },
	miroAccessToken: "",
	miroLastBoardInput: "",
	hasSeenWelcomeGuide: false,
	extensionAllowWayback: false,
};
