import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createEntityPictureField } from '../modals/entity-picture-field';
import { createTestAppAsync } from '../obsidian-shim/testing/create-test-app';

const FOLDER = 'OSINTCopilot/Evidence';

/** jsdom's File has no arrayBuffer in every version; the field only needs those bytes. */
function fileOf(name: string, bytes: number[]): File {
    const file = new File([new Uint8Array(bytes)], name, { type: 'image/png' });
    if (typeof file.arrayBuffer !== 'function') {
        Object.defineProperty(file, 'arrayBuffer', {
            value: async () => new Uint8Array(bytes).buffer,
        });
    }
    return file;
}

/** The field takes files by drop; there is no way to populate input.files in jsdom. */
async function drop(container: HTMLElement, file: File): Promise<void> {
    const zone = container.querySelector('.graph_copilot-entity-picture-zone') as HTMLElement;
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
    zone.dispatchEvent(event);
    // The handler is async; let its promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
}

let container: HTMLElement;
beforeEach(() => {
    container = document.body.createDiv();
});
afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('the stored path is rendered as text, never as markup', () => {
    it('does not build elements out of a hostile path', async () => {
        /*
         * `image` is an entity property, and entity properties are written by the
         * extraction pipeline from pages the model reads -- so this value is
         * attacker-influenceable. The field it replaced spliced exactly this value into an
         * innerHTML template, in a renderer that exposes window.api and has no CSP.
         */
        const payload = '<img src=x onerror="window.__pwned = true">';
        const app = await createTestAppAsync();
        createEntityPictureField({
            app: app as never, container, currentValue: payload, folder: FOLDER,
            onChange: () => {},
        });

        expect(container.querySelectorAll('img').length).toBe(0);
        expect(container.querySelectorAll('script').length).toBe(0);
        expect(container.innerHTML).not.toContain('<img');
        // Present, escaped, and readable -- the point is to show the path, safely.
        expect(container.textContent).toContain(payload);
        expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    });

    it('previews a real vault image with a loadable src', async () => {
        const app = await createTestAppAsync({ files: { 'OSINTCopilot/Evidence/ada.png': 'x' } });
        createEntityPictureField({
            app: app as never, container, currentValue: 'OSINTCopilot/Evidence/ada.png',
            folder: FOLDER, onChange: () => {},
        });

        const img = container.querySelector('img');
        expect(img).not.toBeNull();
        // The osint-vault:// scheme nothing served is exactly what made this a TODO.
        expect(img!.getAttribute('src')).toContain('file://');
        expect(img!.getAttribute('src')).toContain('ada.png');
    });

    it('says so when the path names a file that is not there', async () => {
        const app = await createTestAppAsync();
        createEntityPictureField({
            app: app as never, container, currentValue: 'Evidence/gone.png',
            folder: FOLDER, onChange: () => {},
        });

        expect(container.querySelectorAll('img').length).toBe(0);
        expect(container.textContent).toContain('not in the vault');
    });

    it('offers no picture and no Remove button when there is nothing set', async () => {
        const app = await createTestAppAsync();
        createEntityPictureField({
            app: app as never, container, folder: FOLDER, onChange: () => {},
        });

        const remove = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
        expect(remove!.style.display).toBe('none');
        expect(container.textContent).toContain('coloured tile');
    });
});

describe('attaching a picture', () => {
    it('imports the file into the vault and reports the path', async () => {
        const app = await createTestAppAsync();
        const changes: string[] = [];
        createEntityPictureField({
            app: app as never, container, folder: FOLDER, onChange: (p) => changes.push(p),
        });

        await drop(container, fileOf('portrait.png', [1, 2, 3]));

        expect(changes).toHaveLength(1);
        expect(changes[0].startsWith(`${FOLDER}/`)).toBe(true);
        expect(app.vault.getAbstractFileByPath(changes[0])).toBeTruthy();
    });

    it('keeps two different files that share a name apart', async () => {
        // The content hash is what stops the graph's older importer behaviour, where the
        // second "photo.jpg" silently reused the first one's bytes.
        const app = await createTestAppAsync();
        const changes: string[] = [];
        createEntityPictureField({
            app: app as never, container, folder: FOLDER, onChange: (p) => changes.push(p),
        });

        await drop(container, fileOf('photo.png', [1, 1, 1, 1]));
        await drop(container, fileOf('photo.png', [9, 9, 9, 9]));

        expect(changes).toHaveLength(2);
        expect(changes[0]).not.toBe(changes[1]);
        expect(app.storage.paths().filter((p) => p.startsWith(`${FOLDER}/`))).toHaveLength(2);
    });

    it('refuses a file the graph could not draw, and writes nothing', async () => {
        const app = await createTestAppAsync();
        const changes: string[] = [];
        createEntityPictureField({
            app: app as never, container, folder: FOLDER, onChange: (p) => changes.push(p),
        });

        await drop(container, fileOf('report.pdf', [1, 2, 3]));

        expect(changes).toHaveLength(0);
        expect(app.storage.paths().filter((p) => p.startsWith(`${FOLDER}/`))).toHaveLength(0);
    });
});

describe('removing a picture', () => {
    it('clears the property but leaves the collected file alone', async () => {
        const app = await createTestAppAsync({ files: { 'OSINTCopilot/Evidence/ada.png': 'x' } });
        const changes: string[] = [];
        createEntityPictureField({
            app: app as never, container, currentValue: 'OSINTCopilot/Evidence/ada.png',
            folder: FOLDER, onChange: (p) => changes.push(p),
        });

        const remove = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Remove');
        remove!.click();

        expect(changes).toEqual(['']);
        expect(container.querySelectorAll('img').length).toBe(0);
        // Clearing a field is not a decision to delete case material.
        expect(app.vault.getAbstractFileByPath('OSINTCopilot/Evidence/ada.png')).toBeTruthy();
    });
});
