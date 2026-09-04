/**
 * Notice -- 233 call sites, the single most-used Obsidian symbol.
 *
 * Obsidian's is a stacked, auto-dismissing toast in the top-right. Callers only ever
 * use `new Notice(message, duration?)` and occasionally `.hide()`, so that is all
 * this implements -- plus two things Obsidian's has and a bare div does not: the
 * container is a live region so assistive tech hears toasts at all, and a failure
 * looks different from a success. Most call sites already lead with an emoji or a
 * word that says which it is, so the variant is inferred from the message when the
 * caller does not pass one.
 */
const DEFAULT_DURATION_MS = 5000;
const CONTAINER_ID = 'osint-notice-container';

export type NoticeVariant = 'info' | 'success' | 'warning' | 'error';

function container(): HTMLElement {
    let el = document.getElementById(CONTAINER_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = CONTAINER_ID;
        el.className = 'notice-container';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    return el;
}

export function inferNoticeVariant(message: string | DocumentFragment): NoticeVariant {
    if (typeof message !== 'string') return 'info';
    const m = message.trimStart();
    if (/^(\u274c|\u26d4|\ud83d\udeab)/.test(m)) return 'error';
    if (/^(error|failed|could not|couldn't|cannot|can't|unable)\b/i.test(m)) return 'error';
    if (/^(\u26a0\ufe0f|\u26a0)/.test(m)) return 'warning';
    if (/^(\u2705|\u2713|\u2714)/.test(m)) return 'success';
    return 'info';
}

export class Notice {
    readonly noticeEl: HTMLElement;
    private timer: number | null = null;

    constructor(message: string | DocumentFragment, duration = DEFAULT_DURATION_MS, variant?: NoticeVariant) {
        this.noticeEl = document.createElement('div');
        this.noticeEl.className = 'notice';
        const kind = variant ?? inferNoticeVariant(message);
        if (kind !== 'info') this.noticeEl.classList.add(`mod-${kind}`);
        this.noticeEl.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        this.setMessage(message);
        container().appendChild(this.noticeEl);

        this.noticeEl.addEventListener('click', () => this.hide());
        // duration 0 means "stay until dismissed" in Obsidian.
        if (duration > 0) {
            this.timer = window.setTimeout(() => this.hide(), duration);
        }
    }

    setMessage(message: string | DocumentFragment): this {
        if (typeof message === 'string') this.noticeEl.textContent = message;
        else {
            this.noticeEl.textContent = '';
            this.noticeEl.appendChild(message);
        }
        return this;
    }

    hide(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
        this.noticeEl.remove();
    }
}
