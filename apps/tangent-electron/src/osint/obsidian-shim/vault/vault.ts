/**
 * The Vault -- Obsidian's filesystem API over a VaultStorage backend.
 *
 * Two things here are load-bearing and were established empirically in Phase 0:
 *
 * 1. The index is SYNCHRONOUS and complete in this process. getAbstractFileByPath
 *    is called 74 times and `instanceof TFile` 86 times, all in synchronous control
 *    flow; making them async would be a ~160-site refactor, and ipcRenderer.sendSync
 *    would block the renderer at every graph render.
 *
 * 2. Events fire SYNCHRONOUSLY from the mutating call, before any filesystem
 *    notification. That is Obsidian's actual semantics, and it is the primary
 *    defence against echo loops: the watcher path exists only for out-of-band edits,
 *    and main separately suppresses the echo of our own writes.
 */
import type { StatDto, WatchEvent } from '../../host/types';
import { normalizePath } from './normalize-path';
import { TAbstractFile, TFile, TFolder, makeFile, makeFolder } from './tfile';
import type { VaultStorage } from './storage';

export type VaultEventName = 'create' | 'modify' | 'delete' | 'rename';
type Handler = (file: TAbstractFile, oldPath: string) => void;

export interface EventRef {
    name: VaultEventName;
    handler: Handler;
    /** Component.registerEvent(ref) calls this on unload. */
    detach(): void;
}

/**
 * Parent of a vault path, or '/' for a top-level entry.
 *
 * The naive `path.slice(0, path.lastIndexOf('/'))` is wrong for top-level paths:
 * lastIndexOf returns -1, so slice(0, -1) chops the final CHARACTER rather than the
 * final segment. That made ensureFolder recurse one character at a time and create a
 * phantom folder for every prefix -- "I", "In", "Inv", ... -- which is exactly how it
 * showed up in the file explorer.
 */
function parentPathOf(path: string): string {
    const at = path.lastIndexOf('/');
    return at <= 0 ? '/' : path.slice(0, at);
}

export class Vault {
    private index = new Map<string, TAbstractFile>();
    private handlers = new Map<VaultEventName, Set<Handler>>();
    private contentCache = new Map<string, { key: string; data: string }>();

    readonly root: TFolder;

    constructor(private readonly storage: VaultStorage) {
        this.root = makeFolder('/', null);
        this.index.set('/', this.root);
    }

    /** Builds the index from one bulk snapshot, then subscribes to out-of-band changes. */
    async open(): Promise<void> {
        const snapshot = await this.storage.snapshot();
        // Shallow paths first so a parent always exists before its children.
        for (const stat of [...snapshot].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
            this.upsert(stat);
        }
        this.storage.onChange((events) => this.applyWatchEvents(events));
    }

    getBasePath(): string {
        return this.storage.basePath();
    }

    // ------------------------------------------------------------------ events

    on(name: VaultEventName, handler: Handler): EventRef {
        if (!this.handlers.has(name)) this.handlers.set(name, new Set());
        this.handlers.get(name)!.add(handler);
        return { name, handler, detach: () => this.handlers.get(name)?.delete(handler) };
    }

    offref(ref: EventRef | null | undefined): void {
        if (ref) this.handlers.get(ref.name)?.delete(ref.handler);
    }

    private emit(name: VaultEventName, file: TAbstractFile, oldPath = ''): void {
        for (const handler of [...(this.handlers.get(name) ?? [])]) handler(file, oldPath);
    }

    // ------------------------------------------------------------------ lookup

    /**
     * Never throws. "" and "/" both resolve to the root folder; a miss is null, not
     * an exception -- callers branch on null and an exception here would surface as
     * an unrelated failure deep inside entity loading.
     */
    getAbstractFileByPath(path: string): TAbstractFile | null {
        return this.index.get(normalizePath(path)) ?? null;
    }

    getFiles(): TFile[] {
        return [...this.index.values()].filter((f): f is TFile => f instanceof TFile);
    }

    getMarkdownFiles(): TFile[] {
        return this.getFiles().filter((f) => f.extension === 'md');
    }

    getAllLoadedFiles(): TAbstractFile[] {
        return [...this.index.values()];
    }

    // ---------------------------------------------------------------- mutation

    async createFolder(path: string): Promise<TFolder> {
        const target = normalizePath(path);
        if (this.index.has(target)) throw new Error('Folder already exists.');
        const stat = await this.storage.mkdir(target);
        const folder = this.upsert(stat) as TFolder;
        this.emit('create', folder);
        return folder;
    }

    async create(path: string, data: string): Promise<TFile> {
        const target = normalizePath(path);
        if (this.index.has(target)) throw new Error('File already exists.');
        const stat = await this.storage.create(target, data);
        const file = this.upsert(stat) as TFile;
        this.cache(file, data);
        this.emit('create', file);
        return file;
    }

