/**
 * Plugin base class.
 *
 * Everything the plugin registers -- views, commands, events, 1 setting tab -- is
 * owned here and torn down on unload. In Obsidian these were fire-and-forget because
 * the host owned the registry; here we own it, so the shell registers `commands` with
 * Tangent and renders `settingTab`, and views go to the workspace's factory registry.
 */
import { Notice } from '../ui/notice';
import { Component } from './component';
import type { App } from '../app';

export interface Command {
    id: string;
    name: string;
    callback?: () => unknown;
    icon?: string;
    hotkeys?: { modifiers: string[]; key: string }[];
}

export interface ViewCreator {
    (leaf: import('../workspace/layout').WorkspaceLeaf): import('../workspace/view').View;
}

export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    dir?: string;
}

export abstract class Plugin extends Component {
    readonly commands = new Map<string, Command>();
    settingTab: { display(): void; hide?(): void } | null = null;

    constructor(readonly app: App, readonly manifest: PluginManifest) {
        super();
    }

    addCommand(command: Command): Command {
        this.commands.set(command.id, command);
        this.register(() => this.commands.delete(command.id));
        return command;
    }

    /**
     * Registers a view type.
     *
     * The factory goes to the workspace: setViewState looks the type up there, and
     * without it every view silently becomes an EmptyView. Doing it here rather than
     * leaving it to the host is what makes registerView() mean the same thing it does in
     * Obsidian.
     */
    registerView(type: string, creator: ViewCreator): void {
        this.app.workspace.registerViewFactory(type, creator);
        this.register(() => {
            // Unload the views this factory created, not just the factory: leaf.detach()
            // runs view.unload() -> onunload() -> onClose(), which is where a view drops
            // its document listeners and destroys cytoscape/leaflet. Without it those
            // outlived the plugin.
            this.app.workspace.detachLeavesOfType(type);
            this.app.workspace.unregisterViewFactory(type);
        });
    }

    addSettingTab(tab: { display(): void; hide?(): void }): void {
        this.settingTab = tab;
        this.register(() => { this.settingTab = null; });
    }

    /**
     * Settings live at <vault>/.osint-copilot/data.json, not in a plugin folder.
     *
     * On first run against a vault that was previously used with the Obsidian plugin,
     * the old data.json is imported once. That file is left in place: the frozen
     * plugin may still be installed, and deleting another application's config as a
     * side effect of first launch would be hostile.
     */
    async loadData(): Promise<unknown> {
        let raw: string;
        try {
            raw = await this.app.vault.adapter.read(DATA_PATH);
        } catch {
            // Missing is the first-run case.
            return this.importLegacySettings();
        }
        try {
            return JSON.parse(raw);
        } catch (e) {
            // Present but unparseable -- a crash mid-write, or a hand edit. This used to be
            // indistinguishable from "missing", and the caller then saved defaults over the
            // only copy of the user's CLI paths, folders and runtimes. Keep the damaged
            // file under a new name, say so, and let defaults take over the live path.
            const backup = `${DATA_PATH}.corrupt-${Date.now()}`;
            try { await this.app.vault.adapter.write(backup, raw); } catch { /* best effort */ }
            console.error(`[osint-copilot] ${DATA_PATH} could not be parsed; kept as ${backup}`, e);
            new Notice(`OSINT Copilot settings could not be read and were reset. The damaged file was kept as ${backup}.`, 0);
            return null;
        }
    }

    private async importLegacySettings(): Promise<unknown> {
        for (const legacyPath of LEGACY_DATA_PATHS) {
            try {
                const raw = await this.app.vault.adapter.read(legacyPath);
                const parsed = JSON.parse(raw);
                await this.saveData(parsed);
                console.info(`[osint-copilot] Imported settings from ${legacyPath}`);
                return parsed;
            } catch {
                continue;
            }
        }
        return null;
    }

    async saveData(data: unknown): Promise<void> {
        await this.app.vault.adapter.mkdir(DATA_DIR);
        await this.app.vault.adapter.write(DATA_PATH, JSON.stringify(data, null, 2));
    }
}

const DATA_DIR = '.osint-copilot';
const DATA_PATH = `${DATA_DIR}/data.json`;

/**
 * Where the Obsidian plugin kept its settings. Both folder names are checked because
 * BRAT installs under the repository name while a manual install uses the plugin id.
 */
const LEGACY_DATA_PATHS = [
    '.obsidian/plugins/osint-copilot/data.json',
    '.obsidian/plugins/Obsidian-OSINT-Copilot-plugin/data.json',
];
