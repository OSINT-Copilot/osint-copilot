/**
 * View / ItemView.
 *
 * containerEl's two-child structure is NOT cosmetic. All five registered views mount
 * into `this.containerEl.children[1]` -- graph-view.ts:285, chat-view.ts:395,
 * map-view.ts:73, timeline-view.ts:91, tools-skills-registry-view.ts:206,482 --
 * because Obsidian's view container is [header, content]. Get this wrong and every
 * view mounts into the header and renders blank, with no error.
 */
import { Component } from '../core/component';
import type { WorkspaceLeaf } from './layout';

export abstract class View extends Component {
    /**
     * Obsidian's View exposes `app`, and the five views use `this.app` 84 times.
     * The workspace injects it when it constructs a view, since the view factory
     * signature only carries a leaf.
     */
    app!: import('../app').App;
    containerEl: HTMLElement;
    /** The content half of containerEl; identical to containerEl.children[1]. */
    contentEl: HTMLElement;
    headerEl: HTMLElement;

    constructor(readonly leaf: WorkspaceLeaf) {
        super();
        this.containerEl = document.createElement('div');
        this.containerEl.addClass('workspace-leaf-content');

        this.headerEl = this.containerEl.createDiv({ cls: 'view-header' });
        this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
    }

    abstract getViewType(): string;

    getDisplayText(): string {
        return this.getViewType();
    }

    getIcon(): string {
        return 'document';
    }

    getState(): Record<string, unknown> {
        return {};
    }

    async setState(_state: unknown): Promise<void> { /* subclasses override */ }

    async onOpen(): Promise<void> { /* subclasses override */ }

    async onClose(): Promise<void> { /* subclasses override */ }

    onload(): void {
        void this.onOpen();
    }

    // ------------------------------------------------------------------ attachment
    //
    // onOpen() always runs while containerEl is a detached orphan: the shim creates the
    // element and never inserts it, and the host adopts it later. Anything that has to
    // measure itself -- Leaflet, which needs invalidateSize(), or any layout that reads
    // clientWidth -- therefore cannot do its work in onOpen().
    //
    // Cytoscape survives this by installing its own ResizeObserver and ancestor
    // transitionend/animationend/scroll listeners. Most libraries do not. These hooks
    // give every view the one signal it actually needs.

    private attached = false;

    /** True while containerEl is in the document. */
    isAttached(): boolean {
        return this.attached;
    }

    /**
     * Called by the host once containerEl is in the document and has been laid out.
     * Idempotent: a panel move can mount the new host before destroying the old one.
     */
    attachedToDocument(): void {
        if (this.attached) return;
        this.attached = true;
        try {
            this.onAttached();
        } catch (e) {
            console.error('[obsidian-shim] onAttached threw for', this.getViewType(), e);
        }
    }

    /**
     * Called by the host after containerEl has been removed from the document.
     *
     * After, not before: on a panel move Svelte may mount the new host first, so the
     * element is already re-adopted and this is not a real detach. `isConnected` is the
     * only reliable way to tell the two apart.
     */
    detachedFromDocument(): void {
        if (!this.attached) return;
        if (this.containerEl.isConnected) return;
        this.attached = false;
        try {
            this.onDetached();
        } catch (e) {
            console.error('[obsidian-shim] onDetached threw for', this.getViewType(), e);
        }
    }

    /** Subclasses override. containerEl is guaranteed to be in the document. */
    protected onAttached(): void { /* subclasses override */ }

    /** Subclasses override. containerEl is guaranteed NOT to be in the document. */
    protected onDetached(): void { /* subclasses override */ }

    onunload(): void {
        // A view unloaded while still on screen gets no detach from the host, but it
        // still has to release observers and timers.
        if (this.attached) {
            this.attached = false;
            try {
                this.onDetached();
            } catch (e) {
                console.error('[obsidian-shim] onDetached threw during unload for', this.getViewType(), e);
            }
        }
        void this.onClose();
    }

    /** Obsidian adds a header action button; the shell renders these. */
    addAction(icon: string, title: string, callback: (event: MouseEvent) => unknown): HTMLElement {
        const button = this.headerEl.createEl('button', { cls: 'view-action', attr: { 'aria-label': title } });
        button.dataset.icon = icon;
        button.addEventListener('click', callback);
        return button;
    }
}

export abstract class ItemView extends View {}

/** Placeholder view for an empty tab. */
export class EmptyView extends ItemView {
    getViewType(): string {
        return 'empty';
    }

    getDisplayText(): string {
        return 'New tab';
    }
}

/**
 * Editor -- imported by vault-ai-plugin.ts:3 but never used. Kept as a real (empty)
 * class so the import resolves; Phase 5 replaces it with the CodeMirror surface.
 */
export class Editor {
    getValue(): string { return ''; }
    setValue(_value: string): void { /* replaced in Phase 5 */ }
}
