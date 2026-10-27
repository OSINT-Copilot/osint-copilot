import type VaultAIPlugin from '../../plugin/vault-ai-plugin';
import { LocalCliAgentProvider } from './local-cli-agent-provider';
import { HermesAgentProvider } from './hermes-agent-provider';
import type { AgentProvider } from './provider-types';
import { CLAUDE_RUNTIME_ID, CODEX_RUNTIME_ID, HERMES_RUNTIME_ID, findCustomRuntime } from './runtime-registry';

/**
 * Only Hermes/custom runtimes need this (Claude/Codex CLIs get their cwd through their own
 * config path) -- resolved lazily, and defensively, so a test/mock plugin without a real `app`
 * doesn't break provider construction for runtimes that never touch it.
 */
function resolveVaultRoot(plugin: VaultAIPlugin): string | undefined {
    const adapter = plugin.app?.vault?.adapter as { getBasePath?: () => string } | undefined;
    return (typeof adapter?.getBasePath === 'function' ? adapter.getBasePath() : '') || undefined;
}

export function createAgentProvider(plugin: VaultAIPlugin, runtimeId?: string): AgentProvider {
    const s = plugin.settings;
    const selected = runtimeId || s.agentRuntimeProvider;
    if (selected === CODEX_RUNTIME_ID) {
        return new LocalCliAgentProvider(plugin.graphApiService, CODEX_RUNTIME_ID, 'Codex', 'Codex CLI');
    }
    if (selected === HERMES_RUNTIME_ID) {
        return new HermesAgentProvider({
            cliPath: s.hermesAgentCliPath || 'hermes',
            extraArgs: s.hermesAgentExtraArgs || '',
            timeoutMs: s.hermesAgentTimeoutMs ?? 120_000,
            healthCheckArgs: s.hermesAgentHealthCheckArgs || '--version',
            settingLabel: 'Hermes CLI path',
            displayName: 'Hermes Agent',
            cliWorkingDirectory: resolveVaultRoot(plugin),
        });
    }
    if (selected !== CLAUDE_RUNTIME_ID) {
        const custom = findCustomRuntime(plugin, selected);
        if (custom) {
            return new HermesAgentProvider({
                cliPath: custom.cliPath || 'hermes',
                extraArgs: custom.extraArgs || '',
                timeoutMs: custom.timeoutMs ?? 120_000,
                healthCheckArgs: custom.healthCheckArgs || '--version',
                settingLabel: 'CLI path',
                displayName: custom.displayName || 'Custom runtime',
                cliWorkingDirectory: resolveVaultRoot(plugin),
            });
        }
    }
    return new LocalCliAgentProvider(plugin.graphApiService, CLAUDE_RUNTIME_ID, 'Claude Code', 'Claude Code');
}
