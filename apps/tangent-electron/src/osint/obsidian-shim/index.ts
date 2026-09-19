/**
 * The `obsidian` module.
 *
 * The tsconfig `obsidian` path maps here (webpack follows tsconfig paths), so the files
 * written against Obsidian's API compile unchanged. vitest aliases "obsidian" to
 * tests/obsidian-mock.ts instead.
 */

// --- vault -----------------------------------------------------------------
export { TAbstractFile, TFile, TFolder } from './vault/tfile';
export { normalizePath } from './vault/normalize-path';
export { Vault } from './vault/vault';

// --- core ------------------------------------------------------------------
export { App } from './app';
export { Plugin } from './core/plugin';
export type { CachedMetadata } from './core/metadata-cache';
export { requestUrl } from './core/request-url';
export type { RequestUrlResponse } from './core/request-url';

// --- workspace -------------------------------------------------------------
export { WorkspaceLeaf } from './workspace/layout';
export { ItemView } from './workspace/view';

// --- ui --------------------------------------------------------------------
export {
    ButtonComponent, DropdownComponent, MarkdownRenderer, Menu, Modal, Notice,
    PluginSettingTab, Setting, TextComponent, setIcon,
} from './ui';
