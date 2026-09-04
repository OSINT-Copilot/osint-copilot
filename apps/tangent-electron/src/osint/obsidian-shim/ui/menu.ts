/**
 * Menu -- context menus. Only 3 `new Menu()` sites (map-view x2, timeline-view x1);
 * graph-view rolls its own with raw DOM and is untouched by this.
 *
 * Items are real buttons so they take focus and fire on Enter/Space; the menu clamps
 * itself to the viewport (a marker near the bottom edge used to open a menu whose lower
 * items were off-screen with no way to reach them), and Escape dismisses it -- marked
 * handled, because otherwise Tangent's window-level Escape toggled Thread/Map focus and
 * left the menu orphaned on document.body over the empty space.
 */
import { setIcon } from './set-icon';

export class MenuItem {
    readonly dom: HTMLElement;
    private titleEl: HTMLElement | null = null;
    private clickCallback: ((event: MouseEvent) => unknown) | null = null;

    constructor(container: HTMLElement, private readonly dismiss: () => void) {
        this.dom = container.createEl('button', { cls: 'menu-item', attr: { type: 'button', role: 'menuitem' } });
        this.dom.addEventListener('click', (event) => {
            this.dismiss();
            this.clickCallback?.(event);
        });
    }

    setTitle(title: string | DocumentFragment): this {
        // Reuses the element: Obsidian's setTitle replaces, and appending a second title
        // div per call made repeated setTitle calls stack.
        if (!this.titleEl) this.titleEl = this.dom.createDiv({ cls: 'menu-item-title' });
        this.titleEl.setText(title);
        return this;
    }

    setIcon(icon: string | null): this {
        if (!icon) return this;
        const iconEl = this.dom.createDiv({ cls: 'menu-item-icon' });
        setIcon(iconEl, icon);
        this.dom.insertBefore(iconEl, this.dom.firstChild);
        return this;
    }

    setDisabled(disabled: boolean): this {
        this.dom.toggleAttribute('data-disabled', disabled);
        (this.dom as HTMLButtonElement).disabled = disabled;
        return this;
    }

    setSection(_section: string): this {
        return this;
    }

    onClick(callback: (event: MouseEvent) => unknown): this {
        this.clickCallback = callback;
        return this;
    }
}

const VIEWPORT_MARGIN = 4;

export class Menu {
    readonly dom: HTMLElement;
    private dismissHandler: ((event: MouseEvent) => void) | null = null;
    private keyHandler: ((event: KeyboardEvent) => void) | null = null;

    constructor() {
        this.dom = document.createElement('div');
        this.dom.addClass('menu');
        this.dom.setAttribute('role', 'menu');
    }

    addItem(callback: (item: MenuItem) => unknown): this {
        callback(new MenuItem(this.dom, () => this.hide()));
        return this;
    }

    addSeparator(): this {
        this.dom.createDiv({ cls: 'menu-separator' });
        return this;
    }

    showAtMouseEvent(event: MouseEvent): this {
        return this.showAtPosition({ x: event.clientX, y: event.clientY });
    }

    showAtPosition(position: { x: number; y: number }): this {
        this.dom.setCssProps({ position: 'fixed', left: `${position.x}px`, top: `${position.y}px` });
        document.body.appendChild(this.dom);

        // Clamp after it is in the document, which is when it has a size.
        const rect = this.dom.getBoundingClientRect();
        const left = Math.max(VIEWPORT_MARGIN, Math.min(position.x, window.innerWidth - rect.width - VIEWPORT_MARGIN));
        const top = Math.max(VIEWPORT_MARGIN, Math.min(position.y, window.innerHeight - rect.height - VIEWPORT_MARGIN));
        if (left !== position.x || top !== position.y) {
            this.dom.setCssProps({ left: `${left}px`, top: `${top}px` });
        }

        this.keyHandler = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.hide();
                return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                const items = Array.from(this.dom.querySelectorAll<HTMLButtonElement>('button.menu-item:not([disabled])'));
                if (items.length === 0) return;
                event.preventDefault();
                const at = items.indexOf(document.activeElement as HTMLButtonElement);
                const step = event.key === 'ArrowDown' ? 1 : -1;
                const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
                items[next].focus();
            }
        };
        document.addEventListener('keydown', this.keyHandler);

        // Defer so the click that opened the menu does not immediately dismiss it.
        window.setTimeout(() => {
            if (!this.dom.isConnected) return;
            this.dismissHandler = () => this.hide();
            document.addEventListener('click', this.dismissHandler, { once: true });
        }, 0);
        return this;
    }

    hide(): this {
        if (this.dismissHandler) {
            document.removeEventListener('click', this.dismissHandler);
            this.dismissHandler = null;
        }
        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        this.dom.remove();
        return this;
    }
}
