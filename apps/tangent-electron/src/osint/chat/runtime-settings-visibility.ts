import { CLAUDE_RUNTIME_ID, CODEX_RUNTIME_ID, HERMES_RUNTIME_ID, isCustomRuntimeId } from "../services/agent-runtime/runtime-registry";

export interface RuntimeSettingsVisibility {
	showClaudeRuntimeHint: boolean;
	showCodexRuntimeHint: boolean;
	showHermesSettings: boolean;
	showSelectedCustomSettings: boolean;
}

export function runtimeSettingsVisibility(selectedRuntimeId: string): RuntimeSettingsVisibility {
	return {
		showClaudeRuntimeHint: selectedRuntimeId === CLAUDE_RUNTIME_ID,
		showCodexRuntimeHint: selectedRuntimeId === CODEX_RUNTIME_ID,
		showHermesSettings: selectedRuntimeId === HERMES_RUNTIME_ID,
		showSelectedCustomSettings: isCustomRuntimeId(selectedRuntimeId),
	};
}
