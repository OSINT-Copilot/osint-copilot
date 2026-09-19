/**
 * One notice for a run of arrivals: "5 items added from the browser extension" once,
 * rather than five "1 item added" notices stacked on top of each other.
 *
 * The count is of arrivals since the notice appeared, and the notice stays up for
 * `durationMs` after the latest one. Neither Obsidian's Notice nor the shim's can extend a
 * running timer, so the notice is made to stay (duration 0) and this class hides it.
 * Whether it is still up is read from the page, not remembered: a click hides it, and
 * anything may remove it, and either way the next arrival starts a new count.
 */
import { Notice } from 'obsidian';

export interface CountingNoticeOptions {
    /** The text for `count` arrivals. */
    message: (count: number) => string;
    /** How long the notice stays up after the latest arrival. */
    durationMs: number;
    /** Called when the notice is clicked; the notice hides itself. */
    onClick?: () => void;
}

export class CountingNotice {
    private notice: Notice | null = null;
    private count = 0;
    private timer: number | null = null;

    constructor(private readonly options: CountingNoticeOptions) {}

    /** Adds `n` arrivals: to the notice on screen, or to a new one. */
    add(n: number): void {
        const visible = this.notice?.noticeEl?.isConnected === true;
        this.count = (visible ? this.count : 0) + n;
        const message = this.options.message(this.count);
        if (visible) {
            this.notice!.setMessage(message);
        } else {
            const notice = new Notice(message, 0);
            this.notice = notice;
            notice.noticeEl?.addEventListener('click', () => {
                if (this.notice === notice) this.reset();
                this.options.onClick?.();
            });
        }
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => this.hide(), this.options.durationMs);
    }

    hide(): void {
        this.notice?.hide();
        this.reset();
    }

    private reset(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
        this.notice = null;
        this.count = 0;
    }
}
