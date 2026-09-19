/**
 * Applies what the OSINT Copilot browser extension sent to this investigation.
 *
 * Main receives a bundle, checks it and parks it in `<workspace>/.osint-inbox/pending/`
 * (main/osint/inbox). This window then applies it: an entity goes straight into the
 * graph, labelled `via: extension`; a note goes into the page's Sources note. Nothing
 * waits for approval. Instead each applied item is logged, a notice says how many
 * arrived, and the activity dialog can Remove any one of them again.
 *
 * Applying is journalled through `inbox.step`, one step at a time, so a crash anywhere
 * and a re-run adds nothing twice:
 *
 *   entity-plan   the id the entity gets if this item creates it (plannedEntityId),
 *                 chosen and recorded BEFORE the upsert. The item created the entity
 *                 exactly when the entity it landed on has that id. Not "nothing had this
 *                 identifier before": after a crash, the user or the assistant may have
 *                 created an entity with the same identifier, and Remove would delete it.
 *                 An entity made before a planned id was recorded can never have it, so
 *                 without a readable plan the item is taken to have created nothing.
 *   entity        the upsert's outcome. The upsert itself is idempotent: the source
 *                 carries the id `ext_<bundleId>`, and appendOsintSources skips a source
 *                 whose content the entity already has.
 *   place         a capture only, first: the files main copied into OSINTCopilot/Evidence/
 *                 (inbox.placeFiles), each marked created or reused. A record only: every
 *                 attempt asks main again, which is harmless (main finds its own files by
 *                 name and digest) and puts back files a Remove of another capture trashed
 *                 while this one was pending.
 *   sources-note  the page's Sources note, holding this bundle's section between
 *                 `<!-- oc:bundle <id> -->` markers. A section already there is not added
 *                 again, and Remove cuts exactly that section.
 *
 *   applied       what the item added (ExtensionActivityOutcome), which is what Remove
 *                 takes back. Then `finish(done)`.
 *
 * The activity log is these journals: main lists the done and removed bundles with them
 * (inbox.listApplied), and Remove reads the item fresh from there. Not the plugin's
 * settings file: every window on the investigation rewrites that whole from its own
 * in-memory copy, so a second window would write its stale log over the first's, and
 * Remove is the only undo.
 *
 * Page text in the Sources note is written inert: inline code spans and fenced blocks
 * whose fence is longer than any backtick run in the text, so a title or value such as
 * `![](https://tracker.example/x.gif)` or `![[Other note]]` is shown, never embedded or
 * fetched when the note is opened.
 *
 * One window per investigation holds the inbox lease; the others leave it alone, and try
 * again when the inbox changes and once a minute, in case the holder has gone.
 */
import { TFile, TFolder, normalizePath, type App } from 'obsidian';
import type { EntityManager } from './entity-manager';
import { yamlScalarLine } from './entity-manager';
import { identifierKey, normalizePlatform, usernameIdentifierKey } from './entity-identifiers';
import { normalizeSourceUrl } from './osint-confidence-engine';
import { ensureFolderExists } from '../utils/vault-bootstrap-fs';
import { slugify } from '../utils/slug';
import { OSINT_COPILOT_VAULT_ROOT } from '../constants/vault-layout';
import { generateId, isGeneratedId, type Entity, type OsintSourceInput } from '../entities/types';
import type { InboxAppliedBundle, InboxBundle, InboxHost, InboxPlacedFile, InboxPlacement } from '../host/types';
import type { EntityPayload, HighlightAnnotation, ManifestPage } from '../../main/osint/extension/protocol';
import {
    captureName, captureWarnings, evidenceSourcesFor, evidenceTargetFor, normalizePlacedFiles, normalizePlacement,
} from '../inbox/capture-to-entity';

/** Folder of the per-page notes. Reserved: EntityManager never parses it as entities. */
export const SOURCES_FOLDER = normalizePath(`${OSINT_COPILOT_VAULT_ROOT}/Sources`);

export const EXTENSION_RATIONALE = 'Sent from the OSINT Copilot browser extension';

// ------------------------------------------------------------------ activity log

export interface ExtensionActivityOutcome {
    /** The entity the item landed on, created or merged into. Null for a note. */
    entityId: string | null;
    /** Its label when applied, for "merged into existing <label>". */
    entityLabel: string | null;
    /** True when this item created the entity, so Remove deletes it. */
    created: boolean;
    /** Sources this item added to the entity; Remove drops exactly these. */
    addedSourceIds: string[];
    sourcesNotePath: string | null;
    /**
     * A capture's files in OSINTCopilot/Evidence/. Remove trashes the ones this item
     * created, unless something still in the investigation relies on them.
     */
    placedFiles: InboxPlacedFile[];
}

export interface ExtensionActivityItem {
    bundleId: string;
    kind: 'entity' | 'note' | 'capture' | 'highlight';
    /** A highlight only: its annotation id, the same across the highlight's edits. */
    annotationId?: string;
    /** For an entity: the extension's kind (email, phone, username, ...). */
    entityKind?: string;
    /** The value, or the note's first line, for the list. */
    summary: string;
    url: string;
    title: string;
    /** Main's clock, when the bundle arrived. */
    receivedAt: string;
    appliedAt: string;
    outcome: ExtensionActivityOutcome;
    removed: boolean;
    removedAt?: string;
    /** A capture only: no readable text could be made from the archive. */
    derivationFailed?: boolean;
    /** A capture only: the archive's own address is not the page's, or is unknown. */
    urlMismatch?: boolean;
    /** A capture only: that address, when the archive records one. */
    contentLocation?: string | null;
}

/** The journal step that records what an applied item added. */
export const APPLIED_STEP = 'applied';
/** The step main writes when Remove moves a bundle to removed/. */
export const REMOVED_STEP = 'removed';

const isString = (v: unknown): v is string => typeof v === 'string';

/** An `applied` step's data read back, keeping only what this code writes. */
export function normalizeActivityOutcome(raw: unknown): ExtensionActivityOutcome | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    return {
        entityId: isString(o.entityId) ? o.entityId : null,
        entityLabel: isString(o.entityLabel) ? o.entityLabel : null,
        created: o.created === true,
        addedSourceIds: Array.isArray(o.addedSourceIds) ? o.addedSourceIds.filter(isString) : [],
        sourcesNotePath: isString(o.sourcesNotePath) ? o.sourcesNotePath : null,
        placedFiles: normalizePlacedFiles(o.placedFiles),
    };
}

function noteSummary(text: string): string {
    return cleanNoteText(text).split('\n').find((l) => l.trim())?.trim().slice(0, 140) ?? '';
}

/**
 * One activity entry from an applied bundle and its journal, or null for a bundle this
 * code did not finish applying (no `applied` step).
 */
