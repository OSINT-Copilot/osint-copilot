/**
 * Entity Manager - handles entity storage as Obsidian notes.
 * Now supports both legacy EntityType and FTM schema format.
 */

import { App, TAbstractFile, TFile, TFolder, normalizePath, Notice } from 'obsidian';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { VaultLockService } from './vault-lock-service';
import type { WaybackArchiveService } from './wayback-archive-service';
import {
    type Entity, EntityType, type Connection, ENTITY_CONFIGS,
    getEntityLabel, generateId, isGeneratedId, sanitizeFilename, COMMON_PROPERTIES,
    getFTMEntityConfig, isFTMSchema, legacyToFTMSchema,
    type OsintContradiction, type OsintSource, type OsintSourceInput,
} from '../entities/types';
import {
    computeOsintConfidence,
    deterministicOsintSourceId,
    finalizeOsintSources,
    isOsintConfidence,
} from './osint-confidence-engine';
import { identifierKeysForEntity, normalizeIdentifierKey } from './entity-identifiers';
import { geocodingService, GeocodingError, GeocodingErrorType, isGeocodingConfigured } from './geocoding-service';
import { ftmSchemaService } from './ftm-schema-service';
import type { SchemaCatalogService } from './schema-catalog-service';
import type { CatalogEntityType, SchemaFamily } from './schema-catalog-types';
import { GRAPH_YAML_FOLDER_NAME, OSINT_COPILOT_VAULT_ROOT } from '../constants/vault-layout';

const SCHEMA_FAMILY_FOLDERS: SchemaFamily[] = ['ftm', 'stix2', 'mitre', 'user'];
const RESERVED_FRONTMATTER_KEYS = new Set([
    'id',
    'type',
    'label',
    'schemaFamily',
    'ftmSchema',
    'aliases',
    'filePath',
    'color',
    'created',
    'props',
    'osint_sources',
    'osint_confidence',
    'osint_contradictions',
]);

/**
 * Quote a string as a YAML double-quoted scalar. Labels and property values reach
 * front matter from untrusted page text, and the hand-built `key: "value"` lines used
 * to escape only `"`: a newline wrote extra keys, a trailing backslash ate the closing
 * quote, and `\n---\n` ended the front matter early. A JSON string is a valid YAML
 * double-quoted scalar, so JSON.stringify covers quotes, backslashes and C0 controls;
 * DEL, C1 controls and U+2028/U+2029 are escaped on top because JSON leaves them raw
 * and some YAML/Markdown readers treat them as line breaks or reject them.
 * Every front-matter string written by hand in this file goes through here.
 */
