/**
 * The words and numbers the browser-extension settings show, kept out of the Svelte
 * component so they can be tested without rendering it.
 */
import type { ExtensionStatus } from '../host/types';

/** "4:59" for what is left of a pairing string's five minutes. Never negative. */
export function formatCountdown(msLeft: number): string {
    const total = Math.max(0, Math.ceil(msLeft / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** When a paired extension last talked to the app. */
export function formatLastSeen(iso: string | null, now: number = Date.now()): string {
    if (!iso) return 'never';
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return 'unknown';
    const ago = Math.max(0, now - at);
    if (ago < 60_000) return 'just now';
    if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
    if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)} h ago`;
    return new Date(at).toLocaleDateString();
}

/** One line on whether the channel is up, and if not, why not. */
export function extensionStatusLine(status: ExtensionStatus): string {
    if (status.problem) return `Unavailable: ${status.problem}`;
    if (!status.enabled) return 'Off. The app is not listening for the extension.';
    if (!status.licensed) return 'On, but not running: this licence does not include OSINT features.';
    if (!status.running || status.port === null) return 'On, but not running: no local port could be opened.';
    return `Running on 127.0.0.1:${status.port}.`;
}
