/**
 * Workspace -- leaf placement and view registration.
 *
 * The API surface here is exactly what osint-workspace-controller.ts (33 of the 43
 * workspace call sites) and the five views actually use. Nothing speculative.
 *
 * Deliberately NOT implemented: deferred/lazy views. Obsidian 1.7+ defers
 * constructing views for restored background tabs; copying that would make
 * getLeavesOfType(GRAPH_VIEW_TYPE) (12 call sites) miss background graph tabs, and
 * osint-workspace-controller.ts:130 casts a leaf's view to GraphView and calls a
 * method on it. Views are constructed eagerly.
 */
import { WorkspaceLeaf, WorkspaceRoot, WorkspaceTabs, type WorkspaceItem } from './layout';
import { EmptyView, View } from './view';
import type { TFile } from '../vault/tfile';

export interface ViewState {
    type: string;
    active?: boolean;
    state?: Record<string, unknown>;
}

export type ViewFactory = (leaf: WorkspaceLeaf) => View;

/** 'tab' = new tab in the active group; false = reuse active. */
export type LeafTarget = boolean | 'tab';

export class Workspace {
    /** Set by App so constructed views can expose `this.app`. */
    app: import('../app').App | null = null;

    readonly rootSplit = new WorkspaceRoot();

    activeLeaf: WorkspaceLeaf | null = null;

    private readonly factories = new Map<string, ViewFactory>();

    constructor() {
        // The editor area always has at least one tab group to place leaves into.
        this.rootSplit.addChild(new WorkspaceTabs());
    }

    // ------------------------------------------------------------- registration

    registerViewFactory(type: string, factory: ViewFactory): void {
        this.factories.set(type, factory);
    }

    unregisterViewFactory(type: string): void {
        this.factories.delete(type);
    }

    // ----------------------------------------------------------------- querying

    iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => void): void {
        this.walk(this.rootSplit, callback);
    }

    getLeavesOfType(type: string): WorkspaceLeaf[] {
        const found: WorkspaceLeaf[] = [];
        this.iterateAllLeaves((leaf) => {
            if (leaf.view.getViewType() === type) found.push(leaf);
        });
        return found;
    }

    detachLeavesOfType(type: string): void {
        for (const leaf of this.getLeavesOfType(type)) leaf.detach();
    }

    // ---------------------------------------------------------------- placement

    getLeaf(target: LeafTarget = false): WorkspaceLeaf {
        if (target === false && this.activeLeaf && this.isAttached(this.activeLeaf)) {
            return this.activeLeaf;
        }
        return this.createLeafIn(this.activeTabGroup());
    }

    /**
     * Opens a new tab immediately after `anchor`, in the same group.
     * This is the mechanism behind Ctrl/Cmd-click on all five ribbon icons.
     */
    async duplicateLeaf(anchor: WorkspaceLeaf): Promise<WorkspaceLeaf> {
        const group = anchor.parent as WorkspaceTabs | null;
        if (!(group instanceof WorkspaceTabs)) return this.getLeaf('tab');

        const leaf = new WorkspaceLeaf(new EmptyView(null as unknown as WorkspaceLeaf));
        this.attachLeaf(leaf, group, group.children.indexOf(anchor) + 1);
        await leaf.setViewState(anchor.getViewState() as ViewState);
        return leaf;
    }

    /**
     * Set by the host to surface a leaf in its own UI. The leaf tree stays the shim's --
     * osint-workspace-controller compares leaf.getRoot() to rootSplit and twelve call
     * sites read getLeavesOfType() -- but which panel is on screen is the host's call.
     */
    onRevealLeaf: ((leaf: WorkspaceLeaf) => void) | null = null;

    /** Set by the host to open a markdown note in its own editor; the shim has none. */
    openMarkdownFile: ((file: TFile) => void | Promise<void>) | null = null;

    async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
        this.setActiveLeaf(leaf);
        this.onRevealLeaf?.(leaf);
    }

    setActiveLeaf(leaf: WorkspaceLeaf | null, _focus = true): void {
        this.activeLeaf = leaf;
    }

    // ------------------------------------------------------------------ private

    private walk(node: WorkspaceItem, callback: (leaf: WorkspaceLeaf) => void): void {
        if (node instanceof WorkspaceLeaf) {
            callback(node);
            return;
        }
        const children = (node as { children?: WorkspaceItem[] }).children;
        if (children) for (const child of [...children]) this.walk(child, callback);
    }

    private isAttached(leaf: WorkspaceLeaf): boolean {
        let found = false;
        this.iterateAllLeaves((l) => { if (l === leaf) found = true; });
        return found;
    }

    private activeTabGroup(): WorkspaceTabs {
        if (this.activeLeaf?.parent instanceof WorkspaceTabs && this.isAttached(this.activeLeaf)) {
            return this.activeLeaf.parent;
        }
        return this.tabGroupOf(this.rootSplit);
    }

    private tabGroupOf(root: WorkspaceRoot): WorkspaceTabs {
        const existing = this.firstTabGroup(root);
        if (existing) return existing;
        const tabs = new WorkspaceTabs();
        root.addChild(tabs);
        return tabs;
    }

    private firstTabGroup(node: WorkspaceItem): WorkspaceTabs | null {
        if (node instanceof WorkspaceTabs) return node;
        const children = (node as { children?: WorkspaceItem[] }).children ?? [];
        for (const child of children) {
            const found = this.firstTabGroup(child);
            if (found) return found;
        }
        return null;
    }

    private createLeafIn(group: WorkspaceTabs): WorkspaceLeaf {
        const leaf = new WorkspaceLeaf(new EmptyView(null as unknown as WorkspaceLeaf));
        this.attachLeaf(leaf, group);
        return leaf;
    }

    private attachLeaf(leaf: WorkspaceLeaf, group: WorkspaceTabs, index?: number): void {
        group.addChild(leaf, index);
        this.bindSetViewState(leaf);
        this.setActiveLeaf(leaf);
    }

    /**
     * setViewState lives on the leaf but needs the factory registry, so the workspace
     * installs it at attach time rather than making every leaf hold a workspace ref.
     */
    private bindSetViewState(leaf: WorkspaceLeaf): void {
        leaf.setViewState = async (state: ViewState): Promise<void> => {
            const factory = this.factories.get(state.type);
            const previous = leaf.view;
            const next = factory ? factory(leaf) : new EmptyView(leaf);
            if (this.app) next.app = this.app;

            if (previous && previous !== next) previous.unload();
            leaf.view = next;
            if (state.state !== undefined) await next.setState(state.state);
            next.load();

            if (state.active !== false) await this.revealLeaf(leaf);
        };

        leaf.openFile = async (file: TFile): Promise<void> => {
            // The host owns note editing. Eight call sites reach here -- clicking an
            // entity in the graph, a citation in chat, a skill in the registry.
            await this.openMarkdownFile?.(file);
        };
    }
}

declare module './layout' {
    interface WorkspaceLeaf {
        setViewState(state: ViewState): Promise<void>;
        openFile(file: TFile): Promise<void>;
    }
}
