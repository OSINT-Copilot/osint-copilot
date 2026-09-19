/**
 * The `obsidian` module.
 *
 * The tsconfig `obsidian` path maps here (webpack follows tsconfig paths), so the files
 * written against Obsidian's API compile unchanged. vitest aliases "obsidian" to
 * tests/obsidian-mock.ts instead.
 */

// --- vault -----------------------------------------------------------------
export { TAbstractFile, TFile, TFolder } from './vault/tfile';
export type { FileStats } from './vault/tfile';
export { normalizePath } from './vault/normalize-path';
export { Vault } from './vault/vault';
export type { EventRef } from './vault/vault';

// --- core ------------------------------------------------------------------
export { App } from './app';
export { Component } from './core/component';
export { Plugin } from './core/plugin';
export type { Command, PluginManifest } from './core/plugin';
export { MetadataCache } from './core/metadata-cache';
export type { CachedMetadata } from './core/metadata-cache';
export { requestUrl } from './core/request-url';
export type { RequestUrlParam, RequestUrlResponse } from './core/request-url';

// --- workspace -------------------------------------------------------------
export { Workspace } from './workspace/workspace';
export type { ViewState, WorkspaceEventRef } from './workspace/workspace';
export {
    WorkspaceItem, WorkspaceLeaf, WorkspaceParent, WorkspaceRoot, WorkspaceSplit, WorkspaceTabs,
} from './workspace/layout';
export { Editor, ItemView, View } from './workspace/view';
export { MARKDOWN_VIEW_TYPE, MarkdownView } from './workspace/markdown-view';
export type { MarkdownViewMode } from './workspace/markdown-view';

// --- ui --------------------------------------------------------------------
export {
    ButtonComponent, ColorComponent, DropdownComponent, MarkdownRenderer, Menu, MenuItem,
    Modal, Notice, PluginSettingTab, Setting, TextAreaComponent, TextComponent,
    ToggleComponent, getIconIds, setIcon,
} from './ui';

// --- dom -------------------------------------------------------------------
export { installDomExtensions } from './dom/dom-extensions';
export type { DomElementInfo } from './dom/dom-extensions';
