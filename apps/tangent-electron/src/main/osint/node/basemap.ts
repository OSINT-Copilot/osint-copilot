/**
 * Offline basemap archives (PMTiles) -- Node side.
 *
 * The threat this module exists to close: a byte-range read of a caller-supplied path is
 * an arbitrary-file-read primitive, and a better one than a whole-file read, because it
 * pages a large file out in chunks small enough to fit an enricher's HTTP body. The
 * renderer displays LLM and enricher output, so it is assumed hostile, CSP or not.
 *
 * The rule is the one exec-guard already applies to binaries: **main decides which file,
 * the renderer only names a handle.** `open()` takes no path. The path comes from a
 * native dialog main opened itself and is remembered in main's own userData -- which the
 * renderer cannot write, its filesystem access being confined to the vault by
 * node/vault.ts. Reads address an opaque handle bound to a descriptor main holds.
 *
 * No `electron` import: the picker is injected, the way secrets.ts takes safeStorage.
 * That keeps this file inside the strict typecheck and testable against a temp dir.
 */
import * as fsp from 'fs/promises';
import * as nodePath from 'path';
import { randomUUID } from 'crypto';
import type { BasemapOpenResult, BasemapRange } from '../../../osint/host/types';

/** PMTiles v3: the first seven bytes are "PMTiles", the eighth is the spec version. */
const MAGIC = Buffer.from('PMTiles', 'ascii');
const SPEC_VERSION = 3;
/** The PMTiles v3 fixed header. Anything shorter cannot be an archive. */
const MIN_ARCHIVE_BYTES = 127;
/** The largest read pmtiles issues is one tile body. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** The configured archive, plus one being swapped in. */
const MAX_HANDLES = 2;

/** Opens a native file dialog. Injected so this module never imports electron. */
export type ArchivePicker = () => Promise<string | null>;

interface OpenHandle {
    id: string;
    file: fsp.FileHandle;
    path: string;
    size: number;
    etag: string;
}

const handles = new Map<string, OpenHandle>();
let storePath = '';
let pickFile: ArchivePicker = async () => null;

/** Called from main once app.whenReady() has fired. */
export function configureBasemap(userDataDir: string, picker: ArchivePicker): void {
    storePath = nodePath.join(userDataDir, 'osint-basemap.json');
    pickFile = picker;
}

async function rememberedPath(): Promise<string> {
    if (!storePath) return '';
    try {
        const raw = JSON.parse(await fsp.readFile(storePath, 'utf-8'));
        return typeof raw?.path === 'string' ? raw.path : '';
    } catch {
        return '';
    }
}

async function remember(path: string): Promise<void> {
    if (!storePath) return;
    await fsp.mkdir(nodePath.dirname(storePath), { recursive: true });
    await fsp.writeFile(storePath, JSON.stringify({ path }, null, 2));
}

async function closeQuietly(file: fsp.FileHandle): Promise<void> {
    try { await file.close(); } catch { /* already gone */ }
}

async function evictOldest(): Promise<void> {
    while (handles.size >= MAX_HANDLES) {
        const oldest = handles.keys().next().value as string | undefined;
        if (!oldest) return;
        await close(oldest);
    }
}

