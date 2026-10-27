/**
 * Storage backend for the Vault.
 *
 * There is exactly ONE implementation of vault semantics (index tree, event
 * emission, Obsidian's error strings) -- it lives in vault.ts and sits on top of
 * this interface. Two backends satisfy it:
 *   host.vault    real filesystem, over IPC in the renderer
 *   MemoryStorage tests (testing/memory-storage.ts)
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
    /**
     * A URL the renderer can actually load this file from.
     *
     * Forwarded rather than built in vault.ts, because the right answer is a fact about
     * the HOST -- Tangent serves its window from file://, a different shell might not --
     * and because the encoding is subtle enough that a second copy would drift from it.
     * See host/impl.tangent.ts for why every path segment is encoded individually.
     */
    resourceUrl(path: string): string;
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
        resourceUrl: (p) => host.vault.resourceUrl(p),
    };
}
