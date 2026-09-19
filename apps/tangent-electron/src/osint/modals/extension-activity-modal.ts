/**
 * What the browser extension added to this investigation, newest first, each with a
 * Remove button.
 *
 * Items from the extension go straight into the graph rather than waiting for approval,
 * so this dialog is the review step: it says what arrived, from which page, whether it
 * became a new entity or joined one the investigator already had, and takes back exactly
 * that item (InboxService.remove) when it should not be there.
 */
import { App, Modal, Notice } from 'obsidian';
import { entityKindLabel, type ExtensionActivityItem } from '../services/inbox-service';
import type { EntityPayload } from '../../main/osint/extension/protocol';

export interface ExtensionActivityModalHost {
    /** Read fresh on every render: another window may have added or removed items. */
    items(): Promise<ExtensionActivityItem[]>;
    remove(bundleId: string): Promise<boolean>;
}

export function activityTypeLabel(item: ExtensionActivityItem): string {
    if (item.kind === 'note') return 'Note';
    if (item.kind === 'capture') return 'Page capture';
    if (item.kind === 'highlight') return 'Highlight';
    return item.entityKind ? entityKindLabel({ kind: item.entityKind as EntityPayload['kind'] }) : 'Entity';
}

/** "merged into existing <label>", or null when the item made something new. */
export function activityMergeLabel(item: ExtensionActivityItem): string | null {
    if (item.kind === 'note' || item.kind === 'highlight' || item.outcome.created || !item.outcome.entityId) return null;
    return `merged into existing ${item.outcome.entityLabel ?? 'entity'}`;
}

/**
 * What a reader of the log must know about a capture before relying on it: the archive
 * is not of the page the extension named, or no text could be read from it.
 */
export function activityCaptureNotes(item: ExtensionActivityItem): string[] {
    if (item.kind !== 'capture') return [];
    const notes: string[] = [];
    if (item.urlMismatch) {
        notes.push(item.contentLocation
            ? `The archive's own address differs: ${item.contentLocation}`
            : 'The archive does not record its address.');
    }
    if (item.derivationFailed) notes.push('No readable text could be made from the archive; the archive itself was kept.');
    return notes;
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export class ExtensionActivityModal extends Modal {
    constructor(app: App, private readonly host: ExtensionActivityModalHost) {
        super(app);
    }

    /** Renders are numbered, so a slow read never draws over a newer one. */
    private renderSeq = 0;

    onOpen(): void {
        this.modalEl.addClass('osint-extension-activity-modal');
        this.setTitle('Browser extension activity');
        void this.render();
    }

    private async render(): Promise<void> {
        const seq = ++this.renderSeq;
        const { contentEl } = this;
        let loaded: ExtensionActivityItem[];
        try {
            loaded = await this.host.items();
        } catch (e) {
            if (seq !== this.renderSeq) return;
            contentEl.empty();
            contentEl.createEl('p', {
                text: `Could not read the browser extension activity: ${e instanceof Error ? e.message : String(e)}`,
            });
            return;
        }
        if (seq !== this.renderSeq) return;
        contentEl.empty();
        const items = [...loaded].reverse();
        if (items.length === 0) {
            contentEl.createEl('p', { text: 'Nothing has arrived from the browser extension in this investigation yet.' });
            return;
        }
        contentEl.createEl('p', {
            cls: 'osint-extension-activity-lede',
            text: 'Items the extension sent go straight into the investigation. Remove takes back exactly what one item added.',
        });
        const list = contentEl.createEl('ul', { cls: 'osint-extension-activity-list' });
        for (const item of items) {
            const row = list.createEl('li', { cls: 'osint-extension-activity-item' });
            if (item.removed) row.addClass('is-removed');
            const main = row.createDiv({ cls: 'osint-extension-activity-main' });
            const head = main.createDiv({ cls: 'osint-extension-activity-head' });
            head.createSpan({ cls: 'osint-extension-activity-type', text: activityTypeLabel(item) });
            // textContent throughout: every string here came from a web page.
            head.createSpan({ cls: 'osint-extension-activity-summary', text: item.summary || '(empty)' });
            const merged = activityMergeLabel(item);
            if (merged) main.createDiv({ cls: 'osint-extension-activity-merged', text: merged });
            for (const note of activityCaptureNotes(item)) {
                main.createDiv({ cls: 'osint-extension-activity-warning', text: note });
            }
            main.createDiv({ cls: 'osint-extension-activity-url', text: item.url, attr: { title: item.title || item.url } });
            main.createDiv({
                cls: 'osint-extension-activity-time',
                text: item.removed && item.removedAt
                    ? `${formatTime(item.receivedAt)} · removed ${formatTime(item.removedAt)}`
                    : formatTime(item.receivedAt),
            });

            const button = row.createEl('button', {
                text: item.removed ? 'Removed' : 'Remove',
                cls: item.removed ? '' : 'mod-warning',
                attr: { type: 'button' },
            });
            button.disabled = item.removed;
            if (!item.removed) {
                button.onclick = async () => {
                    button.disabled = true;
                    button.setText('Removing…');
                    try {
                        await this.host.remove(item.bundleId);
                    } catch (e) {
                        new Notice(`Could not remove it: ${e instanceof Error ? e.message : String(e)}`, 8000);
                    }
                    await this.render();
                };
            }
        }
    }

    onClose(): void {
        this.renderSeq++;
        this.contentEl.empty();
    }
}
