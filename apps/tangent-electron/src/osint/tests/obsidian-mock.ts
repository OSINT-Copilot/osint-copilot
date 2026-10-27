import { vi } from 'vitest';

export class App {
    workspace: any;
    vault: any;

    constructor() {
        this.workspace = {
            getLeavesOfType: vi.fn().mockReturnValue([]),
            revealLeaf: vi.fn(),
            getLeaf: vi.fn().mockReturnValue({
                setViewState: vi.fn().mockResolvedValue(undefined),
                view: {
                    containerEl: document.createElement('div'),
                }
            }),
        };
        this.vault = {
            adapter: {
                exists: vi.fn().mockResolvedValue(true),
                read: vi.fn().mockResolvedValue(''),
                write: vi.fn().mockResolvedValue(undefined),
            },
            getAbstractFileByPath: vi.fn(),
        };
    }
}

export class Plugin {
    app: App;
    manifest: any;
    settings: any;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
    }
    loadData = vi.fn().mockResolvedValue({});
    saveData = vi.fn().mockResolvedValue(undefined);
    addCommand = vi.fn();
    addSettingTab = vi.fn();
    registerView = vi.fn();
}

export class PluginSettingTab {
    constructor(app: App, plugin: Plugin) { }
    display() { }
    hide() { }
}

export class Setting {
    constructor(containerEl: HTMLElement) { }
    setName = vi.fn().mockReturnThis();
    setDesc = vi.fn().mockReturnThis();
    addText = vi.fn().mockReturnThis();
    addToggle = vi.fn().mockReturnThis();
    addTextArea = vi.fn().mockReturnThis();
    addDropdown = vi.fn().mockReturnThis();
    addButton = vi.fn().mockReturnThis();
}

export class Notice {
    constructor(message: string, duration?: number) { }
}

export class ItemView {
    contentEl: HTMLElement;
    containerEl: HTMLElement;

    constructor(leaf: WorkspaceLeaf) {
        this.containerEl = document.createElement('div');
        this.contentEl = document.createElement('div');
        this.containerEl.appendChild(this.contentEl);
    }
    getViewType() { return ''; }
    onOpen() { return Promise.resolve(); }
    onClose() { return Promise.resolve(); }
}

export class WorkspaceLeaf {
    view: any;
    constructor() { }
    openFile = vi.fn();
}

/**
 * These are the real implementations, not stubs.
 *
 * `instanceof TFile` appears in 92 places in the product code. A separate mock class
 * makes every one of those checks false against the files a real Vault hands out, which
 * is not a test-only quirk — it silently sends EntityManager down its "create" branch
 * for a note that already exists. Anything that models vault semantics has to be shared
 * with production, or the two drift exactly where it matters.
 *
 * normalizePath likewise: the mock's version had no NFC normalisation, no trailing-slash
 * strip and no ""-to-"/" fallback, so tests agreed with a normalizer the app does not use.
 */
export { TAbstractFile, TFile, TFolder } from '../obsidian-shim/vault/tfile';
export { normalizePath } from '../obsidian-shim/vault/normalize-path';

export const requestUrl = vi.fn();

export const MarkdownRenderer = {
    render: vi.fn(async (_app: App, markdown: string, el: HTMLElement) => {
        el.textContent = markdown;
    }),
};

export class Menu {
    addItem = vi.fn().mockReturnThis();
    showAtPosition = vi.fn();
}

export class Component {
    load() { }
    onload() { }
    unload() { }
    onunload() { }
}

export class ButtonComponent {
    buttonEl: HTMLButtonElement;
    constructor(containerEl: HTMLElement) {
        this.buttonEl = document.createElement('button');
        containerEl.appendChild(this.buttonEl);
    }
    setButtonText = vi.fn().mockReturnThis();
    setCta = vi.fn().mockReturnThis();
    onClick = vi.fn().mockReturnThis();
    setDisabled = vi.fn().mockReturnThis();
}

export class Modal {
    constructor(app: App) { }
    open() { }
    close() { }
}
