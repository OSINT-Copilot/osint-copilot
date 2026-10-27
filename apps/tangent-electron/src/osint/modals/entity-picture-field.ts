/**
 * The "Picture" control in the entity create and edit dialogs.
 *
 * One function called from both, rather than a third copy of createFileUploadField --
 * which already exists twice, near-identically, in this folder. Adding a third would have
 * made that worse; this at least does not.
 *
 * It writes `properties.image`: a picture OF the entity, which any type may have. That is
 * distinct from the existing `filePath` upload, which means "the file this entity IS" and
 * still applies only to Image, Video, Audio, Photo and Evidence.
 *
 * Everything here is built with createEl/textContent. The previous field interpolated the
 * stored path into innerHTML, and that path now comes from a language model reading
 * attacker-controlled pages -- see the note on renderCurrent below.
 */
import { Notice, TFile, normalizePath, type App } from 'obsidian';
import { importedFileName } from '../canvas/canvas-runtime';
import { ensureFolderExists } from '../utils/vault-bootstrap-fs';
import { isGraphImageExtension } from '../views/graph-node-visual';

/** What the graph is willing to paint, as an <input accept> list. */
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml';

export interface EntityPictureFieldOptions {
    app: App;
    container: HTMLElement;
    /** Vault-relative path already stored on the entity, if any. */
    currentValue?: string;
    /** Folder imports are written to, vault-relative. */
    folder: string;
    /** Called with the new vault-relative path, or '' when the picture is removed. */
    onChange(path: string): void;
}

export function createEntityPictureField(options: EntityPictureFieldOptions): void {
    const { app, container } = options;
    let current = typeof options.currentValue === 'string' ? options.currentValue : '';

    const field = container.createDiv({ cls: 'graph_copilot-entity-picture' });
    field.createEl('label', { text: 'Picture', cls: 'graph_copilot-entity-picture-label' });

    const zone = field.createDiv({ cls: 'graph_copilot-entity-picture-zone' });
    const preview = zone.createDiv({ cls: 'graph_copilot-entity-picture-preview' });
    const status = zone.createDiv({ cls: 'graph_copilot-entity-picture-status' });

    const actions = zone.createDiv({ cls: 'graph_copilot-entity-picture-actions' });
    const chooseBtn = actions.createEl('button', { text: 'Choose image…', attr: { type: 'button' } });
    const removeBtn = actions.createEl('button', { text: 'Remove', attr: { type: 'button' } });

    const fileInput = zone.createEl('input', { type: 'file', attr: { accept: ACCEPT } });
    fileInput.style.display = 'none';

    /**
     * Renders whatever is currently set.
     *
     * The path goes in through textContent and the image through a src attribute, never
     * through innerHTML. This field's predecessor interpolated the same value into an
     * HTML string, which was already unwise for a filename and is now genuinely unsafe:
     * `image` can be written by the extraction pipeline from a page the model was reading,
     * and this renderer has window.api and no CSP behind it.
     */
    function renderCurrent(): void {
        preview.empty();
        status.empty();
        removeBtn.style.display = current ? '' : 'none';
        chooseBtn.textContent = current ? 'Replace image…' : 'Choose image…';

        if (!current) {
            status.setText('No picture. The graph shows this entity as a coloured tile.');
            return;
        }

        const file = app.vault.getAbstractFileByPath(normalizePath(current));
        if (file instanceof TFile) {
            // getResourcePath returns a file:// URL with a cache-busting mtime; it used to
            // return an osint-vault:// URL that nothing served, which is the reason this
            // preview was a TODO for so long.
            const img = preview.createEl('img', { attr: { src: app.vault.getResourcePath(file), alt: current } });
            img.style.cssText = 'max-width: 160px; max-height: 120px; border-radius: 4px; display: block;';
        } else {
            status.setText('This file is not in the vault.');
        }
        preview.createDiv({ cls: 'graph_copilot-entity-picture-path', text: current });
    }

    async function accept(file: File): Promise<void> {
        if (!isGraphImageExtension(file.name)) {
            new Notice('That is not an image the graph can show.', 6000, 'warning');
            return;
        }
        try {
            status.setText(`Importing ${file.name}…`);
            const bytes = await file.arrayBuffer();
            const folder = normalizePath(options.folder);
            await ensureFolderExists(app, folder);

            // Content-hash naming, so two different files both called "photo.jpg" cannot
            // silently become one -- the bug the graph's own file drop still had.
            const path = normalizePath(`${folder}/${importedFileName(file.name, bytes)}`);
            const existing = app.vault.getAbstractFileByPath(path);
            if (!(existing instanceof TFile)) {
                await app.vault.createBinary(path, bytes);
            }

            current = path;
            options.onChange(path);
            renderCurrent();
        } catch (error) {
            console.error('[osint] could not import the picture', error);
            status.setText('Could not import that image.');
            new Notice('Could not import that image.', 6000, 'error');
        }
    }

    chooseBtn.onclick = () => fileInput.click();
    removeBtn.onclick = () => {
        // The file itself stays in the vault: it may be case material, and clearing a
        // field is not a decision to delete something collected.
        current = '';
        options.onChange('');
        renderCurrent();
    };

    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) void accept(file);
    });

    zone.addEventListener('dragover', (event) => {
        event.preventDefault();
        zone.addClass('is-dragging');
    });
    zone.addEventListener('dragleave', () => zone.removeClass('is-dragging'));
    zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.removeClass('is-dragging');
        const file = (event as DragEvent).dataTransfer?.files?.[0];
        if (file) void accept(file);
    });

    renderCurrent();
}
