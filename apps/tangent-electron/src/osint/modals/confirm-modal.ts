import { App, Modal } from 'obsidian';

export class ConfirmModal extends Modal {
    private title: string;
    private message: string;
    private onConfirm: () => void;
    private onCancel: (() => void) | undefined;
    private destructive: boolean;
    private confirmText: string;
    private cancelText: string;
    /** True once a button decided the outcome; onClose treats anything else as cancel. */
    private settled = false;

    constructor(
        app: App,
        title: string,
        message: string,
        onConfirm: () => void,
        onCancel?: () => void,
        destructive: boolean = false,
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
        this.confirmText = confirmText;
        this.cancelText = cancelText;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('vault-ai-confirm-modal');

        contentEl.createEl('h2', { text: this.title });
        contentEl.createDiv({ text: this.message, cls: 'vault-ai-confirm-message' });

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
            this.onConfirm();
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
}
