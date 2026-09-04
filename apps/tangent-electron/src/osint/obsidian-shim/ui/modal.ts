/**
 * Modal -- 16 subclasses across the codebase.
 *
 * The used surface is tiny: constructor(app), .open(), .close(), this.contentEl,
 * and occasionally .titleEl / .containerEl / .setTitle().
 *
 * Three things Obsidian's Modal does that a bare overlay does not, all of which the
 * ported dialogs turned out to depend on:
 *
 *  - a keymap scope: while a dialog is up, app shortcuts must not fire behind it.
 *    Tangent dispatches its shortcuts from a window-level keydown, so Mod+W closed the
 *    note under the dialog and Mod+P opened the palette on top of it. The document-level
 *    handler here stops propagation for every key while it is the topmost dialog; the
 *    dialog's own controls have already seen the key (target phase precedes the document
 *    bubble), so they lose nothing.
 *  - Escape closes only the topmost dialog, and marks the event handled so Tangent's own
 *    Escape (toggle Thread/Map focus, which unmounts every pane) does not also run.
 *  - focus stays inside: Tab wraps, and the backdrop is aria-modal.
 *
 * `.modal-bg` is not decoration: subclasses that must not dismiss on a stray backdrop
 * click set `closeOnBackgroundClick = false` (confirm dialogs).
 */
const openModals: Modal[] = [];

const FOCUSABLE = 'input, textarea, select, button, a[href], [tabindex]:not([tabindex="-1"])';

export class Modal {
    readonly containerEl: HTMLElement;
    readonly modalEl: HTMLElement;
    readonly titleEl: HTMLElement;
    readonly contentEl: HTMLElement;
    private readonly bgEl: HTMLElement;
    private keyHandler: ((event: KeyboardEvent) => void) | null = null;
    private previouslyFocused: Element | null = null;
    /** Subclasses set this to false to keep a stray backdrop click from dismissing. */
    protected closeOnBackgroundClick = true;

    constructor(readonly app: import('../app').App) {
        this.containerEl = document.createElement('div');
        this.containerEl.addClass('modal-container');

        this.bgEl = this.containerEl.createDiv({ cls: 'modal-bg' });
        this.modalEl = this.containerEl.createDiv({ cls: 'modal', attr: { role: 'dialog', 'aria-modal': 'true' } });
        this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' });
        this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });

        // A real button with a visible glyph. It was an empty div: zero size, invisible,
        // not reachable by keyboard -- the only mouse affordance for closing was missing.
        const closeButton = this.modalEl.createEl('button', {
            cls: 'modal-close-button',
            text: '\u00d7',
            attr: { type: 'button', 'aria-label': 'Close' },
        });
        closeButton.addEventListener('click', () => this.close());
        this.bgEl.addEventListener('click', () => {
            if (this.closeOnBackgroundClick) this.close();
        });
    }

    setTitle(title: string): this {
        this.titleEl.setText(title);
        return this;
    }

    open(): void {
        // Idempotent: a second open() used to overwrite keyHandler, leaking the first
        // document listener for the rest of the session.
        if (this.keyHandler) return;
        this.previouslyFocused = document.activeElement;
        document.body.appendChild(this.containerEl);
        openModals.push(this);

        this.keyHandler = (event: KeyboardEvent) => {
            if (openModals[openModals.length - 1] !== this) return;
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                this.close();
                return;
            }
            if (event.key === 'Tab') this.trapFocus(event);
        };
        document.addEventListener('keydown', this.keyHandler);

        this.onOpen();
        // Focus the first focusable control so keyboard users land inside the dialog.
        this.modalEl.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }

    private focusables(): HTMLElement[] {
        return Array.from(this.modalEl.querySelectorAll<HTMLElement>(FOCUSABLE))
            .filter((el) => !el.hasAttribute('disabled'));
    }

    private trapFocus(event: KeyboardEvent): void {
        const items = this.focusables();
        if (items.length === 0) {
            event.preventDefault();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (!active || !this.modalEl.contains(active)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
            return;
        }
        if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    close(): void {
        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        const at = openModals.indexOf(this);
        if (at >= 0) openModals.splice(at, 1);
        this.onClose();
        this.containerEl.remove();
        (this.previouslyFocused as HTMLElement | null)?.focus?.();
    }

    onOpen(): void { /* subclasses override */ }
    onClose(): void { /* subclasses override */ }
}
