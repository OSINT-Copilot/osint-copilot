/**
 * The first-run guide.
 *
 * Shown once, the first time a vault is opened with OSINT Copilot running, and never
 * again unless the user asks for it from the Guide view. It is the same content as the
 * first three sections of the Guide, from data/guide-content.ts, rather than a second
 * copy that would drift from it.
 *
 * "Seen" is stored in plugin settings rather than localStorage: settings travel with the
 * vault, so an analyst who opens a fresh case does not get the tour again, and one who
 * opens the app on another machine with the same vault does not either.
 */
import { App, MarkdownRenderer, Modal } from 'obsidian';
import { GUIDE_SECTIONS, WELCOME_SECTION_IDS, guideSection } from '../data/guide-content';

export interface WelcomeModalHost {
    /** Navigates Tangent to the Guide view. */
    openGuide(): void;
}

export class WelcomeModal extends Modal {
    /** A tour is dismissed deliberately, not by a stray click on the backdrop. */
    protected closeOnBackgroundClick = false;

    constructor(app: App, private host: WelcomeModalHost) {
        super(app);
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass('osint-welcome-modal');
        contentEl.addClass('osint-welcome');

        contentEl.createEl('h1', { text: 'Welcome to OSINT Copilot' });
        contentEl.createEl('p', {
            cls: 'osint-welcome-lede',
            text: 'A short tour. It takes a minute, and you can reopen it any time from the Guide.',
        });

        const body = contentEl.createDiv({ cls: 'osint-welcome-body' });
        for (const id of WELCOME_SECTION_IDS) {
            const section = guideSection(id);
            // A typo'd id would otherwise silently shorten the tour.
            if (!section) {
                console.error('[osint] welcome: no guide section', id);
                continue;
            }
            const block = body.createDiv({ cls: 'osint-welcome-section' });
            block.createEl('h2', { text: section.title });
            const markdown = block.createDiv({ cls: 'osint-welcome-markdown' });
            void MarkdownRenderer.render(this.app, section.body, markdown, '', this);
        }

        const footer = contentEl.createDiv({ cls: 'osint-welcome-footer' });
        footer.createSpan({
            cls: 'osint-welcome-count',
            text: `${WELCOME_SECTION_IDS.length} of ${GUIDE_SECTIONS.length} sections shown`,
        });

        const buttons = footer.createDiv({ cls: 'osint-welcome-buttons' });
        const guideButton = buttons.createEl('button', { text: 'Read the full guide' });
        guideButton.onclick = () => {
            this.close();
            this.host.openGuide();
        };

        const startButton = buttons.createEl('button', {
            text: 'Start working',
            cls: 'mod-cta',
        });
        startButton.onclick = () => this.close();

        // In a microtask, not directly: Modal.open() focuses the first focusable element
        // in the dialog AFTER onOpen() returns, which for this dialog is a link inside the
        // prose. Deferring puts the keyboard on the primary action instead, which is where
        // someone who just wants to get on with it will press Enter.
        // preventScroll: the button sits at the end of the scrolling content, and focusing it
        // the ordinary way opened the tour scrolled past its own title.
        queueMicrotask(() => {
            startButton.focus({ preventScroll: true });
            this.contentEl.scrollTop = 0;
            this.modalEl.scrollTop = 0;
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
