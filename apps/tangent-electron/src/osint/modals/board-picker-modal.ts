/**
 * The board picker behind the toolbar's Canvas button.
 *
 * Distinct from canvas/CanvasPicker.svelte, which picks a vault file to place ON a board.
 * This picks WHICH board to open, and offers a new one.
 *
 * A picker rather than "create a board" (what the New Note menu item does): every other
 * button in the toolbar pill opens something, and a create-on-click button leaves
 * "Board 2", "Board 3", "Board 4" behind for anyone who clicks it twice.
 */
import { App, Modal, TFile } from 'obsidian';
import { CANVAS_FILE_TYPE } from '../canvas/canvas-file-type';

export interface BoardPickerHost {
    /** Opens an existing board by workspace-relative path. */
    openBoard(path: string): void;
    /** Writes a new empty board and opens it. */
    createBoard(): Promise<void>;
}

interface BoardRow {
    path: string;
    /** Filename without the `.canvas` suffix. */
    title: string;
    /** Folder the board sits in, or '' at the vault root. */
    folder: string;
    mtime: number;
}

export class BoardPickerModal extends Modal {
    private rows: BoardRow[] = [];
    private listEl: HTMLElement | null = null;
    private query = '';

    constructor(app: App, private host: BoardPickerHost) {
        super(app);
    }

    onOpen(): void {
        const { contentEl, modalEl } = this;
        modalEl.addClass('osint-board-picker-modal');
        this.setTitle('Canvas boards');

        this.rows = this.collectBoards();

        const search = contentEl.createEl('input', {
            type: 'text',
            cls: 'osint-board-search',
            placeholder: this.rows.length ? 'Search boards…' : 'No boards yet',
        });
        search.oninput = () => {
            this.query = search.value.trim().toLowerCase();
            this.renderList();
        };
        search.onkeydown = (event: KeyboardEvent) => {
            if (event.key !== 'Enter' || event.isComposing) return;
            // Enter takes the first match, the way quick-open does. With no matches and a
            // query typed, it does nothing rather than silently creating a board.
            const first = this.visibleRows()[0];
            if (first) this.open_(first.path);
            else if (!this.query) void this.create();
        };

        const newButton = contentEl.createEl('button', {
            cls: 'osint-board-new',
            text: '+  New board',
        });
        newButton.onclick = () => { void this.create(); };

        this.listEl = contentEl.createDiv({ cls: 'osint-board-list' });
        this.renderList();

        search.focus();
    }

    /** Every `.canvas` file in the vault, newest first. */
    private collectBoards(): BoardRow[] {
        const suffix = CANVAS_FILE_TYPE;
        const files = this.app.vault.getFiles() as TFile[];
        return files
            .filter((file) => file.path.toLowerCase().endsWith(suffix))
            .map((file) => {
                const slash = file.path.lastIndexOf('/');
                return {
                    path: file.path,
                    title: file.path.slice(slash + 1, file.path.length - suffix.length),
                    folder: slash > 0 ? file.path.slice(0, slash) : '',
                    mtime: file.stat?.mtime ?? 0,
                };
            })
            // Recently edited first: the board you want next is nearly always the board
            // you were just on. Ties fall back to path, so the order is never arbitrary.
            .sort((a, b) => (b.mtime - a.mtime) || a.path.localeCompare(b.path));
    }

    private visibleRows(): BoardRow[] {
        if (!this.query) return this.rows;
        return this.rows.filter((row) => row.path.toLowerCase().includes(this.query));
    }

    private renderList(): void {
        const list = this.listEl;
        if (!list) return;
        list.empty();

        const rows = this.visibleRows();
        if (rows.length === 0) {
            list.createDiv({
                cls: 'osint-board-empty',
                text: this.query
                    ? `No board matches "${this.query}".`
                    : 'No boards yet. Create one to start laying a case out by hand.',
            });
            return;
        }

        for (const row of rows) {
            const item = list.createEl('button', { cls: 'osint-board-item' });
            item.createSpan({ cls: 'osint-board-title', text: row.title });
            if (row.folder) item.createSpan({ cls: 'osint-board-folder', text: row.folder });
            item.onclick = () => this.open_(row.path);
        }
    }

    private open_(path: string): void {
        this.close();
        this.host.openBoard(path);
    }

    private async create(): Promise<void> {
        this.close();
        await this.host.createBoard();
    }

    onClose(): void {
        this.contentEl.empty();
        this.listEl = null;
    }
}