export function activityItemFor(bundle: InboxAppliedBundle): ExtensionActivityItem | null {
    const { manifest, server, state, bundleId } = bundle;
    const steps = state?.steps ?? [];
    const applied = steps.find((s) => s.step === APPLIED_STEP);
    const outcome = normalizeActivityOutcome(applied?.data);
    if (!applied || !outcome) return null;
    // What Remove acts on: "created" only when the plan proves it (see planProvesCreated).
    if (outcome.created && !planProvesCreated(steps.find((s) => s.step === 'entity-plan')?.data, outcome.entityId)) {
        outcome.created = false;
    }
    let kind: ExtensionActivityItem['kind'];
    let summary: string;
    let entityKind: string | undefined;
    let annotationId: string | undefined;
    let captureFlags: Pick<ExtensionActivityItem, 'derivationFailed' | 'urlMismatch' | 'contentLocation'> = {};
    if (manifest.kind === 'capture') {
        kind = 'capture';
        const derived = bundle.derived;
        summary = derived ? captureName({ page: manifest.page, derived }) : manifest.page.title || manifest.page.url;
        if (derived) {
            captureFlags = {
                derivationFailed: derived.status === 'failed',
                urlMismatch: derived.urlMismatch,
                contentLocation: derived.contentLocation,
            };
        }
    } else if (manifest.kind === 'entity') {
        kind = 'entity';
        entityKind = manifest.entity.kind;
        summary = manifest.entity.value;
    } else if (manifest.kind === 'note') {
        kind = 'note';
        summary = noteSummary(manifest.note.text);
    } else if (manifest.kind === 'highlight' || manifest.kind === 'highlight.update') {
        // A highlight is listed by the bundle that put it in the investigation: the one that
        // filed it first (its create, or an edit that got here first), or an edit that
        // brought it back after a Remove, so that one can be removed too. Other edits, and a
        // create that a newer change or a delete overrode, put nothing in, and have nothing
        // of their own to show or take back.
        const did = (steps.find((s) => s.step === 'highlight')?.data as { outcome?: unknown } | undefined)?.outcome;
        // Before outcomes were recorded, the create was the item.
        const listed = did === undefined ? manifest.kind === 'highlight' : PUTS_HIGHLIGHT_IN.includes(did);
        if (!listed) return null;
        kind = 'highlight';
        summary = oneLine(displayQuote(manifest.highlight.annotation.target.selector[0].exact)).slice(0, 140);
        annotationId = manifest.highlight.annotation.id;
    } else {
        // highlight.delete: an edit of a highlight already in the log.
        return null;
    }
    const removed = bundle.where === 'removed';
    const removedAt = removed ? steps.find((s) => s.step === REMOVED_STEP)?.at : undefined;
    return {
        bundleId,
        kind,
        ...(entityKind ? { entityKind } : {}),
        ...(annotationId ? { annotationId } : {}),
        summary,
        url: manifest.page.url,
        title: manifest.page.title,
        receivedAt: server.receivedAt,
        appliedAt: applied.at,
        outcome,
        removed,
        ...(removedAt ? { removedAt } : {}),
        ...captureFlags,
    };
}

/** The investigation's activity log, oldest first, read fresh from main. */
export async function readExtensionActivity(inbox: InboxHost): Promise<ExtensionActivityItem[]> {
    const bundles = await inbox.listApplied();
    return bundles.map(activityItemFor).filter((i): i is ExtensionActivityItem => i !== null);
}

// ------------------------------------------------------------------ entity mapping

export interface EntityTarget {
    /** Passed to upsertEntityFromExternal: an FTM schema, or a legacy type. */
    schema: string;
    properties: Record<string, unknown>;
    identifierKey: string;
}

/**
 * The schema each extension kind is stored under: the one the app's own AI extraction
 * produces for that kind, so an address the assistant extracted and the same address
 * sent from the browser are one entity of one type. @@create_entity (orchestration-
 * service.ts) creates `isFTMSchema(type) ? createFTMEntity : createEntity`, and the
 * extraction prompt (data/vault-prompt-defaults.ts) names the types:
 *
 *   email     Email {address}          the prompt's "Email (address)". OIDSF Email is a
 *                                      message schema, but it is what extraction writes,
 *                                      and identifier matching already covers
 *                                      EmailAddr/LegalEntity notes of the same address.
 *   phone     Phone {number}           the prompt's "Phone (number)". Not an FTM schema,
 *                                      so a legacy note (ftmSchema LegalEntity), as there.
 *   username  Username {username, platform}
 *                                      the prompt's "Username (username)"; legacy, stored
 *                                      as UserAccount. `platform` keeps a GitHub "john"
 *                                      and a Twitter "john" apart.
 *   domain    Domain {name}            no prompt example: the FTM schema, whose required
 *                                      property is name.
 *   url       Url {value}              likewise, the STIX observable schemas;
 *   ip        Ipv4Addr / Ipv6Addr {value}
 *   wallet    CryptoWallet {publicKey, currencySymbol}
 *                                      currencySymbol is BTC or ETH. An "other" chain is
 *                                      not a ticker, so it is left unset, which is also
 *                                      what the wallet identifier key reads as "unknown".
 *
 * Returns null for anything main should not have let through.
 */
export function entityTargetFor(entity: EntityPayload, pageUrl: string): EntityTarget | null {
    const value = entity.value;
    let schema: string;
    let properties: Record<string, unknown>;
    let key: string | null;
    switch (entity.kind) {
        case 'email':
            schema = 'Email';
            properties = { address: value };
            key = identifierKey('email', value);
            break;
        case 'phone':
            schema = 'Phone';
            properties = { number: value };
            key = identifierKey('phone', value);
            break;
        case 'username': {
            // The extension names the platform when it knows it; otherwise the page it
            // was seen on is the platform (a name on github.com is a GitHub account).
            let host = '';
            try { host = new URL(pageUrl).hostname; } catch { /* no platform then */ }
            const platform = normalizePlatform(entity.platform) ?? normalizePlatform(host);
            schema = 'Username';
            properties = platform ? { username: value, platform } : { username: value };
            key = usernameIdentifierKey(value, platform);
            break;
        }
        case 'domain':
            schema = 'Domain';
            properties = { name: value };
            key = identifierKey('domain', value);
            break;
        case 'url':
            schema = 'Url';
            properties = { value };
            key = identifierKey('url', value);
            break;
        case 'ip':
            schema = value.includes(':') ? 'Ipv6Addr' : 'Ipv4Addr';
            properties = { value };
            key = identifierKey('ip', value);
            break;
        case 'wallet': {
            const symbol = entity.chain === 'btc' ? 'BTC' : entity.chain === 'eth' ? 'ETH' : '';
            schema = 'CryptoWallet';
            properties = symbol ? { publicKey: value, currencySymbol: symbol } : { publicKey: value };
            key = identifierKey('wallet', `${symbol}:${value}`);
            break;
        }
        default:
            return null;
    }
    return key ? { schema, properties, identifierKey: key } : null;
}

