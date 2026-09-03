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
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
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
    app?: { vault?: { adapter?: MinimalVaultAdapter } };
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

/** Vault-backed file store for a canvas document. */
export function vaultFileStore(): CanvasFileStore {
    return {
        async read(path: string): Promise<string | null> {
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
        async write(path: string, contents: string): Promise<void> {
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