    /** Binary create -- chat attachments, graph image drops, entity media. */
    async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
        const target = normalizePath(path);
        if (this.index.has(target)) throw new Error('File already exists.');
        // One write, and it is the bytes. The second call here used to be
        // `storage.write(target, '')` purely to obtain a stat -- which truncated the file
        // that had just been written, so every dropped image landed as zero bytes.
        const stat = await this.storage.writeBinary(target, new Uint8Array(data));
        const file = this.upsert({ ...stat, path: target, type: 'file' }) as TFile;
        this.emit('create', file);
        return file;
    }

    async readBinary(file: TFile): Promise<ArrayBuffer> {
        // Bytes from the host, not a UTF-8 decode re-encoded as latin1: that path replaced
        // every invalid sequence with U+FFFD, so the extractor was handed corrupt PDFs.
        const bytes = await this.storage.readBinary(file.path);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }

    /**
     * Displayable URL for a vault file -- graph node thumbnails (graph-view.ts).
     *
     * This used to return `osint-vault://<path>`, and NOTHING IN THE APP EVER SERVED THAT
     * SCHEME: there is no protocol.handle or registerFileProtocol anywhere in src/main.
     * So every graph thumbnail since the Tangent port has failed to load and painted the
     * node's background colour instead. It worked in the Obsidian original, where
     * getResourcePath returned an app:// URL the host did serve.
     *
     * The host builds the URL (Tangent serves its window from file://, so a vault file is
     * directly referenceable) and the mtime query busts Electron's image cache, which
     * otherwise serves a stale picture forever after a re-import.
     *
     * Two properties of the result are load-bearing for the graph, and both come from the
     * host's per-segment encoding:
     *   - no whitespace: cytoscape's `background-image` is a multi-valued `urls` property
     *     and it splits a mapped value on /\s+/, so one URL with a space becomes two
     *     broken ones.
     *   - '#', '?' and '&' encoded: entity labels routinely contain all three.
     */
    getResourcePath(file: TFile): string {
        return `${this.storage.resourceUrl(file.path)}?v=${file.stat.mtime}`;
    }

    async read(file: TFile): Promise<string> {
        const data = await this.storage.read(file.path);
        this.cache(file, data);
        return data;
    }

    /**
     * Read-through cached, keyed on path+mtime+size.
     *
     * Not a micro-optimisation: orchestration-service uses it in read-every-file
     * loops over an unbounded getMarkdownFiles(), so without a cache every
     * orchestration turn costs N IPC round-trips.
     */
    async cachedRead(file: TFile): Promise<string> {
        const key = `${file.stat.mtime}:${file.stat.size}`;
        const hit = this.contentCache.get(file.path);
        if (hit && hit.key === key) return hit.data;
        return this.read(file);
    }

    async modify(file: TFile, data: string): Promise<void> {
        const stat = await this.storage.write(file.path, data);
        this.applyStat(file, stat);
        this.cache(file, data);
        this.emit('modify', file);
    }

    async delete(file: TAbstractFile, _force = false): Promise<void> {
        await this.storage.remove(file.path);
        this.detach(file);
        this.emit('delete', file);
    }

    async trash(file: TAbstractFile, _system = true): Promise<void> {
        await this.storage.trash(file.path);
        this.detach(file);
        this.emit('delete', file);
    }

    async rename(file: TAbstractFile, newPath: string): Promise<void> {
        const target = normalizePath(newPath);
        const oldPath = file.path;
        await this.storage.rename(oldPath, target);
        this.reindexSubtree(file, target);
        this.emit('rename', file, oldPath);
    }

    // ----------------------------------------------------------------- adapter

    /** Obsidian's low-level DataAdapter; conversation-service uses it exclusively. */
    readonly adapter = {
        exists: async (path: string): Promise<boolean> => this.getAbstractFileByPath(path) !== null,
        read: async (path: string): Promise<string> => {
            const file = this.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
            return this.read(file);
        },
        write: async (path: string, data: string): Promise<void> => {
            const existing = this.getAbstractFileByPath(path);
            if (existing instanceof TFile) await this.modify(existing, data);
            else await this.create(path, data);
        },
        writeBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
            const target = normalizePath(path);
            const existing = this.getAbstractFileByPath(target);
            if (existing instanceof TFile) {
                // Straight to the backend as bytes. This used to latin1-decode into a
                // string and call storage.write, handing a UTF-8 encoder byte values it
                // would re-encode -- silently corrupting every image and PDF.
                const stat = await this.storage.writeBinary(target, new Uint8Array(data));
                this.applyStat(existing, stat);
                this.emit('modify', existing);
            } else {
                // createBinary indexes the new file. Writing through the backend alone
                // left it invisible to getAbstractFileByPath and getFiles, so a thumbnail
                // written this way could never be found again.
                await this.createBinary(target, data);
            }
            // The text cache is keyed by path; a binary overwrite must not leave a stale
            // text entry behind for the same path.
            this.contentCache.delete(target);
        },
        mkdir: async (path: string): Promise<void> => {
            if (!this.getAbstractFileByPath(path)) await this.createFolder(path);
        },
        remove: async (path: string): Promise<void> => {
            const file = this.getAbstractFileByPath(path);
            if (file) await this.delete(file);
        },
        stat: async (path: string): Promise<{ type: 'file' | 'folder'; mtime: number; size: number } | null> => {
            const file = this.getAbstractFileByPath(path);
            if (!file) return null;
            if (file instanceof TFile) return { type: 'file', mtime: file.stat.mtime, size: file.stat.size };
            return { type: 'folder', mtime: 0, size: 0 };
        },
        list: async (path: string): Promise<{ files: string[]; folders: string[] }> => {
            const folder = this.getAbstractFileByPath(path);
            if (!(folder instanceof TFolder)) return { files: [], folders: [] };
            return {
                files: folder.children.filter((c) => c instanceof TFile).map((c) => c.path),
                folders: folder.children.filter((c) => c instanceof TFolder).map((c) => c.path),
            };
        },
        getBasePath: (): string => this.storage.basePath(),
    };

    // ----------------------------------------------------------------- private

    private cache(file: TFile, data: string): void {
        this.contentCache.set(file.path, { key: `${file.stat.mtime}:${file.stat.size}`, data });
    }

    private applyStat(file: TAbstractFile, stat: StatDto): void {
        if (file instanceof TFile) {
            file.stat = { ctime: stat.ctime, mtime: stat.mtime, size: stat.size };
        }
    }

    /** Inserts or updates a node, creating any missing ancestor folders. */
    private upsert(stat: StatDto): TAbstractFile {
        const path = normalizePath(stat.path);
        if (path === '/') return this.root;

        const existing = this.index.get(path);
        if (existing) {
            this.applyStat(existing, stat);
            return existing;
        }

        const parent = this.ensureFolder(parentPathOf(path));
        const node = stat.type === 'folder'
            ? makeFolder(path, parent)
            : makeFile(path, parent, { ctime: stat.ctime, mtime: stat.mtime, size: stat.size });
        this.index.set(path, node);
        parent.children.push(node);
        return node;
    }

    private ensureFolder(path: string): TFolder {
        const target = path === '' ? '/' : normalizePath(path);
        const existing = this.index.get(target);
        if (existing instanceof TFolder) return existing;
        if (target === '/') return this.root;

        const parent = this.ensureFolder(parentPathOf(target));
        const folder = makeFolder(target, parent);
        this.index.set(target, folder);
        parent.children.push(folder);
        return folder;
    }

    private detach(file: TAbstractFile): void {
        if (file instanceof TFolder) {
            for (const child of [...file.children]) this.detach(child);
        }
        this.index.delete(file.path);
        this.contentCache.delete(file.path);
        const siblings = file.parent?.children;
        if (siblings) {
            const at = siblings.indexOf(file);
            if (at >= 0) siblings.splice(at, 1);
        }
    }

    private reindexSubtree(file: TAbstractFile, newPath: string): void {
        const oldPath = file.path;
        const descendants = [...this.index.values()].filter((n) => n.path.startsWith(`${oldPath}/`));

        this.detach(file);
        file.path = newPath;
        file.name = newPath.slice(newPath.lastIndexOf('/') + 1);
        if (file instanceof TFile) {
            const dot = file.name.lastIndexOf('.');
            file.basename = dot > 0 ? file.name.slice(0, dot) : file.name;
            file.extension = dot > 0 ? file.name.slice(dot + 1) : '';
        }
        const parent = this.ensureFolder(parentPathOf(newPath));
        file.parent = parent;
        parent.children.push(file);
        this.index.set(newPath, file);

        for (const node of descendants) {
            const moved = newPath + node.path.slice(oldPath.length);
            this.index.delete(node.path);
            this.contentCache.delete(node.path);
            node.path = moved;
            this.index.set(moved, node);
        }
    }

    /** Applies out-of-band filesystem changes. Self-writes are suppressed in main. */
    private applyWatchEvents(events: WatchEvent[]): void {
        for (const event of events) {
            if (event.kind === 'delete') {
                const file = this.index.get(event.path);
                if (file) {
                    this.detach(file);
                    this.emit('delete', file);
                }
                continue;
            }
            if (event.kind === 'rename') {
                // The watcher reports a move as one event; without this branch the file
                // was indexed at its new path and LEFT at its old one, so
                // getAbstractFileByPath(oldPath) kept returning a file that no longer
                // existed, and no 'rename' ever reached the lock service.
                const previous = event.oldPath ? this.index.get(event.oldPath) : undefined;
                if (previous) this.detach(previous);
                if (!event.stat) continue;
                const node = this.upsert(event.stat);
                this.contentCache.delete(event.path);
                if (event.oldPath) this.emit('rename', node, event.oldPath);
                else this.emit('create', node);
                continue;
            }
            if (!event.stat) continue;
            const existed = this.index.has(event.path);
            const node = this.upsert(event.stat);
            this.contentCache.delete(event.path);
            this.emit(existed ? 'modify' : 'create', node);
        }
    }
}
