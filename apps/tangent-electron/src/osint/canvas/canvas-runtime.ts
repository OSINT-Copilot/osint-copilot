/**
 * The bridge between a canvas and the running OSINT plugin.
 *
 * The canvas is a native Tangent lens, not an Obsidian ItemView, so it has no `this.app`.
 * It reaches the vault and the entity store the same way map-view reaches settings: off
 * the runtime the bootstrap publishes on globalThis. Everything is looked up lazily and
 * defensively, because a lens can be constructed while a session is being restored, before
 * the plugin has finished starting.
 */
import type { CanvasFileStore } from './canvas-document';
import { getEntityColor } from '../entities/types';

interface MinimalVaultAdapter {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<void>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
}

interface MinimalVault {
    adapter: MinimalVaultAdapter;
    getFiles(): { path: string; name: string; extension: string }[];
}

interface MinimalEntity {
    id: string;
    type: string;
    label: string;
    filePath?: string;
    properties: Record<string, unknown>;
}

interface OsintRuntime {
    vaultRoot?: string;
    app?: { vault?: MinimalVault };
    plugin?: {
        entityManager?: {
            getAllEntities(): MinimalEntity[];
            getEntity(id: string): MinimalEntity | undefined;
            openEntityNote(id: string): Promise<void> | void;
        };
    };
}

function runtime(): OsintRuntime | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- published bootstrap object
    return ((globalThis as any).osint as OsintRuntime | undefined) ?? null;
}

/**
 * Tangent addresses nodes by ABSOLUTE path; the obsidian-shim vault addresses files by
 * vault-relative path. A lens is handed the former and every vault call needs the latter,
 * so the conversion happens once, here, rather than at each call site.
 */
export function vaultRelativePath(path: string): string {
    const root = runtime()?.vaultRoot;
    if (!root) return path;
    if (path === root) return '';
    const prefix = root.endsWith('/') ? root : root + '/';
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Vault-relative, or an error.
 *
 * The lenient version above returns its input when the runtime is not up yet -- so an
 * absolute path stayed absolute, and writing it as if it were relative created a whole
 * shadow tree inside the vault (`<vault>/home/b/Documents/...`). Anything that touches
 * the filesystem uses this one, so a not-ready runtime fails loudly instead.
 */
export function requireVaultRelativePath(path: string): string {
    const root = runtime()?.vaultRoot;
    if (!root) throw new Error('The vault is not available yet.');
    const relative = vaultRelativePath(path);
    if (relative.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relative)) {
        throw new Error(`"${path}" is outside this vault.`);
    }
    return relative;
}

/**
 * The inverse. JSON Canvas stores vault-relative file paths -- that is what Obsidian
 * writes and what keeps a board portable -- while Tangent's directoryStore is keyed by
 * absolute path, so resolving a card's note needs the conversion back.
 */
export function absoluteVaultPath(relativePath: string): string {
    const root = runtime()?.vaultRoot;
    if (!root || relativePath.startsWith('/')) return relativePath;
    const prefix = root.endsWith('/') ? root : root + '/';
    return prefix + relativePath;
}

/**
 * Vault-backed file store for a canvas document.
 *
 * Paths arrive as Tangent gives them -- absolute -- and are resolved on every call rather
 * than once at construction, because a lens can be built before the runtime exists and a
 * path resolved then would be wrong forever.
 */
export function vaultFileStore(): CanvasFileStore {
    return {
        async read(absolutePath: string): Promise<string | null> {
            const path = requireVaultRelativePath(absolutePath);
            const adapter = runtime()?.app?.vault?.adapter;
            // Throwing, NOT returning null. null means "no such file", which the store
            // treats as a new empty board -- and a lens can be constructed while the
            // session is being restored, before the plugin has started. Conflating the two
            // would load an empty board over a real one and overwrite it on the next edit.
            if (!adapter) throw new Error('The vault is not available yet.');
            // Absence is normal: a canvas can be created and opened before its first save.
            if (!(await adapter.exists(path))) return null;
            return adapter.read(path);
        },
        async write(absolutePath: string, contents: string): Promise<void> {
            const path = requireVaultRelativePath(absolutePath);
            const adapter = runtime()?.app?.vault?.adapter;
            if (!adapter) throw new Error('The vault is not available yet.');
            const folder = path.slice(0, path.lastIndexOf('/'));
            // mkdir is idempotent in the shim; a board may live in a folder that does not
            // exist yet because nothing else has written there.
            if (folder) await adapter.mkdir(folder).catch(() => { /* already there */ });
            // adapter.write upserts (modify-or-create), so this covers both cases.
            await adapter.write(path, contents);
        },
    };
}

export interface EntityCardData {
    id: string;
    label: string;
    type: string;
    color: string;
    filePath?: string;
    /** A few properties worth showing on a card, in a stable order. */
    summary: { key: string; value: string }[];
}

/** Properties that say nothing useful on a card. */
const HIDDEN_PROPERTIES = new Set([
    'id', 'type', 'label', 'name', 'full_name', 'aliases',
    'osint_sources', 'osint_confidence', 'osint_contradictions',
    'add_to_timeline', 'thumbUrl',
]);

const MAX_SUMMARY_ROWS = 4;