const KIND_LABELS: Record<string, string> = {
    email: 'Email',
    phone: 'Phone',
    username: 'Username',
    domain: 'Domain',
    url: 'URL',
    ip: 'IP address',
    wallet: 'Wallet',
};

export function entityKindLabel(entity: Pick<EntityPayload, 'kind' | 'chain'>): string {
    const base = KIND_LABELS[entity.kind] ?? entity.kind;
    return entity.kind === 'wallet' && entity.chain ? `${base} (${entity.chain.toUpperCase()})` : base;
}

// ------------------------------------------------------------------ Sources notes

/** slugify, after folding accents (é to e). Empty when nothing is left. */
export function sourceSlug(text: string): string {
    return slugify(text.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
}

async function sha256Hex(text: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One line of page text in a heading or list item: controls become spaces. */
function oneLine(text: string): string {
    return neutraliseMarkers(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim());
}

/**
 * Note text keeps its newlines and loses every other control character (and CR, and the
 * Unicode line separators some renderers break on).
 */
export function cleanNoteText(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '')
        .trim();
}

/**
 * Page text never contains a working section marker: an HTML comment opener or closer
 * from the page is written as its entity form, so Remove cannot be made to cut, or a
 * re-run to skip, anything but the section this code wrote.
 */
function neutraliseMarkers(text: string): string {
    return text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

function longestBacktickRun(text: string): number {
    let longest = 0;
    for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
    return longest;
}

/**
 * Page text on one line, as an inline code span. Nothing inside a code span is parsed, so
 * `![](url)`, `![[note]]`, `!https://...`, a raw URL alone on its line, and HTML all stay
 * text: opening the note fetches and transcludes nothing. The fence is one backtick longer
 * than any run in the text, so the text cannot close it early, and a leading or trailing
 * backtick is padded away from the fence it would otherwise join.
 */
export function inlineLiteral(text: string): string {
    const line = oneLine(text);
    if (!line) return '';
    const fence = '`'.repeat(longestBacktickRun(line) + 1);
    const pad = line.startsWith('`') || line.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${line}${pad}${fence}`;
}

/**
 * Page text over several lines, as a fenced code block: shown as written, parsed as
 * nothing. The block ends only at a line of backticks at least as long as its opening
 * fence, and no line of the text can be one, because the fence is longer than any run
 * in it.
 */
export function blockLiteral(text: string): string {
    const body = neutraliseMarkers(text);
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
    return `${fence}\n${body}\n${fence}`;
}

/**
 * A wikilink to an entity note, but only when its path cannot break out of the link: a
 * filename may hold `[`, `]` and `#` (sanitizeFilename keeps them), and `a]]![[b` would
 * close the link and embed `b`. The display text is the label without link syntax; one
 * that would still read as a raw URL shows the kind instead, because the parser finds
 * raw links inside a link's text too.
 */
function entityLink(filePath: string | undefined, label: string, kind: string): string {
    if (!filePath || /[[\]|#^]/.test(filePath)) return inlineLiteral(label) || kind;
    const clean = oneLine(label).replace(/[[\]|<>]/g, '');
    const display = clean && !clean.includes('://') ? clean : kind;
    return `[[${filePath.replace(/\.md$/, '')}|${display}]]`;
}

const PLACED_ROLE_LABELS: Record<InboxPlacedFile['role'], string> = {
    archive: 'Archive (MHTML)',
    fullpage: 'Full-page screenshot',
    viewport: 'What was on screen',
    pdf: 'Original PDF',
    markdown: 'Page text',
};

/**
 * One placed file as a list item. The path is main's own (`[a-z0-9-]`, a digest, a fixed
 * extension, checked by normalizePlacement), so it can be a link; a link, not an embed,
 * so nothing is loaded until it is followed.
 */
function placedFileLine(file: InboxPlacedFile): string {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    const reused = file.created ? '' : ' (already in the investigation from an identical capture)';
    return `- ${PLACED_ROLE_LABELS[file.role]}: [[${file.path}|${name}]], sha256 \`${file.sha256}\`${reused}`;
}

export const sectionOpen = (bundleId: string) => `<!-- oc:bundle ${bundleId} -->`;
export const sectionClose = (bundleId: string) => `<!-- /oc:bundle ${bundleId} -->`;

/**
 * Where this bundle's section starts, or -1. Markers count only on a line of their own:
 * the page title in the front matter can hold the same characters inside its quoted
 * value, and must not read as a section.
 */
function sectionStart(text: string, bundleId: string): number {
    const at = text.indexOf(`\n${sectionOpen(bundleId)}\n`);
    return at < 0 ? -1 : at + 1;
}

export function hasSection(text: string, bundleId: string): boolean {
    return sectionStart(text, bundleId) >= 0;
}

/** The note text with this bundle's section cut out, or null when it has none. */
export function cutSection(text: string, bundleId: string): string | null {
    const close = `\n${sectionClose(bundleId)}`;
    const start = sectionStart(text, bundleId);
    if (start < 0) return null;
    const closeAt = text.indexOf(close, start);
    if (closeAt < 0) return null;
    const before = text.slice(0, start);
    const after = text.slice(closeAt + close.length);
    return after.trim() === ''
        ? before.replace(/\n+$/, '\n')
        : before.replace(/\n+$/, '\n\n') + after.replace(/^\n+/, '');
}

/**
 * The note text with this section's body replaced, or null when it has no such section.
 * A highlight keeps one section across its edits, so an edit rewrites it in place.
 */
export function replaceSection(text: string, key: string, body: string): string | null {
    const close = `\n${sectionClose(key)}`;
    const start = sectionStart(text, key);
    if (start < 0) return null;
    const closeAt = text.indexOf(close, start);
    if (closeAt < 0) return null;
    return `${text.slice(0, start)}${sectionOpen(key)}\n${body}${text.slice(closeAt)}`;
}

// ------------------------------------------------------------------ highlights

/**
 * A highlight's quote for reading, not for matching: it keeps its line breaks and loses
 * control characters and the bidi embeddings, overrides and isolates, which would show
 * the text reordered. The vault's JSON record keeps the quote exactly as the page had it.
 */
export function displayQuote(exact: string): string {
    return cleanNoteText(exact).replace(/[‪-‮⁦-⁩]/g, '');
}

/**
 * One highlight in the sidecar. `section` is the key of its Sources-note section: the
 * bundle that first filed it, kept across edits so an edit rewrites that one section.
 * A deleted highlight stays as a tombstone, so a create or edit that arrives late (the
 * extension retries out of order) cannot bring it back; only a newer `modified` wins.
 */
export interface SidecarHighlight {
    annotation?: HighlightAnnotation;
    section: string | null;
    /** The annotation's own modified time, which orders its edits. */
    modified: string;
    /** When the app first received it, shown in the note. */
    receivedAt?: string;
    deleted: boolean;
}

export interface HighlightSidecar {
    version: 1;
    normalised_url: string;
    highlights: Record<string, SidecarHighlight>;
}

/**
 * `<note>.annotations.json` beside the page's Sources note: every highlight on the page
 * with its full selectors, so the investigation keeps what it needs to find each one
 * again even if the browser's copy is lost. JSON, not front matter: the quote is page
 * text and stays exactly as the page had it.
 */
export function sidecarPathFor(notePath: string): string {
    return notePath.replace(/\.md$/, '.annotations.json');
}

/**
 * A sidecar read back, or null when it is not one this code wrote. One entry that does not
 * read (a hand edit, a bad merge) is dropped, not the whole file: the others are still the
 * record of their highlights, and without them an edit would file a second section and
 * leave the first where Remove cannot find it.
 */
export function parseSidecar(raw: string): HighlightSidecar | null {
    let v: unknown;
    try {
        v = JSON.parse(raw);
    } catch {
        return null;
    }
    const o = v as Record<string, unknown>;
    if (!o || typeof o !== 'object' || o.version !== 1 || !isString(o.normalised_url)) return null;
    const h = o.highlights;
    if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
    const highlights: Record<string, SidecarHighlight> = {};
    for (const [id, e] of Object.entries(h as Record<string, unknown>)) {
        const r = e as Record<string, unknown>;
        if (!r || typeof r !== 'object' || !isString(r.modified) || Number.isNaN(Date.parse(r.modified)) || typeof r.deleted !== 'boolean') continue;
        highlights[id] = {
            ...(r.annotation && typeof r.annotation === 'object' ? { annotation: r.annotation as HighlightAnnotation } : {}),
            section: isString(r.section) ? r.section : null,
            modified: r.modified,
            ...(isString(r.receivedAt) ? { receivedAt: r.receivedAt } : {}),
            deleted: r.deleted,
        };
    }
    return { version: 1, normalised_url: o.normalised_url, highlights };
}

/** Whether an edit stamped `incoming` should replace what the sidecar holds for it. */
export function isNewer(incoming: string, held: SidecarHighlight | undefined): boolean {
    if (!held) return true;
    const a = Date.parse(incoming);
    const b = Date.parse(held.modified);
    // A tombstone wins a tie: a delete and a late edit stamped the same instant stay deleted.
    return held.deleted ? a > b : a >= b;
}

function highlightSection(annotation: HighlightAnnotation, receivedAt: string, editedAt: string | null): string {
    const lines = [
        '### Highlight',
        `Received ${oneLine(receivedAt)}.${editedAt ? ` Edited ${oneLine(editedAt)}.` : ''}`,
        '',
        blockLiteral(displayQuote(annotation.target.selector[0].exact)),
    ];
    const note = annotation.body?.value;
    if (note) lines.push('', 'Note:', '', blockLiteral(cleanNoteText(note)));
    return lines.join('\n');
}

// ------------------------------------------------------------------ the service

type EntityPlan = { plannedEntityId: string };
/** What a highlight bundle did, as its `highlight` journal step records it. */
type HighlightStep = { path: string; outcome?: HighlightOutcome };
/**
 * created: the first time this highlight is filed (by its create, or by an edit that got
 * here first). revived: an edit newer than a tombstone put it back. edited: it was there,
 * and changed. unchanged: a newer change or a delete overrides this one.
 */
type HighlightOutcome = 'created' | 'revived' | 'edited' | 'unchanged';
/** The outcomes that put a highlight into the investigation: announced, listed, removable. */
const PUTS_HIGHLIGHT_IN: readonly unknown[] = ['created', 'revived'];
type EntityStep = { entityId: string; created: boolean; label: string; addedSourceIds: string[] };

/**
 * A plan this code can rely on. One from before planned ids (`existingEntityId` only), or
 * one that does not read back, is not: the apply records a new plan instead.
 */
function isEntityPlan(v: unknown): v is EntityPlan {
    return !!v && typeof v === 'object' && isGeneratedId((v as Record<string, unknown>).plannedEntityId);
}
function isEntityStep(v: unknown): v is EntityStep {
    const o = v as Record<string, unknown> | null;
    return !!o && typeof o === 'object' && isString(o.entityId) && Array.isArray(o.addedSourceIds);
}

/**
 * Whether a journal proves the item created `entityId`: its plan names that very id.
 * A recorded `created: true` alone does not. Code from before planned ids wrote it when
 * nothing had the identifier beforehand, which an entity the investigator or the
 * assistant made in the meantime also satisfies, and Remove would delete theirs.
 */
function planProvesCreated(plan: unknown, entityId: string | null): boolean {
    return entityId !== null && isEntityPlan(plan) && plan.plannedEntityId === entityId;
}

export interface InboxServiceDeps {
    app: App;
    entityManager: EntityManager;
    inbox: InboxHost;
    /**
     * The investigation's "Allow Wayback lookups for items from the extension", read when
     * each item is applied. The plugin reads it from disk, not from this window's copy of
     * the settings, so a change made in another window counts.
     */
    allowWayback(): boolean | Promise<boolean>;
    /**
     * Called once per pass that settled anything: how many items it applied, and how many
     * it had to drop because this build cannot map them (the extension had reported those
     * accepted, so the investigator is told).
     */
    notify(applied: number, dropped: number): void;
}

/**
 * How often a window told the lease is held asks for it again. Change notices alone would
 * leave items that were already waiting when the holder closed pending until the next one
 * arrives; once a minute is soon enough for those and costs one IPC call.
 */
export const LEASE_RETRY_MS = 60_000;

export class InboxService {
    private held = false;
    private retryTimer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;
    private unsubscribe: (() => void) | null = null;
    private claiming: Promise<boolean> | null = null;
    private toldHeld = false;
    /** Passes and removals run one at a time: both rewrite the same Sources notes. */
    private queue: Promise<unknown> = Promise.resolve();
    private pendingPass: Promise<void> | null = null;

    constructor(private readonly deps: InboxServiceDeps) {}

    /** Whether this window holds the lease and applies bundles. */
    get active(): boolean {
        return this.held && !this.stopped;
    }

    /**
     * Takes the lease and applies whatever is pending. Resolves false, doing nothing more,
     * when another window on this investigation already applies its inbox. This window
     * still listens, and asks again every LEASE_RETRY_MS: when the lease is free (the
     * holder closed, or its entity store never loaded), it takes over, so nothing sits in
     * pending/ unseen.
     */
    async start(): Promise<boolean> {
        if (this.stopped) return false;
        if (!this.unsubscribe) {
            this.unsubscribe = this.deps.inbox.onChanged(() => {
                if (this.held) void this.processPending();
                else void this.claim();
            });
        }
        return this.claim();
    }

    private claim(): Promise<boolean> {
        if (this.held) return Promise.resolve(true);
        if (this.claiming) return this.claiming;
        const attempt = (async () => {
            let result;
            try {
                result = await this.deps.inbox.claim();
            } catch (e) {
                console.debug('[osint] browser extension inbox unavailable:', e instanceof Error ? e.message : e);
                // Main's inbox may not be ready yet (its handlers wait on the extension
                // channel's setup). Without asking again, this window would apply nothing
                // until the next bundle arrived, however long that is.
                this.retryClaim();
                return false;
            }
            if (this.stopped) {
                // Stopped while the claim was in flight: a lease granted now would stay
                // with this window, and no other could take it while this one is open.
                if (result.ok) await this.deps.inbox.release().catch(() => undefined);
                return false;
            }
            if (!result.ok) {
                this.retryClaim();
                if (!this.toldHeld) {
                    this.toldHeld = true;
                    console.debug('[osint] another window applies this investigation\'s browser extension inbox; this one will not.');
                }
                return false;
            }
            this.held = true;
            this.stopRetrying();
            await this.processPending();
            return true;
        })();
        this.claiming = attempt;
        void attempt.finally(() => { if (this.claiming === attempt) this.claiming = null; });
        return attempt;
    }

    /** Asks for the lease again every LEASE_RETRY_MS, until held or stopped. */
    private retryClaim(): void {
        if (this.retryTimer || this.stopped) return;
        this.retryTimer = setInterval(() => {
            if (!this.held && !this.stopped) void this.claim();
        }, LEASE_RETRY_MS);
    }

    private stopRetrying(): void {
        if (this.retryTimer) clearInterval(this.retryTimer);
        this.retryTimer = null;
    }

    /** Unsubscribes, stops asking for the lease, lets a running pass finish, and gives the lease back. */
    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.stopRetrying();
        this.unsubscribe?.();
        this.unsubscribe = null;
        await this.claiming?.catch(() => undefined);
        await this.queue.catch(() => undefined);
        if (this.held) {
            this.held = false;
            await this.deps.inbox.release().catch(() => undefined);
        }
    }

    /**
     * Applies every pending bundle. Calls made while a pass is waiting to start share it;
     * one made during a pass queues exactly one more, which sees what arrived meanwhile.
     */
    processPending(): Promise<void> {
        if (this.pendingPass) return this.pendingPass;
        const pass = this.enqueue(async () => {
            this.pendingPass = null;
            await this.pass();
        });
        this.pendingPass = pass;
        return pass;
    }

    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const next = this.queue.then(task, task);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private async pass(): Promise<void> {
        if (!this.active) return;
        let bundles: InboxBundle[];
        try {
            bundles = await this.deps.inbox.list();
        } catch (e) {
            console.warn('[osint] could not list the browser extension inbox:', e);
            return;
        }
        let applied = 0;
        let dropped = 0;
        for (const bundle of bundles) {
            if (!this.active) break;
            try {
                const result = await this.apply(bundle);
                // An edit or delete of a highlight is applied quietly: it is not an item
                // added, and the investigator made it in the browser a moment ago.
                if (result === 'done') applied++;
                else if (result === 'rejected') dropped++;
            } catch (e) {
                // Left pending, to be tried again on the next change or the next start.
                console.warn(`[osint] could not apply browser extension item ${bundle.bundleId}:`, e);
            }
        }
        if (applied > 0 || dropped > 0) this.deps.notify(applied, dropped);
    }

    /** Applies one bundle, resuming from its journal. */
    private async apply(bundle: InboxBundle): Promise<'done' | 'edited' | 'rejected' | 'held'> {
        const { bundleId, manifest, server } = bundle;
        // Main lists a capture only once it is derived; one without derived.json is still
        // being derived, and is left pending for the pass that sees it done.
        if (manifest.kind === 'capture' && !bundle.derived) return 'held';
        const journal = new Map((bundle.state?.steps ?? []).map((s) => [s.step, s.data]));
        const step = async (name: string, data: unknown) => {
            await this.deps.inbox.step(bundleId, name, data);
            journal.set(name, data);
        };
        const reject = async (why: string) => {
            console.warn(`[osint] browser extension item ${bundleId} was dropped: ${why}`);
            await this.deps.inbox.finish(bundleId, 'rejected');
            return 'rejected' as const;
        };

        let outcome: ExtensionActivityOutcome;
        let section: string;
        const received = `Received ${oneLine(server.receivedAt)}`;

        if (manifest.kind === 'entity') {
            const target = entityTargetFor(manifest.entity, manifest.page.url);
            if (!target) return reject(`no entity type for a ${manifest.entity.kind}`);
            const done = await this.upsertJournalled(journal, step, target, async () => [await this.sourceFor(bundle, manifest.entity.context)], server.receivedAt);
            const rec = done;
            const entity = this.deps.entityManager.getEntity(rec.entityId);
            const kind = entityKindLabel(manifest.entity);
            const lines = [
                `### ${kind}: ${inlineLiteral(manifest.entity.value)}`,
                `${received}. ${rec.created ? 'New entity' : 'Merged into existing entity'}: ${entityLink(entity?.filePath, entity?.label ?? rec.label, kind)}`,
            ];
            if (manifest.entity.context) lines.push('', blockLiteral(oneLine(manifest.entity.context)));
            section = lines.join('\n');
            outcome = {
                entityId: rec.entityId,
                entityLabel: entity?.label ?? rec.label,
                created: rec.created,
                addedSourceIds: rec.addedSourceIds,
                sourcesNotePath: null,
                placedFiles: [],
            };
        } else if (manifest.kind === 'note') {
            section = [`### Note`, `${received}.`, '', blockLiteral(cleanNoteText(manifest.note.text))].join('\n');
            outcome = { entityId: null, entityLabel: null, created: false, addedSourceIds: [], sourcesNotePath: null, placedFiles: [] };
        } else if (manifest.kind === 'capture') {
            const derived = bundle.derived!;
            // Asked of main on every attempt, never taken from the journal: a placement
            // that reused another capture's files may be journaled while this capture stays
            // pending, and a Remove of that other capture in the meantime trashes them.
            // Placing again finds the files still there (same answer), or places them anew
            // as this capture's own. Main re-checks every MAC and digest first; a refusal
            // throws and the capture stays pending.
            const placement = normalizePlacement(await this.deps.inbox.placeFiles(bundleId), bundleId);
            if (!placement) throw new Error('main placed no archive');
            await step('place', placement);
            const facts = { page: manifest.page, derived, placement, receivedAt: server.receivedAt };
            const target = evidenceTargetFor(facts);
            if (!target) throw new Error('the placed archive has no usable digest');
            const rec = await this.upsertJournalled(journal, step, target, async () => evidenceSourcesFor(facts, {
                bundleId, clientId: server.clientId, allowWayback: await this.deps.allowWayback(),
            }), server.receivedAt);
            const entity = this.deps.entityManager.getEntity(rec.entityId);
            const name = captureName(facts);
            section = [
                `### Capture: ${inlineLiteral(name) || 'Untitled page'}`,
                `${received}. ${rec.created ? 'New evidence' : 'Merged into existing evidence'}: ${entityLink(entity?.filePath, entity?.label ?? rec.label, 'Evidence')}`,
                ...captureWarnings(facts).map((w) => `Warning: ${inlineLiteral(w)}`),
                '',
                ...placement.files.map(placedFileLine),
            ].join('\n');
            outcome = {
                entityId: rec.entityId,
                entityLabel: entity?.label ?? rec.label,
                created: rec.created,
                addedSourceIds: rec.addedSourceIds,
                sourcesNotePath: null,
                placedFiles: placement.files,
            };
        } else if (manifest.kind === 'highlight' || manifest.kind === 'highlight.update') {
            let done = journal.get('highlight') as HighlightStep | undefined;
            if (!done || !isString(done.path)) {
                done = await this.upsertHighlight(manifest.page, manifest.highlight.annotation, bundleId, server.receivedAt);
                await step('highlight', done);
            }
            outcome = { entityId: null, entityLabel: null, created: false, addedSourceIds: [], sourcesNotePath: done.path, placedFiles: [] };
            if (!journal.has(APPLIED_STEP)) await step(APPLIED_STEP, outcome);
            await this.deps.inbox.finish(bundleId, 'done');
            // Announced (and listed, see activityItemFor) only when it put a highlight in
            // the investigation: filed it first -- a create, or an edit that got here before
            // its create -- or brought it back after a Remove. An edit of one already there,
            // or anything a newer change or a delete overrides, is applied quietly.
            // A journal from before outcomes were recorded: a create counts as one.
            const putIn = done.outcome === undefined ? manifest.kind === 'highlight' : PUTS_HIGHLIGHT_IN.includes(done.outcome);
            return putIn ? 'done' : 'edited';
        } else if (manifest.kind === 'highlight.delete') {
            let done = journal.get('highlight') as { path?: unknown } | undefined;
            if (!done || !isString(done.path)) {
                done = { path: await this.deleteHighlight(manifest.page, manifest.highlight.annotationId, manifest.highlight.modified) };
                await step('highlight', done);
            }
            outcome = { entityId: null, entityLabel: null, created: false, addedSourceIds: [], sourcesNotePath: done.path as string, placedFiles: [] };
            if (!journal.has(APPLIED_STEP)) await step(APPLIED_STEP, outcome);
            await this.deps.inbox.finish(bundleId, 'done');
            return 'edited';
        } else {
            // A kind from a later protocol version: main rejects them, so this is a guard.
            return reject('a kind this version does not know');
        }

        let noteStep = journal.get('sources-note') as { path?: unknown } | undefined;
        if (!noteStep || !isString(noteStep.path)) {
            const path = await this.appendSection(manifest.page, bundleId, section);
            noteStep = { path };
            await step('sources-note', noteStep);
        }
        outcome.sourcesNotePath = noteStep.path as string;

        // The activity entry: in the bundle's own journal, where Remove reads it back.
        // Recorded again after a crash between this and finish, it merges into itself.
        if (!journal.has(APPLIED_STEP)) await step(APPLIED_STEP, outcome);
        await this.deps.inbox.finish(bundleId, 'done');
        return 'done';
    }

    /**
     * The entity step, journalled: plan an id, upsert, record what happened. Shared by
     * entities and captures, so both resume the same way after a crash (see the header).
     */
    private async upsertJournalled(
        journal: Map<string, unknown>,
        step: (name: string, data: unknown) => Promise<void>,
        target: { schema: string; properties: Record<string, unknown>; identifierKey: string },
        sources: () => Promise<OsintSourceInput[]>,
        receivedAt: string,
    ): Promise<EntityStep> {
        const done = journal.get('entity');
        let plan = journal.get('entity-plan');
        if (isEntityStep(done)) {
            // A step this code wrote always agrees with its plan; an older one may not.
            return done.created && !planProvesCreated(plan, done.entityId) ? { ...done, created: false } : done;
        }
        if (!isEntityPlan(plan)) {
            // Recorded before anything can be created with it (see the header).
            plan = { plannedEntityId: generateId() };
            await step('entity-plan', plan);
        }
        const plannedEntityId = (plan as EntityPlan).plannedEntityId;
        const em = this.deps.entityManager;
        const ours = await sources();
        let entity: Entity;
        if (em.getEntity(plannedEntityId)) {
            // An earlier attempt created it, then crashed. Ours, even when an entity
            // with the same identifier has appeared since: add to ours, not to that.
            const appended = await em.appendOsintSources(plannedEntityId, ours, { captured_at: receivedAt });
            if (!appended) throw new Error('Entity note is locked');
            entity = appended;
        } else {
            ({ entity } = await em.upsertEntityFromExternal(
                target.schema, target.properties, ours,
                { identifierKey: target.identifierKey, captured_at: receivedAt, createId: plannedEntityId },
            ));
        }
        const ids = new Set(ours.map((s) => s.id));
        const rec: EntityStep = {
            entityId: entity.id,
            // Only the planned id proves it: a merge keeps the match's own id.
            created: entity.id === plannedEntityId,
            label: entity.label,
            addedSourceIds: (entity.osint_sources ?? []).filter((s) => ids.has(s.id)).map((s) => s.id),
        };
        await step('entity', rec);
        return rec;
    }

    private async sourceFor(bundle: InboxBundle, context: string | undefined): Promise<OsintSourceInput> {
        const { server, manifest, bundleId } = bundle;
        // A Wayback lookup tells archive.org which pages the investigation is looking at,
        // so an item from the browser only triggers one where the case allows it.
        const allowWayback = await this.deps.allowWayback();
        return {
            // Our own id, so the source this bundle added can be found again after a crash
            // and removed exactly. Content-level dedupe still applies on top.
            id: `ext_${bundleId}`,
            source_url: manifest.page.url,
            rationale: context ? `${EXTENSION_RATIONALE}: "${context}"` : EXTENSION_RATIONALE,
            inferred: false,
            captured_at: server.receivedAt,
            received_at: server.receivedAt,
            via: 'extension',
            client_id: server.clientId,
            ...(allowWayback ? {} : { archive_status: 'skipped' as const }),
        };
    }

    /**
     * The page's Sources note: `OSINTCopilot/Sources/<slug>-<12 hex of sha256(url)>.md`.
     * An existing note for the same URL is found by its hash suffix, so a page whose title
     * changed keeps one note.
     */
    async sourcesNotePathFor(page: ManifestPage): Promise<string> {
        const hash = (await sha256Hex(normalizeSourceUrl(page.url))).slice(0, 12);
        const folder = this.deps.app.vault.getAbstractFileByPath(SOURCES_FOLDER);
        if (folder instanceof TFolder) {
            const suffix = `-${hash}.md`;
            const hit = folder.children.find((c) => c instanceof TFile && c.name.endsWith(suffix));
            if (hit) return hit.path;
            // A page whose only record is a highlight's tombstone has a sidecar and no note
            // yet. The note goes beside it, so later items meet that tombstone.
            const sidecar = folder.children.find((c) => c instanceof TFile && c.name.endsWith(`-${hash}.annotations.json`));
            if (sidecar) return sidecar.path.replace(/\.annotations\.json$/, '.md');
        }
        let host = '';
        try { host = new URL(page.url).hostname; } catch { /* slug from the title only */ }
        const slug = sourceSlug(page.title) || sourceSlug(host) || 'page';
        return normalizePath(`${SOURCES_FOLDER}/${slug}-${hash}.md`);
    }

    private sourcesNoteHeader(page: ManifestPage): string {
        const url = page.url;
        // Every value goes through the entity notes' own quoting: page text never reaches
        // YAML unescaped, whatever quotes, newlines or `---` it holds.
        // Below the front matter, page text only ever appears inert (inlineLiteral).
        const heading = inlineLiteral(page.title) || inlineLiteral((() => {
            try { return new URL(url).hostname; } catch { return url; }
        })()) || 'Untitled page';
        return [
            '---',
            yamlScalarLine('source_url', url),
            yamlScalarLine('normalised_url', normalizeSourceUrl(url)),
            yamlScalarLine('title', page.title),
            '---',
            '',
            `# ${heading}`,
            '',
            // A bare URL, which Tangent links as a whole up to the first space (main has
            // already made it an http(s) href, so it holds none). Not `<url>`: the raw-link
            // parser would take the closing `>` into the href. Never alone on its line, where
            // a raw link becomes an embed.
            `Source: ${url.replace(/[<>\s]/g, (c) => encodeURIComponent(c))}`,
            '',
        ].join('\n');
    }

    /** Adds the bundle's section unless the note already has it. Returns the note's path. */
    private async appendSection(page: ManifestPage, bundleId: string, body: string): Promise<string> {
        const { vault } = this.deps.app;
        const path = await this.sourcesNotePathFor(page);
        const block = `${sectionOpen(bundleId)}\n${body}\n${sectionClose(bundleId)}\n`;
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            const text = await vault.read(file);
            if (hasSection(text, bundleId)) return path;
            await vault.modify(file, `${text.replace(/\n*$/, '\n\n')}${block}`);
        } else {
            await ensureFolderExists(this.deps.app, SOURCES_FOLDER);
            await vault.create(path, `${this.sourcesNoteHeader(page)}\n${block}`);
        }
        return path;
    }

    /**
     * Writes a section under `key`, replacing its body when the note already has it, so an
     * edit rewrites a highlight's one section instead of adding another. Returns the path.
     */
    private async putSection(page: ManifestPage, key: string, body: string): Promise<string> {
        const { vault } = this.deps.app;
        const path = await this.sourcesNotePathFor(page);
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            const text = await vault.read(file);
            const replaced = replaceSection(text, key, body);
            if (replaced !== null) {
                if (replaced !== text) await vault.modify(file, replaced);
                return path;
            }
        }
        return this.appendSection(page, key, body);
    }

    /**
     * The page's highlight sidecar, or a fresh one. One that does not parse is set aside
     * (renamed, never deleted: it is the investigation's record) rather than written over.
     */
    private async readSidecar(notePath: string, page: ManifestPage): Promise<{ path: string; sidecar: HighlightSidecar }> {
        const { vault } = this.deps.app;
        const path = sidecarPathFor(notePath);
        const normalised = normalizeSourceUrl(page.url);
        const fresh: HighlightSidecar = { version: 1, normalised_url: normalised, highlights: {} };
        const file = vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return { path, sidecar: fresh };
        const parsed = parseSidecar(await vault.read(file));
        if (!parsed) {
            const aside = path.replace(/\.json$/, `.unreadable-${Date.now()}.json`);
            await vault.rename(file, aside);
            console.warn(`[osint] ${path} could not be read; kept as ${aside} and started again`);
            return { path, sidecar: fresh };
        }
        // Found by the URL's hash, so this can only be another page by a hash collision:
        // better to stop than to file one page's highlights under another's.
        if (parsed.normalised_url !== normalised) throw new Error(`${path} belongs to another page`);
        return { path, sidecar: parsed };
    }

    private async writeSidecar(path: string, sidecar: HighlightSidecar): Promise<void> {
        const { vault } = this.deps.app;
        const text = `${JSON.stringify(sidecar, null, '\t')}\n`;
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await vault.modify(file, text);
        else {
            await ensureFolderExists(this.deps.app, SOURCES_FOLDER);
            await vault.create(path, text);
        }
    }

    /**
     * Files a highlight, or an edit of one: its section in the Sources note (rewritten in
     * place on an edit) and its record in the sidecar. Idempotent, and ordered by the
     * annotation's `modified`, so an edit that arrives after a newer one, or a create after
     * a delete, changes nothing. Says which of those it was: `revived` is an edit newer than
     * a tombstone, which puts back a highlight removed or deleted before it was made.
     */
    private async upsertHighlight(page: ManifestPage, annotation: HighlightAnnotation, bundleId: string, receivedAt: string): Promise<HighlightStep> {
        const notePath = await this.sourcesNotePathFor(page);
        const { path, sidecar } = await this.readSidecar(notePath, page);
        const held = sidecar.highlights[annotation.id];
        if (!isNewer(annotation.modified, held)) return { path: notePath, outcome: 'unchanged' };

        const key = held && !held.deleted && held.section ? held.section : bundleId;
        const firstReceived = held && !held.deleted && held.receivedAt ? held.receivedAt : receivedAt;
        const edited = firstReceived !== receivedAt ? receivedAt : null;
        await this.putSection(page, key, highlightSection(annotation, firstReceived, edited));
        sidecar.highlights[annotation.id] = {
            annotation, section: key, modified: annotation.modified, receivedAt: firstReceived, deleted: false,
        };
        await this.writeSidecar(path, sidecar);
        return { path: notePath, outcome: !held ? 'created' : held.deleted ? 'revived' : 'edited' };
    }

    /**
     * Deletes a highlight: cuts its section and leaves a tombstone in the sidecar, which
     * keeps a late create or edit of it from bringing it back. A delete for a highlight the
     * investigation never received still leaves the tombstone, for the same reason.
     */
    private async deleteHighlight(page: ManifestPage, annotationId: string, modified: string): Promise<string> {
        const notePath = await this.sourcesNotePathFor(page);
        const { path, sidecar } = await this.readSidecar(notePath, page);
        const held = sidecar.highlights[annotationId];
        if (held && !held.deleted && Date.parse(held.modified) > Date.parse(modified)) return notePath;
        // Already deleted: a later delete still moves the tombstone forward, or an edit made
        // between the two, delivered after this one, would bring the highlight back.
        if (held?.deleted && Date.parse(modified) <= Date.parse(held.modified)) return notePath;
        if (held?.section) await this.cutNoteSection(notePath, held.section);
        sidecar.highlights[annotationId] = { section: held?.section ?? null, modified, deleted: true };
        await this.writeSidecar(path, sidecar);
        return notePath;
    }

    private async cutNoteSection(notePath: string, key: string): Promise<void> {
        const { vault } = this.deps.app;
        const file = vault.getAbstractFileByPath(notePath);
        if (!(file instanceof TFile)) return;
        const text = await vault.read(file);
        const cut = cutSection(text, key);
        if (cut !== null) await vault.modify(file, cut);
    }

    // ------------------------------------------------------------------ Remove

    /**
     * Reverses exactly what one applied item added: the entity it created (unless other
     * items have since added sources to it, in which case only its own source goes), or
     * the source it appended to an existing one; for a capture, the Evidence files it
     * placed (see removePlacedFiles); then its section of the Sources note.
     * The item is marked removed and its bundle moved to removed/. Every part is safe to
     * repeat, so a Remove that failed half way can simply be clicked again.
     */
    remove(bundleId: string): Promise<boolean> {
        return this.enqueue(async () => {
            // Fresh from main every time: another window may have removed it already.
            const log = await readExtensionActivity(this.deps.inbox);
            const item = log.find((i) => i.bundleId === bundleId);
            if (!item || item.removed) return false;
            const { outcome } = item;
            const em = this.deps.entityManager;
            const entity = outcome.entityId ? em.getEntity(outcome.entityId) : null;
            if (entity) {
                const ours = new Set(outcome.addedSourceIds);
                const others = (entity.osint_sources ?? []).filter((s) => !ours.has(s.id));
                if (outcome.created && others.length === 0) {
                    if (!(await em.deleteEntity(entity.id))) {
                        throw new Error(`"${entity.label}" is locked and was not deleted.`);
                    }
                } else if (ours.size > 0) {
                    if (!(await em.removeOsintSources(entity.id, [...ours]))) {
                        throw new Error(`"${entity.label}" is locked and was not changed.`);
                    }
                }
            }
            await this.removePlacedFiles(item, log);
            if (item.kind === 'highlight' && item.annotationId && outcome.sourcesNotePath) {
                await this.removeHighlight(item, outcome.sourcesNotePath);
            } else if (outcome.sourcesNotePath) {
                const file = this.deps.app.vault.getAbstractFileByPath(outcome.sourcesNotePath);
                if (file instanceof TFile) {
                    const text = await this.deps.app.vault.read(file);
                    const cut = cutSection(text, bundleId);
                    if (cut !== null) await this.deps.app.vault.modify(file, cut);
                }
            }
            // The move to removed/ is what marks the item removed in every window's log.
            // If it fails the item still reads as applied, and Remove again finishes it:
            // every step above finds nothing left to do.
            await this.deps.inbox.markRemoved(bundleId);
            return true;
        });
    }

    /**
     * Takes a highlight back out of the investigation: its section, wherever its edits left
     * it, and a tombstone in the sidecar so that its create, if still pending, does not put
     * it back. An edit made later in the browser has a newer time, and does bring it back:
     * the investigator changed it after removing it here.
     */
    private async removeHighlight(item: ExtensionActivityItem, notePath: string): Promise<void> {
        const page = { url: item.url, title: item.title };
        const { path, sidecar } = await this.readSidecar(notePath, page);
        const held = sidecar.highlights[item.annotationId!];
        const section = held?.section ?? item.bundleId;
        await this.cutNoteSection(notePath, section);
        // The item's own section too, when the record points elsewhere: a sidecar that had
        // to be set aside loses the link, and an edit then files a section of its own.
        if (section !== item.bundleId) await this.cutNoteSection(notePath, item.bundleId);
        if (held?.deleted) return;
        sidecar.highlights[item.annotationId!] = { section, modified: new Date().toISOString(), deleted: true };
        await this.writeSidecar(path, sidecar);
    }

    /**
     * Trashes the Evidence files this capture created. Not one it reused: that file came
     * with an earlier capture of the identical page. And not one something still in the
     * investigation relies on: another applied capture that placed or reused it, or the
     * Evidence entity, when it survives this Remove (others have added to it) and still
     * points at the file. OS trash, not delete, so a mistake is recoverable.
     */
    private async removePlacedFiles(item: ExtensionActivityItem, log: ExtensionActivityItem[]): Promise<void> {
        const created = item.outcome.placedFiles.filter((f) => f.created).map((f) => f.path);
        if (created.length === 0) return;
        const keep = new Set<string>();
        for (const other of log) {
            if (other.removed || other.bundleId === item.bundleId) continue;
            for (const f of other.outcome.placedFiles) keep.add(f.path);
        }
        const survivor = item.outcome.entityId ? this.deps.entityManager.getEntity(item.outcome.entityId) : undefined;
        if (survivor) {
            if (typeof survivor.properties.filePath === 'string') keep.add(survivor.properties.filePath);
            for (const s of survivor.osint_sources ?? []) {
                if (s.source_url.startsWith('vault://')) keep.add(s.source_url.slice('vault://'.length));
            }
        }
        const { app } = this.deps;
        for (const path of created) {
            if (keep.has(path)) continue;
            const file = app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) await app.fileManager.trashFile(file);
        }
    }
}