function yamlQuote(value: string): string {
    return JSON.stringify(value).replace(
        /[\u007f-\u009f\u2028\u2029]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

// Identifier-like strings stay plain so existing notes keep byte-identical `type: Person`
// / `city:` lines; anything else (spaces aside) is quoted. The reserved words would parse
// back as booleans/null if left plain.
const YAML_PLAIN_SAFE = /^[A-Za-z_][\w.-]*( [\w.-]+)*$/;
const YAML_PLAIN_RESERVED = /^(true|false|null|yes|no|on|off|y|n)$/i;

/** A key or identifier value: plain when that is unambiguous, otherwise yamlQuote(). */
function yamlPlainOrQuote(value: string): string {
    return YAML_PLAIN_SAFE.test(value) && !YAML_PLAIN_RESERVED.test(value) ? value : yamlQuote(value);
}

/**
 * A single-line rendering for Markdown headings built from labels: a CR/LF or Unicode
 * line separator in a label would otherwise start new body lines under the heading.
 * Controls become spaces rather than vanishing so the words either side stay apart.
 */
function stripControls(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
}

/**
 * `key: value` for a hand-built scalar front-matter line, whatever the key or value holds.
 * Exported for other notes built from page text (the extension's Sources notes).
 */
export function yamlScalarLine(key: string, value: unknown): string {
    const k = yamlPlainOrQuote(key);
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        return `${k}: ${String(value)}`;
    }
    return `${k}: ${yamlQuote(String(value))}`;
}

/**
 * A quoted scalar as the line-by-line fallback reader sees it. Double-quoted scalars are
 * written by yamlQuote(), i.e. as JSON strings, so JSON decodes the escapes; one that is
 * not valid JSON (hand-written YAML escapes such as \x41) is returned without its quotes
 * rather than dropped. Single-quoted YAML only escapes the quote itself, by doubling it.
 */
function decodeYamlScalar(quoted: string): string {
    if (quoted.startsWith('"')) {
        try {
            const decoded: unknown = JSON.parse(quoted);
            if (typeof decoded === 'string') return decoded;
        } catch {
            /* fall through to the raw text */
        }
        return quoted.slice(1, -1);
    }
    return quoted.slice(1, -1).replace(/''/g, "'");
}

/**
 * Property keys never written to or read from front matter: assigning `__proto__` on the
 * plain object a note is read into would replace that object's prototype.
 */
const UNSAFE_PROPERTY_KEYS = new Set(['__proto__']);

/**
 * Keys buildConnectionFrontmatter writes itself. A connection property with one of these
 * names goes under `props:` instead, as entity properties do with RESERVED_FRONTMATTER_KEYS:
 * written beside them it would repeat the key, the YAML parser would reject the note, and
 * the fallback reader would let the property's value win -- a property named `id` would
 * re-point the connection.
 */
const CONNECTION_FRONTMATTER_KEYS = new Set([
    'id',
    'type',
    'relationship',
    'fromEntityId',
    'toEntityId',
    'fromEntity',
    'toEntity',
    'schemaFamily',
    'ftmSchema',
    'label',
    'props',
    'osint_sources',
    'osint_confidence',
    'osint_contradictions',
]);

/** generateNoteContent (undo/restore) also writes these two itself. */
const HISTORY_NOTE_FRONTMATTER_KEYS = new Set([...RESERVED_FRONTMATTER_KEYS, 'created', 'modified']);

/** The in-memory store: entities and connections by id. */
interface GraphMaps {
    entities: Map<string, Entity>;
    connections: Map<string, Connection>;
}

function isSchemaFamilyFolderName(name: string): name is SchemaFamily {
    return SCHEMA_FAMILY_FOLDERS.includes(name as SchemaFamily);
}

export class EntityManager {
    private app: App;
    private basePath: string;
    private entities: Map<string, Entity> = new Map();
    private connections: Map<string, Connection> = new Map();
    /**
     * Normalised identifier key (see entity-identifiers.ts) -> ids of the entities carrying
     * it, oldest first, plus the reverse map so an entity's stale keys can be dropped when
     * its properties change. Kept in step with `entities` by indexEntity/unindexEntity.
     */
    private identifierIndex: Map<string, string[]> = new Map();
    private identifierKeysById: Map<string, string[]> = new Map();
    /**
     * One entry per loadEntitiesFromNotes() still reading: the ids of the entities and
     * connections written through this class (put, changed in place or removed) since it
     * began. See loadEntitiesFromNotes.
     */
    private loadWriteLogs = new Set<{ entities: Set<string>; connections: Set<string> }>();
    /** Order of the loads begun, and of the latest one whose result is in memory. */
    private loadsStarted = 0;
    private loadInMemory = 0;
    /** The graph-yaml syncs run one after another, so an older one cannot land last. */
    private graphYamlSync: Promise<void> = Promise.resolve();
    /**
     * Each graph-yaml file this class wrote, by path, with the document it wrote there (as
     * JSON). A routine reload compares with this rather than with the entities it replaces:
     * those are changed in place by updateEntity, and a new note's entry is written before
     * its note path is known, so only the files themselves show what is stale.
     */
    private graphYamlWritten = new Map<string, string>();
    private vaultLockService: VaultLockService | null = null;
    private schemaCatalog: SchemaCatalogService | null = null;
    private waybackArchiveService: WaybackArchiveService | null = null;
    private getReservedTopLevelFolderNames: () => string[];

    private appendYamlLine(lines: string[], key: string, value: unknown): void {
        if (value === undefined || value === null || value === '') return;
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
            lines.push(yamlScalarLine(key, value));
            return;
        }
        const chunk = stringifyYaml({ [key]: value }).trim();
        if (!chunk) return;
        lines.push(...chunk.split('\n'));
    }

    /**
     * One property line, or into `props:` when its key is one the writer emits itself: a
     * property named `id` or `label` must not be able to stand in for the real one. Keys
     * that are not plain YAML are JSON-quoted by yamlScalarLine/stringifyYaml.
     */
    private appendEntityPropertyToFrontmatter(
        lines: string[],
        propsChunk: Record<string, unknown>,
        key: string,
        value: unknown,
        writerKeys: ReadonlySet<string> = RESERVED_FRONTMATTER_KEYS,
    ): void {
        if (value === undefined || value === null || value === '') return;
        if (UNSAFE_PROPERTY_KEYS.has(key)) return;
        if (writerKeys.has(key)) {
            propsChunk[key] = value;
            return;
        }
        this.appendYamlLine(lines, key, value);
    }

    private appendPropsChunk(lines: string[], propsChunk: Record<string, unknown>): void {
        if (Object.keys(propsChunk).length === 0) return;
        const chunk = stringifyYaml({ props: propsChunk }).trim();
        if (!chunk) return;
        lines.push(...chunk.split('\n'));
    }

    constructor(
        app: App,
        basePath: string = OSINT_COPILOT_VAULT_ROOT,
        vaultLockService?: VaultLockService | null,
        getReservedTopLevelFolderNames?: () => string[],
    ) {
        this.app = app;
        this.basePath = basePath;
        this.vaultLockService = vaultLockService ?? null;
        // Default covers the two non-entity folders every vault ships with (conversations,
        // custom); callers whose settings let these move (e.g. a renamed conversation folder)
        // should pass a getter that reflects the actual configured paths.
        this.getReservedTopLevelFolderNames = getReservedTopLevelFolderNames ?? (() => ['conversations', 'custom']);
    }

    /** Wired from plugin after SchemaCatalogService is constructed. */
    setSchemaCatalogService(catalog: SchemaCatalogService | null): void {
        this.schemaCatalog = catalog;
    }

    setWaybackArchiveService(service: WaybackArchiveService | null): void {
        this.waybackArchiveService = service;
    }

    /**
     * Computes an entity's label consistently for both createEntity() and updateEntity(), so the
     * derived filename (see saveFTMEntityAsNote) doesn't shift on the first edit. When an FTM
     * schema is set, ftmSchemaService.getEntityLabel() is tried first; its own last-resort
     * fallback is to return the bare schema name when none of its label-field/fallback candidates
     * match a property that's actually present (e.g. legacy Phone's "number" or Text's "text"
     * aren't in its generic fallback list) -- treat that literal "no real label found" signal as a
     * reason to fall back to the legacy, type-specific labelField instead, rather than showing the
     * user a label like "LegalEntity" or "Document".
     */
    private computeEntityLabel(type: EntityType | string, ftmSchema: string | undefined, properties: Record<string, unknown>): string {
        if (ftmSchema) {
            const ftmLabel = ftmSchemaService.getEntityLabel(ftmSchema, properties);
            if (ftmLabel && ftmLabel !== ftmSchema) return ftmLabel;
        }
        return getEntityLabel(type, properties);
    }

    private scheduleWaybackForNote(filePath: string): void {
        try {
            this.waybackArchiveService?.enqueueFromPath(filePath);
        } catch (e) {
            console.warn('[EntityManager] Wayback enqueue failed:', e);
        }
    }

    /** Block vault writes when the path is locked (graph / settings). */
    private assertPathWritable(path: string | undefined, action: string): boolean {
        if (!path) return true;
        if (this.vaultLockService?.isPathLocked(path)) {
            new Notice(`Cannot ${action}: note is locked. Unlock from the editor toolbar or plugin settings.`);
            return false;
        }
        return true;
    }

    /**
     * Set the base path for entity storage.
     */
    setBasePath(path: string): void {
        this.basePath = path;
    }

    getBasePath(): string {
        return this.basePath;
    }

    /**
     * Whether a change at this vault path can change what loadEntitiesFromNotes() reads:
     * a .md note in a folder under the base path that the loader does not skip (the
     * reserved folders, schemas, graph-yaml). For views that reload on note changes. A
     * plain base-path prefix is not enough: conversations live under the same root, so it
     * rebuilt the graph on every chat save.
     */
    isGraphNotePath(path: string): boolean {
        const normalized = normalizePath(path.replace(/\\/g, '/'));
        if (!normalized.endsWith('.md')) return false;
        const prefix = `${normalizePath(this.basePath)}/`;
        if (!normalized.startsWith(prefix)) return false;
        const segments = normalized.slice(prefix.length).split('/');
        // A note directly in the base folder is in no type folder, and never loaded.
        if (segments.length < 2) return false;
        const top = segments[0];
        if (top === 'schemas' || top === GRAPH_YAML_FOLDER_NAME) return false;
        return !this.getReservedTopLevelFolderNames().includes(top);
    }

    /**
     * Initialize the entity manager and load existing entities.
     */
    async initialize(): Promise<void> {
        // Ensure base folder exists
        await this.ensureFolderExists(this.basePath);

        // Create type folders
        for (const type of Object.values(EntityType)) {
            await this.ensureFolderExists(`${this.basePath}/${type}`);
        }

        // Ensure Connections folder exists
        await this.ensureFolderExists(`${this.basePath}/Connections`);

        // Load existing entities from notes
        await this.loadEntitiesFromNotes();
    }

    /**
     * Ensure a folder exists, creating it if necessary.
     * Handles the case where the folder already exists gracefully.
     */
    private async ensureFolderExists(path: string): Promise<void> {
        const normalizedPath = normalizePath(path);
        const folder = this.app.vault.getAbstractFileByPath(normalizedPath);

        if (!folder) {
            try {
                await this.app.vault.createFolder(normalizedPath);
            } catch (error) {
                // Ignore "Folder already exists" errors - this can happen due to race conditions
                // or if the folder was created between our check and create call
                if (error instanceof Error && !error.message.includes('Folder already exists')) {
                    console.error(`Failed to create folder ${normalizedPath}:`, error);
                    throw error;
                }
            }
        }
    }

    /**
     * Load all entities from existing notes.
     *
     * The notes are read into new maps that replace the old ones at the end. The store
     * used to be cleared first and refilled as the notes were read, and the views now
     * reload it on every note change: an action taken meanwhile found its entity missing
     * (the graph's timeline toggle reported a change it never made; a delete failed).
     *
     * An entity or connection written through this class while the notes are read keeps
     * that write, since the read may have seen its note before it. When loads overlap,
     * the one begun last decides what is in memory.
     *
     * @param options.graphYaml how the graph-yaml mirror follows: 'full' rewrites every
     *   entry (the default: plugin load and the reload commands); 'changed', for the
     *   views' routine reloads, writes only the entries this load changed.
     */
    async loadEntitiesFromNotes(options: { graphYaml?: 'full' | 'changed' } = {}): Promise<void> {
        const load = ++this.loadsStarted;
        const writes = { entities: new Set<string>(), connections: new Set<string>() };
        const entities = new Map<string, Entity>();
        const connections = new Map<string, Connection>();
        this.loadWriteLogs.add(writes);
        try {
            const baseFolder = this.app.vault.getAbstractFileByPath(this.basePath);
            if (baseFolder instanceof TFolder) {
                // Not entity-type folders -- conversations and custom (prompts/skills/task-agents/
                // enrichers/credentials/scripts) both live directly under the vault root too by
                // default, and the "legacy flat type folder" fallback below would otherwise try to
                // parse every .md file in them as an entity note (rejected for lacking type/id, but
                // not before logging a YAML-parse warning for anything whose frontmatter isn't
                // strict YAML). The getter reflects each folder's *actual* configured path, so a
                // renamed conversation/prompts/etc. folder is still correctly excluded.
                const reserved = new Set(this.getReservedTopLevelFolderNames());
                for (const child of baseFolder.children) {
                    if (!(child instanceof TFolder)) continue;
                    if (child.name === 'Connections') continue;
                    if (child.name === 'schemas') continue;
                    if (child.name === GRAPH_YAML_FOLDER_NAME) continue;
                    if (reserved.has(child.name)) continue;

                    if (isSchemaFamilyFolderName(child.name)) {
                        await this.loadFamilyEntityTree(child, child.name, entities);
                    } else {
                        await this.loadLegacyFlatTypeFolder(child, entities);
                    }
                }
            }

            // Connections come from Connections/ notes and nowhere else.
            //
            // Entity notes still RENDER their relationships as wikilinks, and those stay
            // clickable via the app's link index -- but they are no longer parsed back
            // into Connection objects. That round-trip minted a fresh random id on every
            // load for any hand-written [[A]] REL [[B]] line, producing a connection with
            // unstable identity and no note behind it: invisible to the graph-yaml mirror,
            // and impossible for undo/redo or selection to track across a reload.
            await this.loadConnectionsFromNotes(connections);
        } finally {
            this.loadWriteLogs.delete(writes);
        }

        // A load begun after this one has already put newer notes in memory.
        if (load < this.loadInMemory) return;
        this.loadInMemory = load;

        for (const id of writes.entities) {
            const live = this.entities.get(id);
            if (live) entities.set(id, live);
            else entities.delete(id);
        }
        for (const id of writes.connections) {
            const live = this.connections.get(id);
            if (live) connections.set(id, live);
            else connections.delete(id);
        }

        this.entities = entities;
        this.connections = connections;
        this.identifierIndex.clear();
        this.identifierKeysById.clear();
        for (const entity of entities.values()) {
            this.indexEntity(entity);
        }

        const current = { entities, connections };
        const sync = this.graphYamlSync.then(() => options.graphYaml === 'changed'
            ? this.syncChangedGraphYaml(current)
            : this.syncAllGraphYamlFromMemory());
        this.graphYamlSync = sync;
        await sync;
    }

    /** e.g. OSINTCopilot/ftm/Person/*.md */
    private async loadFamilyEntityTree(folder: TFolder, family: SchemaFamily, into: Map<string, Entity>): Promise<void> {
        for (const typeFolder of folder.children) {
            if (!(typeFolder instanceof TFolder)) continue;
            for (const file of typeFolder.children) {
                if (file instanceof TFile && file.extension === 'md') {
                    const entity = await this.parseEntityFromNote(file, family);
                    if (entity) {
                        into.set(entity.id, entity);
                    }
                }
            }
        }
    }

    /** Legacy: OSINTCopilot/Person/*.md (no family segment). */
    private async loadLegacyFlatTypeFolder(folder: TFolder, into: Map<string, Entity>): Promise<void> {
        for (const file of folder.children) {
            if (file instanceof TFile && file.extension === 'md') {
                const entity = await this.parseEntityFromNote(file, 'ftm');
                if (entity) {
                    into.set(entity.id, entity);
                }
            }
        }
    }

    /**
     * Parse an entity from a note file.
     */
    private async parseEntityFromNote(file: TFile, defaultFamily: SchemaFamily): Promise<Entity | null> {
        try {
            const content = await this.app.vault.read(file);
            const frontmatter = this.parseFrontmatter(content);

            if (!frontmatter || !frontmatter.type || !frontmatter.id) {
                return null;
            }

            const type = frontmatter.type as string;
            if (!type) {
                return null;
            }

            const fmFamily = frontmatter.schemaFamily as SchemaFamily | undefined;
            const schemaFamily: SchemaFamily | undefined = fmFamily ?? defaultFamily;

            const properties: Record<string, unknown> = {};
            const internalKeys = [...RESERVED_FRONTMATTER_KEYS];
            for (const [key, value] of Object.entries(frontmatter)) {
                if (UNSAFE_PROPERTY_KEYS.has(key)) continue;
                if (!internalKeys.includes(key) && value !== undefined && value !== null) {
                    properties[key] = value;
                }
            }
            const propsBlock = frontmatter.props;
            if (propsBlock && typeof propsBlock === 'object' && !Array.isArray(propsBlock)) {
                for (const [key, value] of Object.entries(propsBlock as Record<string, unknown>)) {
                    if (UNSAFE_PROPERTY_KEYS.has(key)) continue;
                    if (value !== undefined && value !== null) {
                        properties[key] = value;
                    }
                }
            }

            // Fallback: parse properties from the markdown body (## Properties section)
            // for notes that only have properties in the body, not in frontmatter
            const bodyProps = this.parsePropertiesFromBody(content);
            for (const [key, value] of Object.entries(bodyProps)) {
                if (!(key in properties) && value !== undefined && value !== null && value !== '') {
                    if (value === 'true') properties[key] = true;
                    else if (value === 'false') properties[key] = false;
                    else if (!isNaN(Number(value)) && value !== '') properties[key] = Number(value);
                    else properties[key] = value;
                }
            }

            const ftmSchema = frontmatter.ftmSchema as string | undefined;

            let label = (frontmatter.label as string) || '';
            if (!label) {
                if (this.schemaCatalog) {
                    label = this.schemaCatalog.getInstanceLabel({
                        schemaFamily,
                        type,
                        ftmSchema,
                        label: '',
                        properties,
                    });
                } else {
                    label = ftmSchema
                        ? ftmSchemaService.getEntityLabel(ftmSchema, properties)
                        : getEntityLabel(type, properties);
                }
            }

            const osint_sources = Array.isArray(frontmatter.osint_sources)
                ? (frontmatter.osint_sources as OsintSource[])
                : undefined;
            const osint_confidence = isOsintConfidence(frontmatter.osint_confidence)
                ? frontmatter.osint_confidence
                : undefined;
            const osint_contradictions = Array.isArray(frontmatter.osint_contradictions)
                ? (frontmatter.osint_contradictions as OsintContradiction[])
                : undefined;

            const entity: Entity = {
                id: frontmatter.id as string,
                type,
                label,
                properties,
                filePath: file.path,
                ftmSchema,
                schemaFamily,
                ...(osint_sources?.length ? { osint_sources } : {}),
                ...(osint_confidence ? { osint_confidence } : {}),
                ...(osint_contradictions?.length ? { osint_contradictions } : {}),
            };
            return entity;
        } catch (error) {
            console.error(`Error parsing entity from ${file.path}:`, error);
            return null;
        }
    }

    /**
     * Parse key-value properties from the markdown body's ## Properties section.
     * Handles lines like: - **key**: value  or  - **key:** value
     */
    private parsePropertiesFromBody(content: string): Record<string, string> {
        const result: Record<string, string> = {};
        const propsMatch = content.match(/## Properties\s*\n([\s\S]*?)(?:\n##|\n$)/);
        if (!propsMatch) return result;

        const lines = propsMatch[1].split('\n');
        for (const line of lines) {
            const m = line.match(/^\s*-\s*\*\*([^*:]+)\*\*:?\s*(.*)$/);
            if (m) {
                const key = m[1].replace(/:$/, '').trim();
                const value = m[2].trim();
                if (key && value) {
                    result[key] = value;
                }
            }
        }
        return result;
    }

    /**
     * Parse YAML frontmatter from note content (nested arrays/objects supported).
     */
    private parseFrontmatter(content: string): Record<string, unknown> | null {
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return null;

        const yamlText = match[1];
        try {
            const doc = parseYaml(yamlText);
            if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
                return doc as Record<string, unknown>;
            }
        } catch (e) {
            console.warn('[EntityManager] YAML parse failed, using line fallback:', e);
        }

        // Top-level lines are read, and the first occurrence of a key wins; indented lines
        // are read only as entries of the `props:` block, into `props`. An indented
        // `  id: evil` under `props:`, or a property an older writer put beside the real
        // key, would otherwise replace the note's own id or type.
        const result: Record<string, unknown> = {};
        const lines = yamlText.split('\n');
        let block: 'props' | null = null;
        for (const line of lines) {
            const indented = /^\s/.test(line);
            if (indented && block !== 'props') continue;
            const entry = this.parseFallbackLine(line.trim());
            if (!entry) {
                if (!indented) block = null;
                continue;
            }
            const [key, value] = entry;
            if (indented) {
                const props = result.props as Record<string, unknown>;
                if (!Object.prototype.hasOwnProperty.call(props, key)) props[key] = value;
                continue;
            }
            const opensProps = key === 'props' && value === '';
            if (!Object.prototype.hasOwnProperty.call(result, key)) {
                // `props:` with nothing after it opens the block; anything else is a plain key.
                result[key] = opensProps ? {} : value;
            }
            const props = result.props;
            block = opensProps && props !== null && typeof props === 'object' ? 'props' : null;
        }

        return result;
    }

    /**
     * One `key: value` line for the fallback reader, as [key, value]; null for anything else
     * and for keys never read (UNSAFE_PROPERTY_KEYS).
     */
    private parseFallbackLine(line: string): [string, unknown] | null {
        // A key the writer JSON-quoted (see yamlPlainOrQuote) can itself hold a colon.
        const quotedKey = line.match(/^("(?:[^"\\]|\\.)*")\s*:/);
        const colonIndex = quotedKey ? quotedKey[0].length - 1 : line.indexOf(':');
        if (colonIndex <= 0) return null;
        const key = quotedKey
            ? decodeYamlScalar(quotedKey[1])
            : line.substring(0, colonIndex).trim();
        const raw = line.substring(colonIndex + 1).trim();
        if (!key || UNSAFE_PROPERTY_KEYS.has(key)) return null;

        // A quoted value is a string whatever it looks like: "true" or "42" came
        // from a string property, and the writer quoted it to keep it one.
        if (/^(".*"|'.*')$/.test(raw) && raw.length >= 2) return [key, decodeYamlScalar(raw)];
        if (raw === 'true') return [key, true];
        if (raw === 'false') return [key, false];
        if (!isNaN(Number(raw)) && raw !== '') return [key, Number(raw)];
        return [key, raw];
    }

    /** Append osint_* keys as YAML (supports nested arrays). */
    private appendOsintFrontmatter(lines: string[], target: Entity | Connection): void {
        const chunk: Record<string, unknown> = {};
        if (target.osint_confidence) chunk.osint_confidence = target.osint_confidence;
        if (target.osint_sources?.length) chunk.osint_sources = target.osint_sources;
        if (target.osint_contradictions?.length) chunk.osint_contradictions = target.osint_contradictions;
        if (Object.keys(chunk).length === 0) return;
        lines.push(stringifyYaml(chunk).trim());
    }

    private mergeOsintOntoEntity(
        entity: Entity,
        options?: {
            osint_sources?: OsintSource[] | OsintSourceInput[];
            osint_captured_at?: string;
            conversation_id?: string;
        },
    ): void {
        if (!options?.osint_sources?.length) return;
        const sources = finalizeOsintSources(options.osint_sources as OsintSourceInput[], {
            captured_at: options.osint_captured_at ?? new Date().toISOString(),
            conversation_id: options.conversation_id,
        });
        entity.osint_sources = sources;
        const o = computeOsintConfidence(entity, sources);
        entity.osint_confidence = o.osint_confidence;
        entity.osint_contradictions = o.osint_contradictions;
    }

    private mergeOsintOntoConnection(
        connection: Connection,
        options?: {
            osint_sources?: OsintSource[] | OsintSourceInput[];
            osint_captured_at?: string;
            conversation_id?: string;
        },
    ): void {
        if (!options?.osint_sources?.length) return;
        const sources = finalizeOsintSources(options.osint_sources as OsintSourceInput[], {
            captured_at: options.osint_captured_at ?? new Date().toISOString(),
            conversation_id: options.conversation_id,
        });
        connection.osint_sources = sources;
        const o = computeOsintConfidence(connection, sources);
        connection.osint_confidence = o.osint_confidence;
        connection.osint_contradictions = o.osint_contradictions;
    }

    /**
     * Load connections from the Connections folder.
     */
    private async loadConnectionsFromNotes(into: Map<string, Connection>): Promise<void> {
        const folderPath = normalizePath(`${this.basePath}/Connections`);
        const folder = this.app.vault.getAbstractFileByPath(folderPath);

        if (folder instanceof TFolder) {
            for (const file of folder.children) {
                if (file instanceof TFile && file.extension === 'md') {
                    const connection = await this.parseConnectionFromNote(file);
                    if (connection) {
                        into.set(connection.id, connection);
                    }
                }
            }
        }
    }

    /**
     * Parse a connection from a note file.
     */
    private async parseConnectionFromNote(file: TFile): Promise<Connection | null> {
        try {
            const content = await this.app.vault.read(file);
            const frontmatter = this.parseFrontmatter(content);

            if (!frontmatter || frontmatter.type !== 'connection' || !frontmatter.id) {
                return null;
            }

            // Extract connection properties from frontmatter
            const properties: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(frontmatter)) {
                if (UNSAFE_PROPERTY_KEYS.has(key)) continue;
                if (!CONNECTION_FRONTMATTER_KEYS.has(key) && value !== undefined && value !== null) {
                    properties[key] = value;
                }
            }
            // Properties whose names the writer uses itself (see CONNECTION_FRONTMATTER_KEYS).
            const propsBlock = frontmatter.props;
            if (propsBlock && typeof propsBlock === 'object' && !Array.isArray(propsBlock)) {
                for (const [key, value] of Object.entries(propsBlock as Record<string, unknown>)) {
                    if (UNSAFE_PROPERTY_KEYS.has(key)) continue;
                    if (value !== undefined && value !== null) properties[key] = value;
                }
            }

            const ftmSchema = frontmatter.ftmSchema as string | undefined;
            const schemaFamily = (frontmatter.schemaFamily as SchemaFamily | undefined)
                ?? (ftmSchema ? 'ftm' : 'ftm');

            const osint_sources = Array.isArray(frontmatter.osint_sources)
                ? (frontmatter.osint_sources as OsintSource[])
                : undefined;
            const osint_confidence = isOsintConfidence(frontmatter.osint_confidence)
                ? frontmatter.osint_confidence
                : undefined;
            const osint_contradictions = Array.isArray(frontmatter.osint_contradictions)
                ? (frontmatter.osint_contradictions as OsintContradiction[])
                : undefined;

            return {
                id: frontmatter.id as string,
                fromEntityId: frontmatter.fromEntityId as string,
                toEntityId: frontmatter.toEntityId as string,
                relationship: frontmatter.relationship as string,
                label: frontmatter.label as string,
                properties: Object.keys(properties).length > 0 ? properties : undefined,
                ftmSchema,
                schemaFamily,
                filePath: file.path,
                ...(osint_sources?.length ? { osint_sources } : {}),
                ...(osint_confidence ? { osint_confidence } : {}),
                ...(osint_contradictions?.length ? { osint_contradictions } : {}),
            };
        } catch (error) {
            console.error(`Error parsing connection from ${file.path}:`, error);
            return null;
        }
    }

    /**
     * Parse connections from relationship sections in notes.
     */
    /**
     * Find an entity by its label.
     */
    findEntityByLabel(label: string): Entity | undefined {
        if (!label || typeof label !== 'string') return undefined;
        const searchLabel = label.toLowerCase();
        for (const entity of this.entities.values()) {
            // Ensure entity.label is a string before calling toLowerCase
            const entityLabel = entity.label != null ? String(entity.label) : '';
            if (entityLabel.toLowerCase() === searchLabel) {
                return entity;
            }
        }
        return undefined;
    }

    /** Store an entity in memory and (re)index its identifiers. */
    private putEntity(entity: Entity): void {
        this.entities.set(entity.id, entity);
        this.indexEntity(entity);
        this.recordWrite('entities', entity.id);
    }

    /** Forget an entity in memory, identifiers included. Its note is untouched. */
    private dropEntity(entityId: string): void {
        this.entities.delete(entityId);
        this.unindexEntity(entityId);
        this.recordWrite('entities', entityId);
    }

    /**
     * After a write that changed an entity in place: that object, as its note now is, is
     * the one in memory, even when a reload that finished during the write swapped in a
     * copy read before it.
     */
    private settleEntityWrite(entity: Entity): void {
        this.putEntity(entity);
    }

    private putConnection(connection: Connection): void {
        this.connections.set(connection.id, connection);
        this.recordWrite('connections', connection.id);
    }

    private dropConnection(connectionId: string): boolean {
        const dropped = this.connections.delete(connectionId);
        this.recordWrite('connections', connectionId);
        return dropped;
    }

    /** Tell every loadEntitiesFromNotes() still reading that this id was written. */
    private recordWrite(kind: 'entities' | 'connections', id: string): void {
        for (const log of this.loadWriteLogs) log[kind].add(id);
    }

    private indexEntity(entity: Entity): void {
        this.unindexEntity(entity.id);
        const keys = identifierKeysForEntity(entity);
        if (keys.length === 0) return;
        this.identifierKeysById.set(entity.id, keys);
        for (const key of keys) {
            const ids = this.identifierIndex.get(key);
            if (ids) ids.push(entity.id);
            else this.identifierIndex.set(key, [entity.id]);
        }
    }

    private unindexEntity(entityId: string): void {
        const keys = this.identifierKeysById.get(entityId);
        if (!keys) return;
        this.identifierKeysById.delete(entityId);
        for (const key of keys) {
            const ids = this.identifierIndex.get(key)?.filter((id) => id !== entityId);
            if (ids?.length) this.identifierIndex.set(key, ids);
            else this.identifierIndex.delete(key);
        }
    }

    /**
     * The entity already known by a normalised identifier, e.g. `email:alice@example.com`
     * (the key is normalised here too, so case and formatting do not matter). When several
     * entities share the key, one stored under `schema` wins, then the oldest. Legacy notes
     * count: an old Email-type LegalEntity note answers `email:` lookups.
     */
    findEntityByIdentifier(schema: string, key: string): Entity | null {
        const normalized = normalizeIdentifierKey(key);
        if (!normalized) return null;
        const candidates = (this.identifierIndex.get(normalized) ?? [])
            .map((id) => this.entities.get(id))
            .filter((e): e is Entity => e !== undefined);
        return candidates.find((e) => (e.ftmSchema || String(e.type)) === schema)
            ?? candidates[0]
            ?? null;
    }

    /**
     * The entity a create of `type` with `properties` describes, if one exists: first by
     * identifier, then by the label the create would compute, within the same schema and
     * type. Callers that used to rely on a same-label create overwriting the old note use
     * this to update the existing entity instead.
     *
     * The label match is refused when both sides carry a username key and none is shared
     * (a shared one would have matched above). An account's label is only its username,
     * so without this a Twitter "john" would merge into a GitHub "john", or into a "john"
     * whose platform nobody recorded, and take that account's provenance. Other kinds do
     * not veto: a person or organisation with a second email address is still the same one.
     */
    findExistingEntity(type: string, properties: Record<string, unknown>): Entity | undefined {
        const ftmSchema = isFTMSchema(type) ? type : legacyToFTMSchema(type as EntityType);
        const sameKind = (e: Entity) => String(e.type) === type && (e.ftmSchema || String(e.type)) === ftmSchema;
        const incomingKeys = identifierKeysForEntity({ type, ftmSchema, properties });
        for (const key of incomingKeys) {
            for (const id of this.identifierIndex.get(key) ?? []) {
                const e = this.entities.get(id);
                if (e && sameKind(e)) return e;
            }
        }
        const label = isFTMSchema(type)
            ? ftmSchemaService.getEntityLabel(type, properties)
            : this.computeEntityLabel(type, ftmSchema, properties);
        if (!label) return undefined;
        const isUsernameKey = (key: string) => key.startsWith('username:');
        const incomingHasUsername = incomingKeys.some(isUsernameKey);
        const conflicts = (e: Entity) =>
            incomingHasUsername && (this.identifierKeysById.get(e.id) ?? []).some(isUsernameKey);
        const wanted = label.toLowerCase();
        for (const e of this.entities.values()) {
            if (sameKind(e) && String(e.label ?? '').toLowerCase() === wanted && !conflicts(e)) return e;
        }
        return undefined;
    }

    /**
     * Add sources to an existing entity without touching its id, properties or note path.
     * A source whose content (see deterministicOsintSourceId) matches one already on the
     * entity is skipped, whatever id either was given, so sending the same capture twice
     * changes nothing: the second call does not even rewrite the note. Matching on content
     * rather than on ids also covers sources saved under the older random ids, and a
     * caller that reuses an id like `src_1` for different sources does not lose the new
     * one. Provenance fields (via, client_id, sha256, received_at) are carried through by
     * finalizeOsintSources.
     */
    async appendOsintSources(
        entityId: string,
        sources: OsintSourceInput[],
        options?: { captured_at?: string; conversation_id?: string },
    ): Promise<Entity | null> {
        const entity = this.entities.get(entityId);
        if (!entity) return null;

        const existing = entity.osint_sources ?? [];
        const seenContent = new Set(existing.map((s) => deterministicOsintSourceId(s)));
        const takenIds = new Set(existing.map((s) => s.id));
        const fresh: OsintSourceInput[] = [];
        for (const raw of sources) {
            const contentId = deterministicOsintSourceId(raw);
            if (seenContent.has(contentId)) continue;
            seenContent.add(contentId);
            // Keep the caller's id unless another source on this entity already has it.
            const own = raw.id?.trim();
            const id = own && !takenIds.has(own) ? own : contentId;
            takenIds.add(id);
            fresh.push({ ...raw, id });
        }
        if (fresh.length === 0) return entity;

        if (!this.assertPathWritable(entity.filePath, 'update entity')) return null;

        const added = finalizeOsintSources(fresh, {
            captured_at: options?.captured_at ?? new Date().toISOString(),
            conversation_id: options?.conversation_id,
        });
        const merged = [...existing, ...added];
        const previous = {
            osint_sources: entity.osint_sources,
            osint_confidence: entity.osint_confidence,
            osint_contradictions: entity.osint_contradictions,
        };
        entity.osint_sources = merged;
        const o = computeOsintConfidence(entity, merged);
        entity.osint_confidence = o.osint_confidence;
        entity.osint_contradictions = o.osint_contradictions;

        try {
            // Only provenance changed, so the note stays where it is even when its name is
            // not the one the label would give (a note the investigator renamed by hand):
            // moving it would break every link to it.
            entity.filePath = await this.saveEntityNote(entity, { keepPath: true });
        } catch (e) {
            // Leave memory matching the note on disk when the write did not happen.
            Object.assign(entity, previous);
            throw e;
        }
        this.settleEntityWrite(entity);
        return entity;
    }

    /**
     * Entry point for external ingestion: append `sources` to the entity already known by
     * `identifierKey` (or by an identifier in `properties` when no key is given), or create
     * a new entity when there is none. A match keeps its own properties; only provenance
     * is added.
     */
    async upsertEntityFromExternal(
        schema: string,
        properties: Record<string, unknown>,
        sources: OsintSourceInput[],
        options?: {
            identifierKey?: string;
            captured_at?: string;
            conversation_id?: string;
            /**
             * The id to give the entity if one is created (see createEntity's `id`). The
             * caller can then tell, even after a crash, whether the entity is one it made:
             * a match found by identifier keeps its own id.
             */
            createId?: string;
        },
    ): Promise<{ entity: Entity; created: boolean }> {
        // The caller's key first, then the identifiers in the properties: a key that does
        // not match (or does not parse) must not mean a duplicate of an entity the
        // properties would have found.
        //
        // A caller's username key is dropped when the properties name the account's own
        // username key and it is not that one: "username:john" sent with service: github
        // would otherwise merge a GitHub account into a platform-less "john".
        const propertyKeys = identifierKeysForEntity({ type: schema, ftmSchema: schema, properties });
        const callerKey = options?.identifierKey ? normalizeIdentifierKey(options.identifierKey) : null;
        const callerKeyContradicts = callerKey !== null
            && callerKey.startsWith('username:')
            && propertyKeys.some((k) => k.startsWith('username:'))
            && !propertyKeys.includes(callerKey);
        const keys = [
            ...(options?.identifierKey && !callerKeyContradicts ? [options.identifierKey] : []),
            ...propertyKeys,
        ];
        for (const key of keys) {
            const match = this.findEntityByIdentifier(schema, key);
            if (!match) continue;
            const entity = await this.appendOsintSources(match.id, sources, options);
            if (!entity) throw new Error('Entity note is locked');
            return { entity, created: false };
        }

        // finalizeOsintSources gives id-less sources content-derived ids, so a later append of
        // the same capture is a no-op.
        //
        // A name that is not an FTM schema is a legacy type (Phone, Username), created the
        // way @@create_entity creates it, so an item from outside lands as the same kind of
        // note the assistant would have written for it.
        const createOptions = {
            skipAutoGeocode: true,
            osint_sources: sources,
            osint_captured_at: options?.captured_at,
            conversation_id: options?.conversation_id,
            ...(options?.createId !== undefined ? { id: options.createId } : {}),
        };
        const entity = isFTMSchema(schema)
            ? await this.createFTMEntity(schema, properties, createOptions)
            : await this.createEntity(schema as EntityType, properties, createOptions);
        return { entity, created: true };
    }

    /**
     * The reverse of appendOsintSources: drop the sources with these ids and keep
     * everything else -- id, properties, the other sources and the note's path -- then
     * recompute confidence from what is left. Unknown ids are ignored, so undoing twice is
     * harmless. Returns null when the entity is gone or its note is locked.
     */
    async removeOsintSources(entityId: string, sourceIds: string[]): Promise<Entity | null> {
        const entity = this.entities.get(entityId);
        if (!entity) return null;
        const drop = new Set(sourceIds);
        const existing = entity.osint_sources ?? [];
        const kept = existing.filter((s) => !drop.has(s.id));
        if (kept.length === existing.length) return entity;

        if (!this.assertPathWritable(entity.filePath, 'update entity')) return null;

        const previous = {
            osint_sources: entity.osint_sources,
            osint_confidence: entity.osint_confidence,
            osint_contradictions: entity.osint_contradictions,
        };
        entity.osint_sources = kept;
        const o = computeOsintConfidence(entity, kept);
        entity.osint_confidence = o.osint_confidence;
        entity.osint_contradictions = o.osint_contradictions;
        try {
            // keepPath for the same reason as appendOsintSources: only provenance changed.
            entity.filePath = await this.saveEntityNote(entity, { keepPath: true });
        } catch (e) {
            Object.assign(entity, previous);
            throw e;
        }
        this.settleEntityWrite(entity);
        return entity;
    }

    /**
     * The id for an entity about to be created: a fresh one, or the caller's own. A caller's
     * id must look like a generated one and belong to nothing yet -- reusing an id would
     * make two notes one entity. Callers choose the id up front when they need to recognise
     * the entity later as the one they created (the extension inbox, across a crash).
     */
    private newEntityId(requested: string | undefined): string {
        if (requested === undefined) return generateId();
        if (!isGeneratedId(requested)) throw new Error(`Not an entity id: ${JSON.stringify(requested)}`);
        if (this.entities.has(requested) || this.connections.has(requested)) {
            throw new Error(`The id ${requested} is already in use`);
        }
        return requested;
    }

    /**
     * Create a new entity and save it as a note.
     * @param type - The entity type
     * @param properties - The entity properties
     * @param options - Optional settings for entity creation
     * @param options.skipAutoGeocode - If true, skip automatic geocoding for Location entities (default: false)
     */
    async createEntity(
        type: EntityType,
        properties: Record<string, unknown>,
        options?: {
            skipAutoGeocode?: boolean;
            manualLabel?: string;
            osint_sources?: OsintSource[] | OsintSourceInput[];
            osint_captured_at?: string;
            conversation_id?: string;
            /** A caller-chosen id instead of a generated one; see newEntityId. */
            id?: string;
        },
    ): Promise<Entity> {
        const id = this.newEntityId(options?.id);

        // For Location entities, attempt automatic geocoding if coordinates are missing
        // Skip if explicitly requested (e.g., for manual entity creation)
        if (type === EntityType.Location && !options?.skipAutoGeocode) {
            properties = await this.geocodeLocationIfNeeded(properties);
        }

        // Map the legacy type onto its FTM schema equivalent (when one exists) so that
        // entities created via the legacy path (e.g. Map View's "Add location") are later
        // recognized by FTM-aware UI such as FTMEntityEditModal instead of falling back to
        // a generic property editor.
        const mappedFtmSchema = legacyToFTMSchema(type);

        // Compute the label the same way updateEntity() will recompute it later -- see
        // computeEntityLabel()'s own doc comment for why this must be shared rather than each
        // call site picking a property independently (keeps the derived filename, see
        // saveFTMEntityAsNote, stable across the first edit instead of shifting underneath it).
        const label = options?.manualLabel || this.computeEntityLabel(type, mappedFtmSchema, properties);

        const entity: Entity = {
            id,
            type,
            label,
            properties,
        };

        if (mappedFtmSchema) {
            entity.ftmSchema = mappedFtmSchema;
        }

        this.mergeOsintOntoEntity(entity, options);

        // Save through the same path updateEntity() will use later (it branches on
        // entity.ftmSchema too, via saveFTMEntityAsNote's own label-only filename and
        // resolveEntityStorageFolder). Saving unconditionally via saveEntityAsNote here would
        // give the entity an ID-suffixed filename in a different folder than a later edit would
        // compute, so update would create a second, duplicate note instead of modifying this one.
        const filePath = entity.ftmSchema
            ? await this.saveFTMEntityAsNote(entity, entity.ftmSchema)
            : await this.saveEntityAsNote(entity);
        entity.filePath = filePath;

        this.putEntity(entity);
        return entity;
    }

    /**
     * Create a new FTM-compliant entity and save it as a note.
     * Uses FTM schema for property definitions and validation.
     * @param schemaName - The FTM schema name (e.g., 'Address', 'Person')
     * @param properties - The entity properties
     * @param options - Optional settings for entity creation
     * @param options.skipAutoGeocode - If true, skip automatic geocoding for Address entities (default: false)
     */
    async createFTMEntity(
        schemaName: string,
        properties: Record<string, unknown>,
        options?: {
            skipAutoGeocode?: boolean;
            manualLabel?: string;
            osint_sources?: OsintSource[] | OsintSourceInput[];
            osint_captured_at?: string;
            conversation_id?: string;
            /** A caller-chosen id instead of a generated one; see newEntityId. */
            id?: string;
        },
    ): Promise<Entity> {
        const id = this.newEntityId(options?.id);
        const config = getFTMEntityConfig(schemaName);

        if (!config) {
            throw new Error(`Unknown FTM schema: ${schemaName}`);
        }

        // For Address entities, attempt automatic geocoding if coordinates are missing
        // Skip if explicitly requested (e.g., for manual entity creation)
        if (schemaName === 'Address' && !options?.skipAutoGeocode) {
            properties = await this.geocodeAddressIfNeeded(properties);
        }

        // Get label from FTM schema or use manual label
        const label = options?.manualLabel || ftmSchemaService.getEntityLabel(schemaName, properties);

        const entity: Entity = {
            id,
            type: schemaName as EntityType,  // Use schema name as type
            label,
            properties,
            ftmSchema: schemaName,  // Store FTM schema name
            schemaFamily: 'ftm',
        };

        this.mergeOsintOntoEntity(entity, options);

        // Create the note using FTM-aware save
        const filePath = await this.saveFTMEntityAsNote(entity, schemaName);
        entity.filePath = filePath;

        this.putEntity(entity);
        return entity;
    }

    /**
     * Geocode an Address entity's properties if coordinates are missing.
     */
    private async geocodeAddressIfNeeded(properties: Record<string, unknown>): Promise<Record<string, unknown>> {
        const hasLatitude = properties.latitude !== undefined && properties.latitude !== null && properties.latitude !== '';
        const hasLongitude = properties.longitude !== undefined && properties.longitude !== null && properties.longitude !== '';

        if (hasLatitude && hasLongitude) {
            return properties;
        }
        // Geocoding is opt-in: without a configured service, leave the coordinates empty.
        if (!isGeocodingConfigured()) return properties;

        const address = (properties.full as string) || (properties.street as string);
        const city = properties.city as string;
        const state = (properties.state as string) || (properties.region as string);
        const country = properties.country as string;

        if (!address && !city && !state && !country) {
            return properties;
        }

        try {
            const result = await geocodingService.geocodeAddressWithRetry(address, city, state, country);
            return {
                ...properties,
                latitude: result.latitude,
                longitude: result.longitude,
                city: properties.city || result.city,
                state: properties.state || result.state,
                country: properties.country || result.country,
                postalCode: properties.postalCode || result.postalCode
            };
        } catch (error) {
            console.warn('[EntityManager] FTM Address geocoding failed:', error);
            return properties;
        }
    }

    /**
     * Create an entity from a catalog definition (STIX, MITRE, user YAML).
     * FTM family still uses {@link createFTMEntity} — call that from the UI when family is ftm.
     */
    async createCatalogEntity(
        cat: CatalogEntityType,
        properties: Record<string, unknown>,
        options?: { manualLabel?: string }
    ): Promise<Entity> {
        if (cat.family === 'ftm') {
            return this.createFTMEntity(cat.name, properties, {
                skipAutoGeocode: true,
                manualLabel: options?.manualLabel,
            });
        }

        const id = generateId();
        const lf = cat.labelField;
        const rawLabel = options?.manualLabel ?? properties[lf];
        const label =
            rawLabel !== undefined && rawLabel !== null && String(rawLabel).trim() !== ''
                ? String(rawLabel).trim()
                : `New ${cat.label}`;

        const entity: Entity = {
            id,
            type: cat.name,
            label,
            properties,
            schemaFamily: cat.family,
        };

        const filePath = await this.saveCatalogEntityNote(entity, cat);
        entity.filePath = filePath;
        this.putEntity(entity);
        return entity;
    }

    private resolveEntityStorageFolder(entity: Entity, typeFolderName: string): string {
        if (entity.filePath) {
            const p = entity.filePath;
            const lastSlash = p.lastIndexOf('/');
            if (lastSlash > 0) {
                return normalizePath(p.substring(0, lastSlash));
            }
        }
        const family = entity.schemaFamily ?? 'ftm';
        return normalizePath(`${this.basePath}/${family}/${typeFolderName}`);
    }

    /**
     * The path a note is written to: `<stem>.md` in `folderPath`, unless that file belongs
     * to someone else. Used for entity notes and connection notes alike (`owner` is the
     * entity or connection; ids are unique across both).
     *
     * Two entities can share a label (two people called John Smith; a page title sent
     * twice), and so can their connections. Writing by label alone used to overwrite the
     * first one's note with the second's id, properties and sources, silently erasing its
     * provenance. Now a name held by another owner is skipped for `<stem> (<id prefix>).md`,
     * then `<stem> (<full id>).md`.
     *
     * The chosen path is recorded on the owner (callers assign it to filePath), and a later
     * save keeps that path while it is still one of this stem's names. With `keepPath`, it
     * is kept whatever it is called, as long as the note there is still this owner's: a save
     * that did not change the label must not move a note the investigator renamed, since
     * links point at the file. Otherwise, when the label changes, the note is renamed rather
     * than a second copy written beside it, so each entity only ever has one file and
     * updates, deletes and undo all find it.
     */
    private async claimNotePath(
        owner: { id: string; filePath?: string },
        folderPath: string,
        stem: string,
        options?: { keepPath?: boolean },
    ): Promise<string> {
        const names = [
            stem,
            `${stem} (${owner.id.substring(0, 6)})`,
            `${stem} (${owner.id})`,
        ].map((name) => normalizePath(`${folderPath}/${sanitizeFilename(name)}.md`));
        const current = owner.filePath ? normalizePath(owner.filePath) : undefined;
        const currentFile = current ? this.app.vault.getAbstractFileByPath(current) : null;

        if (current && (names.includes(current) || options?.keepPath) && await this.isNotePathFreeFor(current, owner.id)) {
            return current;
        }

        for (const candidate of names) {
            if (candidate === current) continue;
            if (!(await this.isNotePathFreeFor(candidate, owner.id))) continue;
            if (current && currentFile instanceof TFile && await this.isNotePathFreeFor(current, owner.id)) {
                if (!this.assertPathWritable(current, 'rename note')) {
                    throw new Error('Path locked');
                }
                await this.app.vault.rename(currentFile, candidate);
                owner.filePath = candidate;
            }
            return candidate;
        }
        throw new Error(`No free note path for ${owner.id} in ${folderPath}`);
    }

    /**
     * Whether `path` is free for `ownerId` (an entity or connection id): nothing there, or a
     * note that is its own. An unknown note (not loaded, or hand-written) counts as its own
     * only when its front matter carries the same id -- anything unreadable is left alone.
     *
     * A note whose name differs only in letter case counts as being at `path`: the vault
     * index is case-sensitive, but on Windows and macOS the filesystem is not, and a
     * rename onto such a name would replace the other note.
     */
    private async isNotePathFreeFor(path: string, ownerId: string): Promise<boolean> {
        const file = this.findNoteFileIgnoringCase(path);
        if (!file) return true;
        if (!(file instanceof TFile)) return false;
        const at = normalizePath(file.path);
        let owned = false;
        for (const other of [...this.entities.values(), ...this.connections.values()]) {
            if (!other.filePath || normalizePath(other.filePath) !== at) continue;
            if (other.id !== ownerId) return false;
            owned = true;
        }
        if (owned) return true;
        try {
            return this.parseFrontmatter(await this.app.vault.read(file))?.id === ownerId;
        } catch {
            return false;
        }
    }

    private findNoteFileIgnoringCase(path: string): TAbstractFile | null {
        const exact = this.app.vault.getAbstractFileByPath(path);
        if (exact) return exact;
        const slash = path.lastIndexOf('/');
        const folder = this.app.vault.getAbstractFileByPath(slash > 0 ? path.substring(0, slash) : '/');
        if (!(folder instanceof TFolder)) return null;
        // NFC as well as case: macOS also treats a precomposed "é" and "e" plus a combining
        // accent as one name. normalizePath already composes both sides today; folding here
        // keeps the guard right for a caller that passes a path it did not normalize.
        const fold = (p: string) => p.normalize('NFC').toLowerCase();
        const wanted = fold(path);
        return folder.children.find((child) => fold(normalizePath(child.path)) === wanted) ?? null;
    }

    /**
     * Save an FTM entity as an Obsidian note.
     */
    private async saveFTMEntityAsNote(
        entity: Entity,
        schemaName: string,
        options?: { keepPath?: boolean },
    ): Promise<string> {
        const folderPath = this.resolveEntityStorageFolder(entity, schemaName);

        // Ensure folder exists
        await this.ensureFolderExists(folderPath);

        const filePath = await this.claimNotePath(entity, folderPath, entity.label, options);

        // Build frontmatter using FTM schema
        const frontmatter = this.buildFTMFrontmatter(entity, schemaName);

        // Build note content
        const content = `---
${frontmatter}
---

# ${stripControls(entity.label)}

## Properties

${this.buildFTMPropertiesSection(entity, schemaName)}

## Relationships

<!-- Add relationships using wikilinks: [[Entity Name]] RELATIONSHIP_TYPE [[Target Entity]] -->

## Notes

${(entity.properties.notes as string) || ''}
`;

        // Check if file exists
        const existingFile = this.app.vault.getAbstractFileByPath(filePath);
        if (existingFile instanceof TFile) {
            const pathToCheck = entity.filePath || filePath;
            if (!this.assertPathWritable(pathToCheck, 'update entity note')) {
                throw new Error('Path locked');
            }
            await this.app.vault.modify(existingFile, content);
        } else {
            await this.app.vault.create(filePath, content);
        }

        this.scheduleWaybackForNote(filePath);
        try {
            await this.writeEntityYamlFile(entity);
        } catch (e) {
            console.warn('[EntityManager] graph-yaml entity write failed:', e);
        }
        return filePath;
    }

    private async saveCatalogEntityNote(
        entity: Entity,
        cat: CatalogEntityType,
        options?: { keepPath?: boolean },
    ): Promise<string> {
        const folderPath = this.resolveEntityStorageFolder(entity, cat.name);
        await this.ensureFolderExists(folderPath);

        const filePath = await this.claimNotePath(entity, folderPath, entity.label, options);
        const frontmatter = this.buildCatalogFrontmatter(entity, cat);
        const content = `---
${frontmatter}
---

# ${stripControls(entity.label)}

## Properties

${this.buildCatalogPropertiesSection(entity, cat)}

## Relationships

<!-- Add relationships using wikilinks: [[Entity Name]] RELATIONSHIP_TYPE [[Target Entity]] -->

## Notes

${(entity.properties.notes as string) || ''}
`;

        const existingFile = this.app.vault.getAbstractFileByPath(filePath);
        if (existingFile instanceof TFile) {
            const pathToCheck = entity.filePath || filePath;
            if (!this.assertPathWritable(pathToCheck, 'update entity note')) {
                throw new Error('Path locked');
            }
            await this.app.vault.modify(existingFile, content);
        } else {
            await this.app.vault.create(filePath, content);
        }

        this.scheduleWaybackForNote(filePath);
        try {
            await this.writeEntityYamlFile(entity);
        } catch (e) {
            console.warn('[EntityManager] graph-yaml entity write failed:', e);
        }
        return filePath;
    }

    private buildCatalogFrontmatter(entity: Entity, cat: CatalogEntityType): string {
        const lines: string[] = [
            yamlScalarLine('id', entity.id),
            `type: ${yamlPlainOrQuote(String(entity.type))}`,
            `schemaFamily: ${yamlPlainOrQuote(cat.family)}`,
            yamlScalarLine('label', String(entity.label)),
        ];
        const propsChunk: Record<string, unknown> = {};

        for (const [prop, value] of Object.entries(entity.properties)) {
            this.appendEntityPropertyToFrontmatter(lines, propsChunk, prop, value);
        }

        this.appendPropsChunk(lines, propsChunk);
        this.appendOsintFrontmatter(lines, entity);
        return lines.join('\n');
    }

    private buildCatalogPropertiesSection(entity: Entity, cat: CatalogEntityType): string {
        const lines: string[] = [];
        const order = [...cat.required, ...cat.featured, ...Object.keys(entity.properties)];
        const shown = new Set<string>();

        for (const prop of order) {
            if (shown.has(prop)) continue;
            shown.add(prop);
            const value = entity.properties[prop];
            if (value === undefined || value === null || value === '') continue;
            const def = cat.properties[prop];
            const lab = def?.label || prop;
            lines.push(`- **${lab}**: ${String(value)}`);
        }

        return lines.length > 0 ? lines.join('\n') : '_No properties set_';
    }

    /**
     * Build YAML frontmatter for an FTM entity.
     */
    private buildFTMFrontmatter(entity: Entity, schemaName: string): string {
        const lines: string[] = [
            yamlScalarLine('id', entity.id),
            `type: ${yamlPlainOrQuote(String(entity.type))}`,
            `schemaFamily: ftm`,
            `ftmSchema: ${yamlPlainOrQuote(schemaName)}`,
            yamlScalarLine('label', entity.label),
        ];
        const propsChunk: Record<string, unknown> = {};

        const config = getFTMEntityConfig(schemaName);
        if (!config) return lines.join('\n');

        // Add all properties from the entity
        for (const [prop, value] of Object.entries(entity.properties)) {
            this.appendEntityPropertyToFrontmatter(lines, propsChunk, prop, value);
        }

        this.appendPropsChunk(lines, propsChunk);
        this.appendOsintFrontmatter(lines, entity);
        return lines.join('\n');
    }

    /**
     * Build the properties section for an FTM entity note.
     */
    private buildFTMPropertiesSection(entity: Entity, schemaName: string): string {
        const lines: string[] = [];
        const config = getFTMEntityConfig(schemaName);

        if (!config) return '_No properties set_';

        // Show required and featured properties first
        const priorityProps = [...config.requiredProperties, ...config.featuredProperties];
        const shownProps = new Set<string>();

        for (const prop of priorityProps) {
            if (shownProps.has(prop)) continue;
            shownProps.add(prop);

            const value = entity.properties[prop];
            const propDef = config.propertyDefinitions[prop];
            const label = propDef?.label || prop;

            if (value !== undefined && value !== null && value !== '') {
                lines.push(`- **${label}**: ${String(value)}`);
            }
        }

        // Show other properties
        for (const [prop, value] of Object.entries(entity.properties)) {
            if (shownProps.has(prop)) continue;
            if (value === undefined || value === null || value === '') continue;
            if (prop === 'notes') continue;  // Notes shown separately

            const propDef = config.propertyDefinitions[prop];
            const label = propDef?.label || prop;
            lines.push(`- **${label}**: ${String(value)}`);
        }

        return lines.length > 0 ? lines.join('\n') : '_No properties set_';
    }

    /**
     * Geocode a Location entity's properties if coordinates are missing.
     * Uses the address, city, state, country fields to build a geocoding query.
     */
    private async geocodeLocationIfNeeded(properties: Record<string, unknown>): Promise<Record<string, unknown>> {
        // Check if coordinates already exist and are valid
        const hasLatitude = properties.latitude !== undefined && properties.latitude !== null && properties.latitude !== '';
        const hasLongitude = properties.longitude !== undefined && properties.longitude !== null && properties.longitude !== '';

        if (hasLatitude && hasLongitude) {
            console.debug('[EntityManager] Location already has coordinates:', properties.latitude, properties.longitude);
            return properties;
        }
        // Geocoding is opt-in: without a configured service, leave the coordinates empty.
        if (!isGeocodingConfigured()) return properties;

        // Build geocoding query from available address fields
        const address = properties.address as string;
        const city = properties.city as string;
        const state = properties.state as string;
        const country = properties.country as string;

        // Need at least one field to geocode
        if (!address && !city && !state && !country) {
            console.debug('[EntityManager] No address fields available for geocoding');
            return properties;
        }

        try {
            console.debug('[EntityManager] Attempting to geocode location:', { address, city, state, country });
            const result = await geocodingService.geocodeAddressWithRetry(address, city, state, country);

            // Update properties with geocoded coordinates
            const updatedProperties: Record<string, unknown> = {
                ...properties,
                latitude: result.latitude,
                longitude: result.longitude
            };

            // Optionally fill in missing address fields from geocoding result
            if (!city && result.city) {
                updatedProperties.city = result.city;
            }
            if (!state && result.state) {
                updatedProperties.state = result.state;
            }
            if (!country && result.country) {
                updatedProperties.country = result.country;
            }
            if (!properties.postal_code && result.postalCode) {
                updatedProperties.postal_code = result.postalCode;
            }

            console.debug('[EntityManager] Geocoding successful:', result.latitude, result.longitude, `(${result.confidence} confidence)`);
            new Notice(`📍 Location geocoded: ${result.displayName.substring(0, 50)}...`);

            return updatedProperties;

        } catch (error) {
            if (error instanceof GeocodingError) {
                console.warn('[EntityManager] Geocoding failed:', error.type, error.message);
                if (error.type === GeocodingErrorType.NotFound) {
                    new Notice("⚠️ could not find coordinates for location. You can add them manually.");
                } else if (error.type === GeocodingErrorType.RateLimited) {
                    new Notice("⚠️ geocoding rate limited. Coordinates can be added manually.");
                } else {
                    new Notice(`⚠️ Geocoding failed: ${error.message}`);
                }
            } else {
                console.error('[EntityManager] Unexpected geocoding error:', error);
                new Notice("⚠️ could not geocode location. You can add coordinates manually.");
            }
            // Return original properties without coordinates - entity creation continues
            return properties;
        }
    }

    /**
     * Save an entity as an Obsidian note.
     */
    private async saveEntityAsNote(entity: Entity, options?: { keepPath?: boolean }): Promise<string> {
        const folderPath = normalizePath(`${this.basePath}/${entity.type}`);

        // Ensure the folder exists before creating the file
        await this.ensureFolderExists(folderPath);

        const filePath = await this.claimNotePath(entity, folderPath, this.legacyNoteStem(entity), options);

        // Build frontmatter
        const frontmatter = this.buildFrontmatter(entity);

        // Build note content
        const content = `---
${frontmatter}
---

# ${stripControls(entity.label)}

## Properties

${this.buildPropertiesSection(entity)}

## Relationships

<!-- Add relationships using wikilinks: [[Entity Name]] RELATIONSHIP_TYPE [[Target Entity]] -->

## Notes

${(entity.properties.notes as string) || ''}
`;

        // Check if file exists
        const existingFile = this.app.vault.getAbstractFileByPath(filePath);
        if (existingFile instanceof TFile) {
            const pathToCheck = entity.filePath || filePath;
            if (!this.assertPathWritable(pathToCheck, 'update entity note')) {
                throw new Error('Path locked');
            }
            await this.app.vault.modify(existingFile, content);
        } else {
            await this.app.vault.create(filePath, content);
        }

        this.scheduleWaybackForNote(filePath);
        try {
            await this.writeEntityYamlFile(entity);
        } catch (e) {
            console.warn('[EntityManager] graph-yaml entity write failed:', e);
        }
        return filePath;
    }

    /**
     * Build YAML frontmatter for an entity.
     */
    private buildFrontmatter(entity: Entity): string {
        const lines: string[] = [
            yamlScalarLine('id', entity.id),
            `type: ${yamlPlainOrQuote(String(entity.type))}`,
            yamlScalarLine('label', entity.label),
            `aliases: [${yamlQuote(entity.label)}]`,
        ];
        const propsChunk: Record<string, unknown> = {};

        const config = ENTITY_CONFIGS[entity.type as EntityType];
        if (!config) {
            // If no config found, just add all properties
            for (const [prop, value] of Object.entries(entity.properties)) {
                this.appendEntityPropertyToFrontmatter(lines, propsChunk, prop, value);
            }
        } else {
            const allProps = [...config.properties, ...COMMON_PROPERTIES];

            for (const prop of allProps) {
                const value = entity.properties[prop];
                this.appendEntityPropertyToFrontmatter(lines, propsChunk, prop, value);
            }
        }

        this.appendPropsChunk(lines, propsChunk);
        this.appendOsintFrontmatter(lines, entity);
        return lines.join('\n');
    }

    private frontmatterBlockForEntity(entity: Entity): string {
        if (entity.ftmSchema) {
            return this.buildFTMFrontmatter(entity, entity.ftmSchema);
        }
        if (entity.schemaFamily && entity.schemaFamily !== 'ftm' && this.schemaCatalog) {
            const cat = this.schemaCatalog.getEntityType(entity.schemaFamily, String(entity.type));
            if (cat) return this.buildCatalogFrontmatter(entity, cat);
        }
        return this.buildFrontmatter(entity);
    }

    /**
     * Rewrite entity note frontmatter with reserved-key-safe serialization.
     * Keeps body untouched; only updates frontmatter block.
     */
    async migrateReservedPropertyFrontmatter(): Promise<{ scanned: number; fixed: number; skipped: number; errors: number }> {
        await this.loadEntitiesFromNotes();
        let scanned = 0;
        let fixed = 0;
        let skipped = 0;
        let errors = 0;

        for (const entity of this.entities.values()) {
            scanned++;
            if (!entity.filePath) {
                skipped++;
                continue;
            }
            try {
                const file = this.app.vault.getAbstractFileByPath(entity.filePath);
                if (!(file instanceof TFile)) {
                    skipped++;
                    continue;
                }
                const content = await this.app.vault.read(file);
                const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
                if (!fmMatch) {
                    skipped++;
                    continue;
                }
                const nextFm = this.frontmatterBlockForEntity(entity);
                // Splice rather than String.replace: a replacement string expands $' $` $&,
                // so a label containing $' would paste the raw note body into the front matter.
                const replaced = `---\n${nextFm}\n---` + content.slice(fmMatch[0].length);
                if (replaced !== content) {
                    if (!this.assertPathWritable(entity.filePath, 'migrate entity frontmatter')) {
                        skipped++;
                        continue;
                    }
                    await this.app.vault.modify(file, replaced);
                    fixed++;
                } else {
                    skipped++;
                }
            } catch (e) {
                errors++;
                console.warn('[EntityManager] migrateReservedPropertyFrontmatter failed:', e);
            }
        }

        return { scanned, fixed, skipped, errors };
    }

    /**
     * Build the properties section for a note.
     */
    private buildPropertiesSection(entity: Entity): string {
        const lines: string[] = [];
        const config = ENTITY_CONFIGS[entity.type as EntityType];

        if (!config) {
            // If no config found, show all properties
            for (const [prop, value] of Object.entries(entity.properties)) {
                if (value !== undefined && value !== null && value !== '') {
                    lines.push(`- **${prop}**: ${value}`);
                }
            }
        } else {
            for (const prop of config.properties) {
                const value = entity.properties[prop];
                if (value !== undefined && value !== null && value !== '') {
                    lines.push(`- **${prop}**: ${value}`);
                }
            }
        }

        return lines.length > 0 ? lines.join('\n') : '_No properties set_';
    }

    /**
     * Update an existing entity.
     */
    async updateEntity(entityId: string, properties: Record<string, unknown>): Promise<Entity | null> {
        const entity = this.entities.get(entityId);
        if (!entity) return null;

        if (!this.assertPathWritable(entity.filePath, 'update entity')) return null;

        const previousLabel = entity.label;

        // Update properties
        entity.properties = { ...entity.properties, ...properties };

        // Update label based on entity type -- computeEntityLabel() must match createEntity()'s
        // computation exactly (same function, same fallback behavior) or the derived filename
        // (saveFTMEntityAsNote) shifts on this very save.
        if (entity.ftmSchema) {
            entity.label = this.computeEntityLabel(entity.type, entity.ftmSchema, entity.properties);
        } else if (entity.schemaFamily && entity.schemaFamily !== 'ftm') {
            entity.label = this.schemaCatalog?.getInstanceLabel(entity) ?? entity.label;
        } else {
            entity.label = getEntityLabel(entity.type, entity.properties);
        }

        // A label change renames the note, so record where it is now. When the label is
        // unchanged the note stays put, whatever its file is called.
        entity.filePath = await this.saveEntityNote(entity, { keepPath: entity.label === previousLabel });
        this.settleEntityWrite(entity);

        return entity;
    }

    /** Save an existing entity through the writer its kind uses; returns the note path. */
    private async saveEntityNote(entity: Entity, options?: { keepPath?: boolean }): Promise<string> {
        if (entity.ftmSchema) {
            return this.saveFTMEntityAsNote(entity, entity.ftmSchema, options);
        }
        if (entity.schemaFamily && entity.schemaFamily !== 'ftm' && this.schemaCatalog) {
            const cat = this.schemaCatalog.getEntityType(entity.schemaFamily, String(entity.type));
            if (cat) return this.saveCatalogEntityNote(entity, cat, options);
        }
        return this.saveEntityAsNote(entity, options);
    }

    /** saveEntityAsNote's file stem: legacy (non-FTM, non-catalog) notes carry an id suffix. */
    private legacyNoteStem(entity: Entity): string {
        return `${entity.label}_${entity.id.substring(0, 8)}`;
    }

    /**
     * Delete an entity and its note.
     */
    async deleteEntity(entityId: string): Promise<boolean> {
        const entity = this.entities.get(entityId);
        if (!entity) return false;

        if (!this.assertPathWritable(entity.filePath, 'delete entity')) return false;

        const connIdsToDrop: string[] = [];
        for (const [connId, conn] of this.connections) {
            if (conn.fromEntityId === entityId || conn.toEntityId === entityId) {
                connIdsToDrop.push(connId);
            }
        }

        try {
            await this.deleteYamlFileIfExists(this.entityYamlFilePath(entity));
            for (const cid of connIdsToDrop) {
                await this.deleteYamlFileIfExists(this.connectionYamlFilePath(cid));
            }
        } catch (e) {
            console.warn('[EntityManager] graph-yaml delete failed:', e);
        }

        // Delete the note file
        if (entity.filePath) {
            const file = this.app.vault.getAbstractFileByPath(entity.filePath);
            if (file instanceof TFile) {
                await this.app.fileManager.trashFile(file);
            }
        }

        // Remove from maps
        this.dropEntity(entityId);

        // Remove related connections
        for (const connId of connIdsToDrop) {
            this.dropConnection(connId);
        }

        return true;
    }

    /**
     * Delete an entity without deleting the note file (for undo operations).
     */
    deleteEntityInMemory(entityId: string): boolean {
        const entity = this.entities.get(entityId);
        if (!entity) return false;

        // Remove from maps
        this.dropEntity(entityId);

        // Remove related connections
        for (const [connId, conn] of this.connections) {
            if (conn.fromEntityId === entityId || conn.toEntityId === entityId) {
                this.dropConnection(connId);
            }
        }

        return true;
    }

    /**
     * Restore an entity (for undo operations).
     * Recreates the entity and its note file.
     */
    async restoreEntity(entity: Entity): Promise<boolean> {
        try {
            const family = entity.schemaFamily ?? 'ftm';
            const own = entity.filePath ? normalizePath(entity.filePath) : '';
            const folderPath = own.includes('/')
                ? own.substring(0, own.lastIndexOf('/'))
                : normalizePath(`${this.basePath}/${family}/${String(entity.type)}`);
            await this.ensureFolderExists(folderPath);

            // Generate note content
            const content = this.generateNoteContent(entity);

            // Back to its own path, whatever it was called, when that is still free; another
            // entity may have taken the name while this one was deleted, and restoring must
            // not overwrite it. The fallback names beside it follow the writer's convention.
            const isLegacy = !entity.ftmSchema && !(entity.schemaFamily && entity.schemaFamily !== 'ftm');
            const filePath = await this.claimNotePath(
                { id: entity.id, filePath: entity.filePath },
                folderPath,
                isLegacy ? this.legacyNoteStem(entity) : entity.label,
                { keepPath: true },
            );

            if (!this.assertPathWritable(filePath, 'restore entity')) return false;

            // Check if file already exists
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile) {
                // Update existing file
                if (existingFile instanceof TFile) {
                    await this.app.vault.modify(existingFile, content);
                }
            } else {
                // Create new file
                await this.app.vault.create(filePath, content);
            }

            // Add to entities map
            const restoredEntity = { ...entity, filePath };
            this.putEntity(restoredEntity);

            try {
                await this.writeEntityYamlFile(restoredEntity);
            } catch (e) {
                console.warn('[EntityManager] graph-yaml entity write failed:', e);
            }

            return true;
        } catch (error) {
            console.error(`[EntityManager] Failed to restore entity:`, error);
            return false;
        }
    }

    /**
     * Update an entity (for undo/redo operations).
     */
    async updateEntityForHistory(entity: Entity): Promise<boolean> {
        try {
            // The history snapshot can carry a path the note has since moved from (a label
            // change renames it), and another entity may now own that name. Write to where
            // this entity's note is now, and only if that note is still its own.
            const livePath = this.entities.get(entity.id)?.filePath ?? entity.filePath;
            if (livePath) entity.filePath = livePath;

            if (!this.assertPathWritable(entity.filePath, 'update entity')) return false;

            const file = entity.filePath ? this.app.vault.getAbstractFileByPath(entity.filePath) : null;
            if (file instanceof TFile && !(await this.isNotePathFreeFor(entity.filePath!, entity.id))) {
                // The note there is someone else's now. Refuse the whole undo rather than
                // change memory and the graph yaml while the note says otherwise.
                console.warn(`[EntityManager] Not undoing ${entity.id}: ${entity.filePath} belongs to another entity`);
                return false;
            }

            // Note first: if the write fails, memory and the graph yaml still match the
            // note on disk, and the caller is told the undo did not happen.
            if (file instanceof TFile) {
                const content = this.generateNoteContent(entity);
                await this.app.vault.modify(file, content);
            }

            this.putEntity(entity);

            try {
                await this.writeEntityYamlFile(entity);
            } catch (e) {
                console.warn('[EntityManager] graph-yaml entity write failed:', e);
            }

            return true;
        } catch (error) {
            console.error(`[EntityManager] Failed to update entity:`, error);
            return false;
        }
    }

    /**
     * Generate note content for an entity.
     */
    private generateNoteContent(entity: Entity): string {
        const lines: string[] = [];
        const now = new Date().toISOString();

        // Frontmatter
        lines.push('---');
        lines.push(`id: ${yamlPlainOrQuote(entity.id)}`);
        lines.push(`type: ${yamlPlainOrQuote(String(entity.type))}`);
        lines.push(yamlScalarLine('label', entity.label));
        lines.push(`created: ${now}`);
        lines.push(`modified: ${now}`);

        // Add properties to frontmatter. Keys this writer emits itself go under `props:`,
        // as in the other writers, so a property named `id` cannot re-point the note.
        const propsChunk: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(entity.properties)) {
            if (value === undefined || value === null || value === '') continue;
            if (HISTORY_NOTE_FRONTMATTER_KEYS.has(key)) {
                this.appendEntityPropertyToFrontmatter(lines, propsChunk, key, value, HISTORY_NOTE_FRONTMATTER_KEYS);
                continue;
            }
            if (UNSAFE_PROPERTY_KEYS.has(key)) continue;
            // Non-scalars are written as their String() form, as before, but quoted.
            lines.push(yamlScalarLine(key, value));
        }
        this.appendPropsChunk(lines, propsChunk);

        lines.push('---');
        lines.push('');
        lines.push(`# ${stripControls(entity.label)}`);
        lines.push('');
        lines.push(`**Type:** ${entity.type}`);
        lines.push('');

        // Add properties section
        if (Object.keys(entity.properties).length > 0) {
            lines.push('## Properties');
            lines.push('');
            for (const [key, value] of Object.entries(entity.properties)) {
                if (value !== undefined && value !== null && value !== '') {
                    lines.push(`- **${key}:** ${value}`);
                }
            }
            lines.push('');
        }

        // Add relationships section placeholder
        lines.push('## Relationships');
        lines.push('');

        return lines.join('\n');
    }

    /**
     * Delete multiple entities and their notes in bulk.
     * More efficient than calling deleteEntity multiple times.
     * @param entityIds Array of entity IDs to delete
     * @returns Object with count of deleted entities and array of failed entity IDs
     */
    async deleteEntities(entityIds: string[]): Promise<{ deleted: number; failed: string[] }> {
        let deleted = 0;
        const failed: string[] = [];

        // Collect all connection IDs to delete (to avoid modifying map while iterating)
        const connectionIdsToDelete: Set<string> = new Set();

        for (const entityId of entityIds) {
            try {
                const entity = this.entities.get(entityId);
                if (!entity) {
                    failed.push(entityId);
                    continue;
                }

                if (!this.assertPathWritable(entity.filePath, 'delete entity')) {
                    failed.push(entityId);
                    continue;
                }

                try {
                    await this.deleteYamlFileIfExists(this.entityYamlFilePath(entity));
                } catch (e) {
                    console.warn('[EntityManager] graph-yaml entity delete failed:', e);
                }

                // Delete the note file
                if (entity.filePath) {
                    const file = this.app.vault.getAbstractFileByPath(entity.filePath);
                    if (file instanceof TFile) {
                        await this.app.fileManager.trashFile(file);
                    }
                }

                // Remove from entities map
                this.dropEntity(entityId);

                // Collect related connections for deletion
                for (const [connId, conn] of this.connections) {
                    if (conn.fromEntityId === entityId || conn.toEntityId === entityId) {
                        connectionIdsToDelete.add(connId);
                    }
                }

                deleted++;
            } catch (error) {
                console.error(`[EntityManager] Failed to delete entity ${entityId}:`, error);
                failed.push(entityId);
            }
        }

        // Delete all collected connections
        for (const connId of connectionIdsToDelete) {
            try {
                await this.deleteYamlFileIfExists(this.connectionYamlFilePath(connId));
            } catch (e) {
                console.warn('[EntityManager] graph-yaml connection delete failed:', e);
            }
            this.dropConnection(connId);
        }

        return { deleted, failed };
    }

    /**
     * Create a connection between two entities.
     * Now supports FTM interval properties and creates a connection note file.
     */
    async createConnection(
        fromEntityId: string,
        toEntityId: string,
        relationship: string,
        properties?: Record<string, unknown>,
        options?: {
            schemaFamily?: SchemaFamily;
            osint_sources?: OsintSource[] | OsintSourceInput[];
            osint_captured_at?: string;
            conversation_id?: string;
        },
    ): Promise<Connection | null> {
        const fromEntity = this.entities.get(fromEntityId);
        const toEntity = this.entities.get(toEntityId);

        if (!fromEntity || !toEntity) return null;

        if (!this.assertPathWritable(fromEntity.filePath, 'add connection')) return null;
        if (!this.assertPathWritable(toEntity.filePath, 'add connection')) return null;

        const id = generateId();

        // Create label for the connection
        const label = `${fromEntity.label} → ${relationship} → ${toEntity.label}`;

        const family = options?.schemaFamily ?? 'ftm';
        const isFtmFamily = family === 'ftm';

        const connection: Connection = {
            id,
            fromEntityId,
            toEntityId,
            relationship: relationship,
            label,
            properties: properties || {},
            ftmSchema: isFtmFamily ? relationship : undefined,
            schemaFamily: family,
        };

        this.mergeOsintOntoConnection(connection, options);

        // Create the connection note file
        const filePath = await this.saveConnectionAsNote(connection, fromEntity, toEntity);
        connection.filePath = filePath;

        this.putConnection(connection);

        // Also update the source entity's note with the relationship (for backward compatibility)
        await this.addRelationshipToNote(fromEntity, toEntity, relationship);

        return connection;
    }

    /**
     * Replace an existing connection's properties.
     * `properties` is the connection's complete property set, not a patch: a key missing
     * from it is removed, so a field cleared or deleted in the editor stays gone.
     * Updates both the in-memory connection and the connection note file.
     */
    async updateConnection(connectionId: string, properties: Record<string, unknown>): Promise<Connection | null> {
        const connection = this.connections.get(connectionId);
        if (!connection) return null;

        const fromEntity = this.entities.get(connection.fromEntityId);
        const toEntity = this.entities.get(connection.toEntityId);

        if (!fromEntity || !toEntity) return null;

        if (!this.assertPathWritable(connection.filePath, 'update connection')) return null;

        // Replace, not merge: a merge brought back every key the caller had removed.
        connection.properties = { ...properties };

        // Update the connection note file
        if (connection.filePath) {
            const file = this.app.vault.getAbstractFileByPath(connection.filePath);
            if (file instanceof TFile) {
                // Regenerate the note content with updated properties
                const content = this.generateConnectionNoteContent(connection, fromEntity, toEntity);
                await this.app.vault.modify(file, content);
            }
        } else {
            // If no file path exists, create the note
            const filePath = await this.saveConnectionAsNote(connection, fromEntity, toEntity);
            connection.filePath = filePath;
        }
        // As settleEntityWrite: this object, as its note now is, is the one in memory.
        this.putConnection(connection);

        try {
            await this.writeConnectionYamlFile(connection);
        } catch (e) {
            console.warn('[EntityManager] graph-yaml connection write failed:', e);
        }

        return connection;
    }

    /**
     * Update a connection (for undo/redo operations).
     */
    async updateConnectionForHistory(connection: Connection): Promise<boolean> {
        try {
            if (!this.assertPathWritable(connection.filePath, 'update connection')) return false;

            // Get entities for note generation
            const fromEntity = this.entities.get(connection.fromEntityId);
            const toEntity = this.entities.get(connection.toEntityId);

            if (!fromEntity || !toEntity) {
                console.error('[EntityManager] Cannot update connection: entities not found');
                return false;
            }

            // All or nothing, as updateEntityForHistory: when another connection has since
            // taken the note's name, memory and the graph yaml are left as they are too.
            const file = connection.filePath ? this.app.vault.getAbstractFileByPath(connection.filePath) : null;
            if (file instanceof TFile && !(await this.isNotePathFreeFor(connection.filePath!, connection.id))) {
                console.warn(`[EntityManager] Not undoing ${connection.id}: ${connection.filePath} belongs to another note`);
                return false;
            }
            if (file instanceof TFile) {
                const content = this.generateConnectionNoteContent(connection, fromEntity, toEntity);
                await this.app.vault.modify(file, content);
            }

            this.putConnection(connection);

            try {
                await this.writeConnectionYamlFile(connection);
            } catch (e) {
                console.warn('[EntityManager] graph-yaml connection write failed:', e);
            }

            return true;
        } catch (error) {
            console.error(`[EntityManager] Failed to update connection:`, error);
            return false;
        }
    }

    /**
     * Generate note content for a connection.
     */
    private generateConnectionNoteContent(
        connection: Connection,
        fromEntity: Entity,
        toEntity: Entity
    ): string {
        // Build frontmatter
        const frontmatter = this.buildConnectionFrontmatter(connection, fromEntity, toEntity);

        // Build note content
        return `---
${frontmatter}
---

# ${stripControls(connection.label || connection.relationship)}

## Connection Details

- **From**: [[${fromEntity.label}]]
- **To**: [[${toEntity.label}]]
- **Type**: ${connection.relationship}

## Properties

${this.buildConnectionPropertiesSection(connection)}

## Notes

<!-- Add additional notes about this connection here -->
`;
    }

    /**
     * Add a relationship to an entity's note.
     * Format: [[Source Entity]] RELATIONSHIP_TYPE [[Target Entity]]
     */
    async addRelationshipToNote(
        fromEntity: Entity,
        toEntity: Entity,
        relationship: string
    ): Promise<void> {
        if (!fromEntity.filePath) return;

        if (!this.assertPathWritable(fromEntity.filePath, 'update entity note')) return;

        const file = this.app.vault.getAbstractFileByPath(fromEntity.filePath);
        if (!(file instanceof TFile)) return;

        const content = await this.app.vault.read(file);

        // Find the Relationships section and add the new relationship
        // Format: [[FilePath|Label]] RELATIONSHIP_TYPE [[FilePath|Label]]
        const fromLink = this.getNoteLink(fromEntity);
        const toLink = this.getNoteLink(toEntity);
        const relationshipLine = `- ${fromLink} ${relationship.toUpperCase()} ${toLink}`;

        const relationshipsMatch = content.match(/(## Relationships\n)([\s\S]*?)((?=\n## )|$)/);
        if (relationshipsMatch) {
            const beforeSection = content.substring(0, relationshipsMatch.index! + relationshipsMatch[1].length);
            const sectionContent = relationshipsMatch[2];
            const afterSection = content.substring(relationshipsMatch.index! + relationshipsMatch[0].length);

            // Check if this exact relationship already exists
            if (!sectionContent.includes(relationshipLine)) {
                const newContent = beforeSection + sectionContent.trimEnd() + '\n' + relationshipLine + '\n' + afterSection;
                await this.app.vault.modify(file, newContent);
            }
        }

        // Also add the incoming relationship to the target entity for better graph connecting
        await this.addIncomingRelationshipToNote(toEntity, fromEntity, relationship);
    }

    /**
     * Add an incoming relationship to an entity's note (where the entity is the target).
     * Format: [[Source Entity]] RELATIONSHIP_TYPE [[This Entity]]
     */
    async addIncomingRelationshipToNote(
        targetEntity: Entity,
        sourceEntity: Entity,
        relationship: string
    ): Promise<void> {
        if (!targetEntity.filePath) return;

        if (!this.assertPathWritable(targetEntity.filePath, 'update entity note')) return;

        const file = this.app.vault.getAbstractFileByPath(targetEntity.filePath);
        if (!(file instanceof TFile)) return;

        const content = await this.app.vault.read(file);

        // Format: [[Source Entity Path|Label]] RELATIONSHIP_TYPE [[This Entity Path|Label]]
        const fromLink = this.getNoteLink(sourceEntity);
        const toLink = this.getNoteLink(targetEntity);
        const relationshipLine = `- ${fromLink} ${relationship.toUpperCase()} ${toLink}`;

        const relationshipsMatch = content.match(/(## Relationships\n)([\s\S]*?)((?=\n## )|$)/);
        if (relationshipsMatch) {
            const beforeSection = content.substring(0, relationshipsMatch.index! + relationshipsMatch[1].length);
            const sectionContent = relationshipsMatch[2];
            const afterSection = content.substring(relationshipsMatch.index! + relationshipsMatch[0].length);

            // Check if this exact relationship already exists
            if (!sectionContent.includes(relationshipLine)) {
                const newContent = beforeSection + sectionContent.trimEnd() + '\n' + relationshipLine + '\n' + afterSection;
                await this.app.vault.modify(file, newContent);
            }
        }
    }

    /**
     * Helper to generate a reliable wikilink to an entity's note.
     * Uses the file path (without .md) to ensure perfect resolution in the graph.
     */
    private getNoteLink(entity: Entity): string {
        if (!entity.filePath) return `[[${entity.label}]]`;
        // Remove .md extension for the wikilink
        const linkPath = entity.filePath.replace(/\.md$/, '');
        return `[[${linkPath}|${entity.label}]]`;
    }

    /**
     * Save a connection as an Obsidian note.
     * Creates a note file in the Connections folder with connection metadata and properties.
     */
    private async saveConnectionAsNote(
        connection: Connection,
        fromEntity: Entity,
        toEntity: Entity
    ): Promise<string> {
        const folderPath = normalizePath(`${this.basePath}/Connections`);

        // Ensure the Connections folder exists
        await this.ensureFolderExists(folderPath);

        // Named from the two labels, which two entities can share: two John Smiths who both
        // work at Acme would otherwise write the same file, and the second connection would
        // replace the first on disk. Claimed like an entity note.
        const filePath = await this.claimNotePath(
            connection,
            folderPath,
            `${fromEntity.label} - ${connection.relationship} - ${toEntity.label}`,
        );

        // Build frontmatter
        const frontmatter = this.buildConnectionFrontmatter(connection, fromEntity, toEntity);

        // Build note content
        const content = `---
${frontmatter}
---

# ${stripControls(connection.label || connection.relationship)}

## Connection Details

- **From**: ${this.getNoteLink(fromEntity)}
- **To**: ${this.getNoteLink(toEntity)}
- **Type**: ${connection.relationship}

## Properties

${this.buildConnectionPropertiesSection(connection)}

## Notes

<!-- Add additional notes about this connection here -->
`;

        // Check if file exists
        const existingFile = this.app.vault.getAbstractFileByPath(filePath);
        if (existingFile instanceof TFile) {
            const pathToCheck = connection.filePath || filePath;
            if (!this.assertPathWritable(pathToCheck, 'update connection note')) {
                throw new Error('Path locked');
            }
            await this.app.vault.modify(existingFile, content);
        } else {
            await this.app.vault.create(filePath, content);
        }

        this.scheduleWaybackForNote(filePath);
        try {
            await this.writeConnectionYamlFile(connection);
        } catch (e) {
            console.warn('[EntityManager] graph-yaml connection write failed:', e);
        }
        return filePath;
    }

    /**
     * Build YAML frontmatter for a connection.
     */
    private buildConnectionFrontmatter(
        connection: Connection,
        fromEntity: Entity,
        toEntity: Entity
    ): string {
        const lines: string[] = [
            yamlScalarLine('id', connection.id),
            `type: connection`,
            yamlScalarLine('relationship', connection.relationship),
            yamlScalarLine('fromEntityId', connection.fromEntityId),
            yamlScalarLine('toEntityId', connection.toEntityId),
            yamlScalarLine('fromEntity', `[[${fromEntity.label}]]`),
            yamlScalarLine('toEntity', `[[${toEntity.label}]]`),
        ];

        lines.push(`schemaFamily: ${yamlPlainOrQuote(connection.schemaFamily ?? 'ftm')}`);

        if (connection.ftmSchema) {
            lines.push(yamlScalarLine('ftmSchema', connection.ftmSchema));
        }

        if (connection.label) {
            lines.push(yamlScalarLine('label', connection.label));
        }

        // Add connection properties to frontmatter
        const propsChunk: Record<string, unknown> = {};
        if (connection.properties) {
            for (const [key, value] of Object.entries(connection.properties)) {
                if (value === undefined || value === null || value === '') continue;
                if (UNSAFE_PROPERTY_KEYS.has(key)) continue;
                if (CONNECTION_FRONTMATTER_KEYS.has(key)) {
                    propsChunk[key] = value;
                    continue;
                }
                lines.push(yamlScalarLine(key, value));
            }
        }

        this.appendPropsChunk(lines, propsChunk);
        this.appendOsintFrontmatter(lines, connection);
        return lines.join('\n');
    }

    /**
     * Build the properties section for a connection note.
     */
    private buildConnectionPropertiesSection(connection: Connection): string {
        if (!connection.properties || Object.keys(connection.properties).length === 0) {
            return '_No additional properties_';
        }

        const lines: string[] = [];

        for (const [key, value] of Object.entries(connection.properties)) {
            if (value !== undefined && value !== null && value !== '') {
                // Format the key nicely (camelCase to Title Case)
                const formattedKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
                lines.push(`- **${formattedKey}**: ${value}`);
            }
        }

        return lines.length > 0 ? lines.join('\n') : '_No additional properties_';
    }

    /**
     * Get a connection by ID.
     */
    getConnection(connectionId: string): Connection | undefined {
        return this.connections.get(connectionId);
    }

    /**
     * Delete a connection and remove it from the note file.
     */
    async deleteConnectionWithNote(connectionId: string): Promise<boolean> {
        const connection = this.connections.get(connectionId);
        if (!connection) return false;

        const fromEntity = this.entities.get(connection.fromEntityId);
        if (fromEntity?.filePath && !this.assertPathWritable(fromEntity.filePath, 'delete connection')) {
            return false;
        }
        if (connection.filePath && !this.assertPathWritable(connection.filePath, 'delete connection')) {
            return false;
        }

        try {
            await this.deleteYamlFileIfExists(this.connectionYamlFilePath(connectionId));
        } catch (e) {
            console.warn('[EntityManager] graph-yaml connection delete failed:', e);
        }

        // Get the source entity to update its note
        if (!fromEntity) {
            return this.dropConnection(connectionId);
        }
        if (fromEntity && fromEntity.filePath) {
            const file = this.app.vault.getAbstractFileByPath(fromEntity.filePath);
            if (file instanceof TFile) {
                try {
                    let content = await this.app.vault.read(file);

                    // Find and remove the relationship line
                    const toEntity = this.entities.get(connection.toEntityId);
                    if (toEntity) {
                        const relationshipLine = `- [[${toEntity.label}]] (${connection.relationship})`;
                        const altRelationshipLine = `- [[${toEntity.filePath?.replace('.md', '')}]] (${connection.relationship})`;

                        // Try to remove the relationship line
                        content = content.replace(new RegExp(`^${this.escapeRegex(relationshipLine)}\\n?`, 'gm'), '');
                        content = content.replace(new RegExp(`^${this.escapeRegex(altRelationshipLine)}\\n?`, 'gm'), '');

                        await this.app.vault.modify(file, content);
                    }
                } catch (error) {
                    console.error(`[EntityManager] Failed to update note for connection deletion:`, error);
                }
            }
        }

        // Remove from connections map
        return this.dropConnection(connectionId);
    }

    /**
     * Escape special regex characters in a string.
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Delete a connection (in-memory only, for backward compatibility).
     */
    deleteConnection(connectionId: string): boolean {
        return this.dropConnection(connectionId);
    }

    /**
     * Restore a connection (for undo operations).
     */
    async restoreConnection(connection: Connection): Promise<boolean> {
        const fromEntity = this.entities.get(connection.fromEntityId);
        const toEntity = this.entities.get(connection.toEntityId);

        if (fromEntity && toEntity) {
            if (!this.assertPathWritable(fromEntity.filePath, 'restore connection')) return false;
            if (!this.assertPathWritable(toEntity.filePath, 'restore connection')) return false;
            if (connection.filePath && !this.assertPathWritable(connection.filePath, 'restore connection')) return false;
        }

        // Add to connections map
        this.putConnection(connection);

        // Update the source entity's note
        if (fromEntity && toEntity) {
            await this.addRelationshipToNote(fromEntity, toEntity, connection.relationship);
        }

        try {
            await this.writeConnectionYamlFile(connection);
        } catch (e) {
            console.warn('[EntityManager] graph-yaml connection write failed:', e);
        }

        return true;
    }

    /**
     * Get all entities.
     */
    getAllEntities(): Entity[] {
        return Array.from(this.entities.values());
    }

    /**
     * Get an entity by ID.
     */
    getEntity(id: string): Entity | undefined {
        return this.entities.get(id);
    }

    /**
     * Get all connections.
     */
    getAllConnections(): Connection[] {
        return Array.from(this.connections.values());
    }

    /**
     * Get the full graph data.
     */
    getGraphData(): { entities: Entity[]; connections: Connection[] } {
        return {
            entities: this.getAllEntities(),
            connections: this.getAllConnections()
        };
    }

    /**
     * Open an entity's note in Obsidian.
     */
    async openEntityNote(entityId: string): Promise<void> {
        const entity = this.entities.get(entityId);
        if (!entity || !entity.filePath) return;

        const file = this.app.vault.getAbstractFileByPath(entity.filePath);
        if (file instanceof TFile) {
            await this.app.workspace.getLeaf().openFile(file);
        }
    }

    // --- FollowTheMoney-style YAML export (`<base>/graph-yaml/`) — synced from Markdown notes ---

    private graphYamlRoot(): string {
        return normalizePath(`${this.basePath}/${GRAPH_YAML_FOLDER_NAME}`);
    }

    private sanitizeGraphYamlTypeSegment(type: string): string {
        const t = String(type).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
        return t.slice(0, 120) || 'unknown';
    }

    private entityYamlFilePath(entity: Entity): string {
        const family = entity.schemaFamily ?? 'ftm';
        const typeSeg = this.sanitizeGraphYamlTypeSegment(String(entity.type));
        return normalizePath(
            `${this.graphYamlRoot()}/entities/${family}/${typeSeg}/${entity.id}.yaml`,
        );
    }

    private connectionYamlFilePath(connectionId: string): string {
        return normalizePath(`${this.graphYamlRoot()}/connections/${connectionId}.yaml`);
    }

    private entityToYamlDocument(entity: Entity): Record<string, unknown> {
        return {
            kind: 'entity',
            id: entity.id,
            type: entity.type,
            label: entity.label,
            properties: entity.properties ?? {},
            ftmSchema: entity.ftmSchema,
            schemaFamily: entity.schemaFamily ?? 'ftm',
            notePath: entity.filePath,
            osint_sources: entity.osint_sources,
            osint_confidence: entity.osint_confidence,
            osint_contradictions: entity.osint_contradictions,
        };
    }

    /** @param entities where the endpoint labels are looked up */
    private connectionToYamlDocument(
        connection: Connection,
        entities: Map<string, Entity> = this.entities,
    ): Record<string, unknown> {
        const fromE = entities.get(connection.fromEntityId);
        const toE = entities.get(connection.toEntityId);
        return {
            kind: 'connection',
            id: connection.id,
            fromEntityId: connection.fromEntityId,
            toEntityId: connection.toEntityId,
            fromLabel: fromE?.label ?? '',
            toLabel: toE?.label ?? '',
            relationship: connection.relationship,
            label: connection.label,
            properties: connection.properties ?? {},
            ftmSchema: connection.ftmSchema,
            schemaFamily: connection.schemaFamily ?? 'ftm',
            notePath: connection.filePath,
            osint_sources: connection.osint_sources,
            osint_confidence: connection.osint_confidence,
            osint_contradictions: connection.osint_contradictions,
        };
    }

    private async ensureParentFolderForVaultFile(filePath: string): Promise<void> {
        const normalized = normalizePath(filePath);
        const lastSlash = normalized.lastIndexOf('/');
        if (lastSlash > 0) {
            await this.ensureFolderExists(normalized.substring(0, lastSlash));
        }
    }

    private async writeEntityYamlFile(entity: Entity): Promise<void> {
        const path = this.entityYamlFilePath(entity);
        await this.ensureParentFolderForVaultFile(path);
        await this.writeYamlDocument(path, this.entityToYamlDocument(entity));
    }

    private async writeConnectionYamlFile(
        connection: Connection,
        entities: Map<string, Entity> = this.entities,
    ): Promise<void> {
        const path = this.connectionYamlFilePath(connection.id);
        await this.ensureFolderExists(normalizePath(`${this.graphYamlRoot()}/connections`));
        await this.writeYamlDocument(path, this.connectionToYamlDocument(connection, entities));
    }

    private async writeYamlDocument(path: string, document: Record<string, unknown>): Promise<void> {
        const header =
            '# OSINT Copilot graph export (FTM-style YAML mirror). The Markdown note is the primary source; this file is auto-synced.\n';
        const content = `${header}${stringifyYaml(document, { lineWidth: 120 })}\n`;
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, content);
        } else {
            await this.app.vault.create(path, content);
        }
        this.graphYamlWritten.set(path, JSON.stringify(document));
    }

    private async deleteYamlFileIfExists(path: string): Promise<void> {
        this.graphYamlWritten.delete(path);
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) {
            await this.app.fileManager.trashFile(f);
        }
    }

    private async collectYamlPathsRecursive(folder: TFolder, out: string[]): Promise<void> {
        for (const child of folder.children) {
            if (child instanceof TFolder) {
                await this.collectYamlPathsRecursive(child, out);
            } else if (child instanceof TFile && child.extension === 'yaml') {
                out.push(child.path);
            }
        }
    }

    /**
     * Remove `.yaml` files under graph-yaml that no longer match in-memory graph (e.g. after type/family moves).
     */
    private async pruneGraphYamlOrphans(): Promise<void> {
        const root = this.graphYamlRoot();
        const entitiesRoot = this.app.vault.getAbstractFileByPath(
            normalizePath(`${root}/entities`),
        );
        if (entitiesRoot instanceof TFolder) {
            const paths: string[] = [];
            await this.collectYamlPathsRecursive(entitiesRoot, paths);
            for (const p of paths) {
                const base = p.split('/').pop() ?? '';
                const id = base.replace(/\.yaml$/i, '');
                if (!this.entities.has(id)) {
                    await this.deleteYamlFileIfExists(p);
                }
            }
        }
        const connRoot = this.app.vault.getAbstractFileByPath(normalizePath(`${root}/connections`));
        if (connRoot instanceof TFolder) {
            for (const child of connRoot.children) {
                if (child instanceof TFile && child.extension === 'yaml') {
                    const id = child.name.replace(/\.yaml$/i, '');
                    if (!this.connections.has(id)) {
                        await this.deleteYamlFileIfExists(child.path);
                    }
                }
            }
        }
    }

    private async syncAllGraphYamlFromMemory(): Promise<void> {
        try {
            await this.ensureFolderExists(this.graphYamlRoot());
            for (const e of this.entities.values()) {
                await this.writeEntityYamlFile(e);
            }
            for (const c of this.connections.values()) {
                await this.writeConnectionYamlFile(c);
            }
            await this.pruneGraphYamlOrphans();
        } catch (err) {
            console.warn('[EntityManager] graph-yaml full sync failed:', err);
        }
    }

    /**
     * The graph-yaml mirror after a routine reload: write the entries that differ from what
     * this class last wrote there (a note changed on disk behind its back, by the editor,
     * the file tree or git; a note path or an endpoint's label a write left out of date),
     * and remove the ones whose entity or connection is gone or has moved. The full sync
     * rewrote every file of the mirror each time, and the views reload after every note
     * save. A file this class never wrote is left to the full sync, which the reload
     * commands and every plugin load run.
     */
    private async syncChangedGraphYaml(current: GraphMaps): Promise<void> {
        const wanted = new Set<string>();
        const stale = (path: string, document: Record<string, unknown>): boolean => {
            wanted.add(path);
            return this.graphYamlWritten.get(path) !== JSON.stringify(document)
                || !(this.app.vault.getAbstractFileByPath(path) instanceof TFile);
        };
        try {
            for (const entity of current.entities.values()) {
                if (stale(this.entityYamlFilePath(entity), this.entityToYamlDocument(entity))) {
                    await this.writeEntityYamlFile(entity);
                }
            }
            for (const connection of current.connections.values()) {
                const document = this.connectionToYamlDocument(connection, current.entities);
                if (stale(this.connectionYamlFilePath(connection.id), document)) {
                    await this.writeConnectionYamlFile(connection, current.entities);
                }
            }
            for (const path of [...this.graphYamlWritten.keys()]) {
                if (!wanted.has(path)) await this.deleteYamlFileIfExists(path);
            }
        } catch (err) {
            console.warn('[EntityManager] graph-yaml sync failed:', err);
        }
    }

    /**
     * Export the full investigation to a formatted JSON string.
     */
    exportToJSON(): string {
        const graphData = this.getGraphData();
        const exportData = {
            metadata: {
                version: "1.0.0",
                export_date: new Date().toISOString(),
                source: "OSINT Copilot",
                total_entities: graphData.entities.length,
                total_connections: graphData.connections.length
            },
            entities: graphData.entities.map(e => ({
                id: e.id,
                type: e.type,
                label: e.label,
                properties: e.properties
            })),
            connections: graphData.connections.map(c => ({
                id: c.id,
                from_entity_id: c.fromEntityId,
                to_entity_id: c.toEntityId,
                relationship: c.relationship,
                properties: c.properties
            }))
        };

        return JSON.stringify(exportData, null, 2);
    }
}

