import { describe, it, expect, vi } from 'vitest';
import VaultAIPlugin from '../main';
import { App } from 'obsidian';

/** A plugin whose persisted data is whatever the test says, and which writes nowhere. */
function pluginWithSaved(data: Record<string, unknown>) {
    const plugin = new VaultAIPlugin(new App(), { id: 'osint-copilot', name: 'x', version: '0' } as never);
    (plugin as unknown as { loadData: () => Promise<unknown> }).loadData = vi.fn().mockResolvedValue(data);
    (plugin as unknown as { saveData: () => Promise<void> }).saveData = vi.fn().mockResolvedValue(undefined);
    return plugin;
}

describe('loadSettings and the selected runtime', () => {
    const custom = (enabled: boolean) => ({
        // Stored ids are the normaliser's output: 'probe' -> 'custom:probe'.
        id: 'probe', displayName: 'Probe', cliPath: '/opt/probe', enabled,
    });

    it('keeps a selection that points at an enabled custom runtime', async () => {
        const plugin = pluginWithSaved({ agentRuntimeProvider: 'custom:probe', customAgentRuntimes: [custom(true)] });
        await plugin.loadSettings();
        expect(plugin.settings.agentRuntimeProvider).toBe('custom:probe');
    });

    it('does not keep a selection that points at a DISABLED custom runtime', async () => {
        // The dropdown hides disabled runtimes and showed Claude instead, while chat turns
        // still ran the disabled CLI. A disabled runtime is not a valid selection.
        const plugin = pluginWithSaved({ agentRuntimeProvider: 'custom:probe', customAgentRuntimes: [custom(false)] });
        await plugin.loadSettings();
        expect(plugin.settings.agentRuntimeProvider).not.toBe('custom:probe');
    });
});