function summarise(properties: Record<string, unknown>): { key: string; value: string }[] {
    const rows: { key: string; value: string }[] = [];
    for (const [key, value] of Object.entries(properties)) {
        if (rows.length >= MAX_SUMMARY_ROWS) break;
        if (HIDDEN_PROPERTIES.has(key)) continue;
        if (value === null || value === undefined || value === '') continue;
        if (typeof value === 'object') continue;
        rows.push({ key, value: String(value) });
    }
    return rows;
}

export function entityCardData(entityId: string): EntityCardData | null {
    const entity = runtime()?.plugin?.entityManager?.getEntity(entityId);
    if (!entity) return null;
    return {
        id: entity.id,
        label: entity.label,
        type: entity.type,
        color: getEntityColor(entity.type),
        filePath: entity.filePath,
        summary: summarise(entity.properties ?? {}),
    };
}

/**
 * Entities indexed by the note that backs them.
 *
 * EntityManager has no path->entity index, so resolving a `file` node to an entity would
 * otherwise be a linear scan of every entity per card per render. Built once per refresh
 * and handed to the view.
 */
export function entitiesByNotePath(): Map<string, string> {
    const index = new Map<string, string>();
    const entities = runtime()?.plugin?.entityManager?.getAllEntities() ?? [];
    for (const entity of entities) {
        if (entity.filePath) index.set(entity.filePath, entity.id);
    }
    return index;
}

export function allEntities(): MinimalEntity[] {
    // Read, never loaded: loadEntitiesFromNotes() clears the shared store AND rewrites the
    // whole graph-yaml mirror, which is not something opening a board should do.
    return runtime()?.plugin?.entityManager?.getAllEntities() ?? [];
}

export function openEntityNote(entityId: string): void {
    void runtime()?.plugin?.entityManager?.openEntityNote(entityId);
}

/**
 * Where downloaded thumbnails and imported files live.
 *
 * Beside the boards rather than in Evidence: these are board furniture, not case exhibits,
 * and mixing them into the evidence tree would make that folder untrustworthy as a record
 * of what the analyst actually collected.
 */
export const CANVAS_ASSETS_FOLDER = 'OSINTCopilot/boards/assets';

/**
 * A filename safe to join onto a vault path.
 *
 * Enforced HERE rather than trusted from the callers, because this is the sink: the two
 * generators upstream are careful, but a single future caller that is not would turn this
 * into an arbitrary-file-write, and in a vault that includes files the app executes.
 */
const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export function isSafeAssetName(name: string): boolean {
    // The character class already excludes separators and control characters; the explicit
    // dot-segment check makes the traversal case impossible to misread.
    return SAFE_ASSET_NAME.test(name) && !name.includes('..');
}

/** Writes bytes into the board's asset folder and returns the vault-relative path. */
export async function writeAsset(fileName: string, bytes: ArrayBuffer): Promise<string> {
    if (!isSafeAssetName(fileName)) {
        throw new Error(`Refusing to write an unsafe asset name: ${JSON.stringify(fileName)}`);
    }
    const adapter = runtime()?.app?.vault?.adapter;
    if (!adapter) throw new Error('The vault is not available yet.');
    await adapter.mkdir(CANVAS_ASSETS_FOLDER).catch(() => { /* already there */ });
    const path = `${CANVAS_ASSETS_FOLDER}/${fileName}`;
    await adapter.writeBinary(path, bytes);
    return path;
}

/**
 * A vault filename for an imported OS file.
 *
 * The dropped name is attacker-influenced only in the weak sense that the analyst chose
 * the file, but it still reaches the filesystem, so directory separators, traversal
 * segments, control characters and absurd lengths are removed rather than trusted. The
 * content hash suffix means two different files with the same name do not collide -- the
 * graph view's importer reuses any existing file of that name, which silently substitutes
 * the wrong image.
 */
export function importedFileName(originalName: string, bytes: ArrayBuffer): string {
    // Reduced to the safe charset rather than merely having separators replaced: the
    // output has to satisfy isSafeAssetName, or writeAsset refuses it and the drop fails
    // silently. Building a valid name is better than filtering an invalid one.
    const cleaned = originalName.normalize('NFC').replace(/[^A-Za-z0-9._-]/g, '_');
    const dot = cleaned.lastIndexOf('.');
    const rawStem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
    const extension = (dot > 0 ? cleaned.slice(dot + 1) : '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);

    // No dots in the stem, so "..", leading dots and double extensions are all impossible;
    // and it must start alphanumeric, which isSafeAssetName requires.
    const stem = rawStem.replace(/\./g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'file';

    let hash = 2166136261;
    const view = new Uint8Array(bytes);
    // A bounded sample: hashing a 200MB video just to name it is not worth the stall.
    const step = Math.max(1, Math.floor(view.length / 4096));
    for (let i = 0; i < view.length; i += step) {
        hash ^= view[i];
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    // The length too is included, so two files sampled identically still differ.
    hash = Math.imul(hash ^ view.length, 16777619) >>> 0;

    const suffix = hash.toString(16).padStart(8, '0');
    return extension ? `${stem}-${suffix}.${extension}` : `${stem}-${suffix}`;
}

/** Every file in the vault, for the card picker. */
export function vaultFiles(): { path: string; name: string; extension: string }[] {
    return runtime()?.app?.vault?.getFiles() ?? [];
}
