import { App, Modal, Setting } from 'obsidian';

export interface CheckboxItem {
    label: string;
    value: string;
    checked?: boolean;
}

export class ConfirmModal extends Modal {
    private title: string;
    private message: string;
    private onConfirm: (selectedValues?: string[]) => void;
    private onCancel: (() => void) | undefined;
    private destructive: boolean;
    private checkboxItems?: CheckboxItem[];
    private confirmText: string;
    private cancelText: string;
    /** True once a button decided the outcome; onClose treats anything else as cancel. */
    private settled = false;

    constructor(
        app: App,
        title: string,
        message: string,
        onConfirm: (selectedValues?: string[]) => void,
        onCancel?: () => void,
        destructive: boolean = false,
        checkboxItems?: CheckboxItem[],
        confirmText: string = 'Confirm',
        cancelText: string = 'Cancel'
    ) {
        super(app);
        // A stray backdrop click must not dismiss a confirmation -- and it used to, because
        // the old stopPropagation hack ran after the base class's own backdrop listener.
        this.closeOnBackgroundClick = false;
        this.title = title;
        this.message = message;
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
        this.destructive = destructive;
        this.checkboxItems = checkboxItems;
        this.confirmText = confirmText;
        this.cancelText = cancelText;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('vault-ai-confirm-modal');

        contentEl.createEl('h2', { text: this.title });
        contentEl.createDiv({ text: this.message, cls: 'vault-ai-confirm-message' });

        const selectedValues = new Set<string>();

        if (this.checkboxItems && this.checkboxItems.length > 0) {
            const checkboxContainer = contentEl.createDiv({ cls: 'vault-ai-confirm-checkboxes' });
            checkboxContainer.style.maxHeight = '300px';
            checkboxContainer.style.overflowY = 'auto';
            checkboxContainer.style.marginBottom = '20px';
            checkboxContainer.style.padding = '10px';
            checkboxContainer.style.border = '1px solid var(--background-modifier-border)';
            checkboxContainer.style.borderRadius = '4px';

            for (const item of this.checkboxItems) {
                if (item.checked !== false) {
                    selectedValues.add(item.value);
                }

                const labelEl = checkboxContainer.createEl('label', { cls: 'vault-ai-checkbox-label' });
                labelEl.style.display = 'flex';
                labelEl.style.alignItems = 'flex-start'; // Align top in case of wrapping
                labelEl.style.marginBottom = '8px';
                labelEl.style.cursor = 'pointer';

                const cb = labelEl.createEl('input');
                cb.type = 'checkbox';
                cb.value = item.value;
                cb.checked = item.checked !== false; // Default to true unless explicitly false
                cb.style.marginRight = '8px';
                cb.style.marginTop = '4px'; // Better vertical alignment for multi-line

                // Use markdown-style parsing for bold syntax using a helper
                const textContainer = labelEl.createSpan();
                this.renderMarkdownText(textContainer, item.label);

                cb.addEventListener('change', (e) => {
                    const target = e.target as HTMLInputElement;
                    if (target.checked) {
                        selectedValues.add(item.value);
                    } else {
                        selectedValues.delete(item.value);
                    }
                });
            }
        }

        const buttonContainer = contentEl.createDiv({ cls: 'graph_copilot-confirm-buttons' });

        const cancelButton = buttonContainer.createEl('button', { text: this.cancelText });
        cancelButton.addEventListener('click', () => {
            this.settled = true;
            if (this.onCancel) this.onCancel();
            this.close();
        });

        const confirmButton = buttonContainer.createEl('button', {
            text: this.confirmText,
            cls: this.destructive ? 'mod-warning graph_copilot-confirm-btn--danger' : 'mod-cta'
        });

        confirmButton.addEventListener('click', () => {
            this.settled = true;
            this.onConfirm(this.checkboxItems && this.checkboxItems.length > 0 ? Array.from(selectedValues) : undefined);
            this.close();
        });

        // Keyboard users land on the SAFE button: a destructive dialog that focused
        // "Delete" let a stray Enter or Space destroy the file. The base class focuses
        // the first control synchronously in open(), so this runs after it.
        setTimeout(() => (this.destructive ? cancelButton : confirmButton).focus(), 0);
    }

    onClose() {
        // Escape and the close button end here without a button click; callers waiting
        // on a Promise resolved only from the buttons hung forever, and cancel side
        // effects never ran.
        if (!this.settled) {
            this.settled = true;
            if (this.onCancel) this.onCancel();
        }
        const { contentEl } = this;
        contentEl.empty();
    }

    private renderMarkdownText(container: HTMLElement, text: string) {
        // Simple markdown parser for **bold** text
        const parts = text.split(/(\*\*.*?\*\*)/g);
        for (const part of parts) {
            if (part.startsWith('**') && part.endsWith('**')) {
                const boldText = part.substring(2, part.length - 2);
                container.createEl('strong', { text: boldText });
            } else if (part) {
                container.appendChild(document.createTextNode(part));
            }
        }
    }
}
