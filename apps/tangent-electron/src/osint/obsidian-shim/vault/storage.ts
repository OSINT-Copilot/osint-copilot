/**
 * Storage backend for the Vault.
 *
 * There is exactly ONE implementation of vault semantics (index tree, event
 * emission, Obsidian's error strings) -- it lives in vault.ts and sits on top of
 * this interface. Two backends satisfy it:
 *   host.vault    real filesystem, over IPC in the renderer
 *   MemoryStorage tests
 *
 * Writing a second in-memory Vault for tests would let the two drift, and the
 * drift would hide exactly the index-coherence bugs this design exists to prevent.
 */
import type { StatDto, WatchEvent } from '../../host/types';

export interface VaultStorage {
    /** Full tree, once, at open. */
    snapshot(): Promise<StatDto[]>;
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<StatDto>;
    /**
     * Real bytes, not text.
     *
     * Without this the only way down to disk was `write`, so binary content had to be
     * squeezed through a string -- which corrupts it, because the byte-preserving latin1
     * decode on the way in is undone by a UTF-8 encode on the way out.
     */
    writeBinary(path: string, data: Uint8Array): Promise<StatDto>;
    /**
     * Real bytes on the way in as well. `read` decodes as UTF-8, which replaces every
     * invalid sequence with U+FFFD -- so a PDF or image round-tripped through it was
     * corrupt and the wrong length.
     */
    readBinary(path: string): Promise<Uint8Array>;
    /** Throws Error("File already exists.") if present. */
    create(path: string, data: string): Promise<StatDto>;
    /** Creates intermediates; throws Error("Folder already exists.") if the target exists. */
    mkdir(path: string): Promise<StatDto>;
    remove(path: string): Promise<void>;
    trash(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    onChange(callback: (events: WatchEvent[]) => void): () => void;
    basePath(): string;
}

/** In-memory backend used by tests. Mirrors the real backend's error contract exactly. */
export class MemoryStorage implements VaultStorage {
    private files = new Map<string, string>();
    private folders = new Set<string>();
    private stats = new Map<string, StatDto>();
    private clock = 1;

    async snapshot(): Promise<StatDto[]> {
        return [...this.stats.values()];
    }

    async read(path: string): Promise<string> {
        const data = this.files.get(path);
        if (data === undefined) throw new Error(`File not found: ${path}`);
        return data;
    }

    async write(path: string, data: string): Promise<StatDto> {
        this.ensureParents(path);
        this.files.set(path, data);
        return this.stamp(path, 'file', data.length);
    }

    async writeBinary(path: string, data: Uint8Array): Promise<StatDto> {
        // The in-memory backend has no real disk, so it keeps the byte-preserving latin1
        // form. Round-tripping through readBinary is lossless because both directions use
        // latin1; nothing here ever re-encodes as UTF-8.
        this.ensureParents(path);
        let binary = '';
        for (const byte of data) binary += String.fromCharCode(byte);
        this.files.set(path, binary);
        return this.stamp(path, 'file', data.length);
    }

    async readBinary(path: string): Promise<Uint8Array> {
        // The in-memory form is latin1, one char per byte (see writeBinary), so this is
        // the exact inverse and never touches UTF-8.
        const text = await this.read(path);
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
        return bytes;
    }

    async create(path: string, data: string): Promise<StatDto> {
        if (this.files.has(path) || this.folders.has(path)) throw new Error('File already exists.');
        return this.write(path, data);
    }

    async mkdir(path: string): Promise<StatDto> {
        if (this.folders.has(path) || this.files.has(path)) throw new Error('Folder already exists.');
        this.ensureParents(path);
        this.folders.add(path);
        return this.stamp(path, 'folder', 0);
    }

    async remove(path: string): Promise<void> {
        for (const key of [...this.files.keys(), ...this.folders]) {
            if (key === path || key.startsWith(`${path}/`)) {
                this.files.delete(key);
                this.folders.delete(key);
                this.stats.delete(key);
            }
        }
    }

    async trash(path: string): Promise<void> {
        return this.remove(path);
    }

    async rename(from: string, to: string): Promise<void> {
        const data = this.files.get(from);
        if (data !== undefined) {
            await this.remove(from);
            await this.write(to, data);
            return;
        }
        for (const key of [...this.files.keys(), ...this.folders].filter((k) => k === from || k.startsWith(`${from}/`))) {
            const moved = to + key.slice(from.length);
            if (this.files.has(key)) {
                const content = this.files.get(key)!;
                await this.remove(key);
                await this.write(moved, content);
            } else {
                this.folders.delete(key);
                this.stats.delete(key);
                this.folders.add(moved);
                this.stamp(moved, 'folder', 0);
            }
        }
    }

    /** Synchronous accessor for assertions. Test-only backend, so this stays here. */
    peek(path: string): string | undefined {
        return this.files.get(path);
    }

    /** Every path in the store, sorted. */
    paths(): string[] {
        return [...this.files.keys(), ...this.folders].sort();
    }

    /** Tests drive the Vault directly; nothing external mutates this store. */
    onChange(): () => void {
        return () => { /* no external writer */ };
    }

    basePath(): string {
        return '/memory';
    }

    /** Creates missing ancestor folders, matching mkdir -p on the real backend. */
    private ensureParents(path: string): void {
        const segments = path.split('/');
        segments.pop();
        let sofar = '';
        for (const segment of segments) {
            sofar = sofar ? `${sofar}/${segment}` : segment;
            if (!this.folders.has(sofar)) {
                this.folders.add(sofar);
                this.stamp(sofar, 'folder', 0);
            }
        }
    }

    private stamp(path: string, type: 'file' | 'folder', size: number): StatDto {
        const existing = this.stats.get(path);
        const stat: StatDto = {
            path,
            type,
            ctime: existing?.ctime ?? this.clock,
            mtime: this.clock++,
            size,
        };
        this.stats.set(path, stat);
        return stat;
    }
}

/** Adapts the host's vault surface to VaultStorage. */
export function hostStorage(host: { vault: import('../../host/types').VaultHost }, dir: string): VaultStorage {
    return {
        snapshot: () => host.vault.open(dir),
        read: (p) => host.vault.read(p),
        write: (p, d) => host.vault.write(p, d),
        writeBinary: (p, d) => host.vault.writeBinary(p, d),
        readBinary: (p) => host.vault.readBinary(p),
        create: (p, d) => host.vault.create(p, d),
        mkdir: (p) => host.vault.mkdir(p),
        remove: (p) => host.vault.remove(p),
        trash: (p) => host.vault.trash(p),
        rename: (f, t) => host.vault.rename(f, t),
        onChange: (cb) => host.vault.onChange(cb),
        basePath: () => host.vault.basePath(),
    };
}
