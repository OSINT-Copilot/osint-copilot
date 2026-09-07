/**
 * The Guide view: the in-app documentation, rendered from data/guide-content.ts.
 *
 * A view rather than a separate documentation workspace (Tangent's own `Documentation/`
 * zip opens a second window): the guide is most useful next to the thing it describes, and
 * an analyst reading "select two entities and press Connect" should not have to leave the
 * window the entities are in to read it.
 *
 * Content is markdown put through the same MarkdownRenderer the chat transcript uses, so
 * the guide is styled like the rest of the app and can be edited without touching DOM code.
 */
import { ItemView, MarkdownRenderer, WorkspaceLeaf, setIcon } from 'obsidian';
import { GUIDE_SECTIONS, type GuideSection } from '../data/guide-content';

export const DOCS_VIEW_TYPE = 'osint-copilot-docs-view';

export class DocsView extends ItemView {
    /** Section id -> its heading element, for the contents rail to scroll to. */
    private sectionEls = new Map<string, HTMLElement>();
    private railButtons = new Map<string, HTMLElement>();
    private scrollEl: HTMLElement | null = null;
    private observer: IntersectionObserver | null = null;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return DOCS_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'OSINT Copilot guide';
    }

    getIcon(): string {
        return 'book-open';
    }

    async onOpen(): Promise<void> {
        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.addClass('osint-docs-root');

        const rail = root.createDiv({ cls: 'osint-docs-rail' });
        rail.createDiv({ cls: 'osint-docs-rail-title', text: 'Contents' });

        const body = root.createDiv({ cls: 'osint-docs-body' });
        this.scrollEl = body;

        const header = body.createDiv({ cls: 'osint-docs-header' });
        header.createEl('h1', { text: 'OSINT Copilot' });
        header.createEl('p', {
            cls: 'osint-docs-subtitle',
            text: 'An investigation workspace built on plain markdown files.',
        });

        for (const section of GUIDE_SECTIONS) {
            this.addRailEntry(rail, section);
            await this.addSection(body, section);
        }

        this.watchScroll();
    }

    private addRailEntry(rail: HTMLElement, section: GuideSection): void {
        const button = rail.createEl('button', { cls: 'osint-docs-rail-item' });
        const icon = button.createSpan({ cls: 'osint-docs-rail-icon' });
        setIcon(icon, section.icon);
        button.createSpan({ text: section.title });
        button.onclick = () => {
            // scrollIntoView on the heading rather than a hash link: the view is inside a
            // Tangent panel, and a fragment navigation would move the whole window.
            this.sectionEls.get(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        this.railButtons.set(section.id, button);
    }

    private async addSection(body: HTMLElement, section: GuideSection): Promise<void> {
        const wrapper = body.createDiv({ cls: 'osint-docs-section' });
        wrapper.dataset.sectionId = section.id;

        const heading = wrapper.createEl('h2', { cls: 'osint-docs-section-title' });
        const icon = heading.createSpan({ cls: 'osint-docs-section-icon' });
        setIcon(icon, section.icon);
        heading.createSpan({ text: section.title });
        this.sectionEls.set(section.id, wrapper);

        const content = wrapper.createDiv({ cls: 'osint-docs-markdown' });
        await MarkdownRenderer.render(this.app, section.body, content, '', this);
    }

    /**
     * Highlights the rail entry for whatever is on screen.
     *
     * An IntersectionObserver rather than a scroll handler: it reports only when a
     * section crosses the threshold, so reading the guide does not run a callback on
     * every scroll frame.
     */
    private watchScroll(): void {
        if (!this.scrollEl || typeof IntersectionObserver === 'undefined') return;
        this.observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const id = (entry.target as HTMLElement).dataset.sectionId;
                    if (!id) continue;
                    // classList, not the shim's addClass/removeClass: toggleClass is one
                    // of the Obsidian extensions dom-extensions.ts deliberately does not
                    // implement, having had zero call sites.
                    for (const [key, button] of this.railButtons) {
                        button.classList.toggle('is-current', key === id);
                    }
                }
            },
            // Only the band near the top of the viewport counts as "being read", so the
            // rail follows the heading you have reached rather than the tallest section.
            { root: this.scrollEl, rootMargin: '0px 0px -70% 0px', threshold: 0 },
        );
        for (const el of this.sectionEls.values()) this.observer.observe(el);
    }

    async onClose(): Promise<void> {
        this.observer?.disconnect();
        this.observer = null;
        this.sectionEls.clear();
        this.railButtons.clear();
        this.scrollEl = null;
    }
}