async function openArchive(candidate: string): Promise<BasemapOpenResult> {
    // realpath first: a .pmtiles symlink must not be able to aim the descriptor at
    // something else, and the resolved path is what gets remembered.
    let real: string;
    try {
        real = await fsp.realpath(candidate);
    } catch {
        return { ok: false, problem: 'missing', path: candidate };
    }

    if (nodePath.extname(real).toLowerCase() !== '.pmtiles') {
        return { ok: false, problem: 'not-pmtiles', path: real };
    }

    let file: fsp.FileHandle;
    try {
        file = await fsp.open(real, 'r');
    } catch {
        return { ok: false, problem: 'unreadable', path: real };
    }

    try {
        // fstat the DESCRIPTOR, not the path: stat-then-open is a TOCTOU window, and
        // every later read goes through this fd, so what it points at cannot change
        // underneath the validation.
        const stats = await file.stat();
        // Rejects directories, FIFOs (a read would block main forever) and character
        // devices (/dev/urandom is an infinite tape).
        if (!stats.isFile()) {
            await closeQuietly(file);
            return { ok: false, problem: 'not-a-file', path: real };
        }
        if (stats.size < MIN_ARCHIVE_BYTES) {
            await closeQuietly(file);
            return { ok: false, problem: 'not-pmtiles', path: real };
        }

        const head = Buffer.alloc(8);
        await file.read(head, 0, 8, 0);
        // This is what turns "read any file" into "read any file that is already a
        // PMTiles archive". ~/.ssh/id_ed25519 does not start with "PMTiles".
        if (!head.subarray(0, 7).equals(MAGIC)) {
            await closeQuietly(file);
            return { ok: false, problem: 'not-pmtiles', path: real };
        }
        if (head[7] !== SPEC_VERSION) {
            await closeQuietly(file);
            return { ok: false, problem: 'unsupported-version', path: real };
        }

        await evictOldest();
        const handle: OpenHandle = {
            id: randomUUID(),
            file,
            path: real,
            size: stats.size,
            etag: `${stats.mtimeMs}-${stats.size}`,
        };
        handles.set(handle.id, handle);
        return {
            ok: true,
            archive: { handleId: handle.id, path: real, size: stats.size, etag: handle.etag },
        };
    } catch {
        await closeQuietly(file);
        return { ok: false, problem: 'unreadable', path: real };
    }
}

/** Native picker. Resolves null if the user cancelled. */
export async function pick(): Promise<BasemapOpenResult | null> {
    const chosen = await pickFile();
    if (!chosen) return null;
    const result = await openArchive(chosen);
    if (result.ok) await remember(result.archive.path);
    return result;
}

/** Opens the remembered archive. Takes no path, deliberately. */
export async function open(): Promise<BasemapOpenResult> {
    const path = await rememberedPath();
    if (!path) return { ok: false, problem: 'not-configured', path: '' };
    return openArchive(path);
}

export async function forget(): Promise<void> {
    for (const id of [...handles.keys()]) await close(id);
    if (storePath) {
        try { await fsp.rm(storePath, { force: true }); } catch { /* nothing to remove */ }
    }
}

export async function read(handleId: string, offset: number, length: number): Promise<BasemapRange> {
    const handle = handles.get(handleId);
    if (!handle) throw new Error('No such basemap handle. Reopen the archive.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Bad offset');
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_READ_BYTES) {
        throw new RangeError(`Bad length: expected 1..${MAX_READ_BYTES}`);
    }
    if (offset >= handle.size) throw new RangeError('Offset past end of archive');

    const wanted = Math.min(length, handle.size - offset);
    // allocUnsafeSlow, not allocUnsafe. A pooled Buffer is a view into a shared slab, so
    // structured-cloning `.buffer` would ship the whole slab and land in the renderer at
    // a non-zero byteOffset -- i.e. the wrong bytes. This gives a dedicated ArrayBuffer,
    // byteOffset 0, byteLength exactly `wanted`.
    const buffer = Buffer.allocUnsafeSlow(wanted);
    const { bytesRead } = await handle.file.read(buffer, 0, wanted, offset);
    const stats = await handle.file.stat();

    return {
        data: bytesRead === wanted ? buffer.buffer : buffer.buffer.slice(0, bytesRead),
        etag: `${stats.mtimeMs}-${stats.size}`,
    };
}

export async function close(handleId: string): Promise<void> {
    const handle = handles.get(handleId);
    if (!handle) return;
    handles.delete(handleId);
    await closeQuietly(handle.file);
}

export async function closeAll(): Promise<void> {
    for (const id of [...handles.keys()]) await close(id);
}

/** Test seam: lets a test point the store at a temp dir without a dialog. */
export async function __setRememberedPathForTests(path: string): Promise<void> {
    await remember(path);
}
