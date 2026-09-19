/**
 * What a page capture from the browser extension becomes in the graph: one Evidence
 * entity, keyed by its archive's SHA-256, with two sources.
 *
 * Evidence, with a `filePath` property, is the type a file dropped on the graph already
 * becomes (handleGraphFileDrop in graph-view.ts), so a captured page and a dropped PDF look
 * the same to the rest of the app. The key is the archive's bytes, not its URL or title:
 * the same archive sent twice is one piece of evidence, and two captures of one page at
 * different times are two.
 *
 * Pure: no vault I/O. The inbox service places the files first (main copies them into
 * OSINTCopilot/Evidence/) and passes what it got back.
 */
import { EntityType, type OsintSourceInput } from '../entities/types';
import { identifierKey } from '../services/entity-identifiers';
import type { InboxCaptureDerived, InboxPlacedFile, InboxPlacement } from '../host/types';
import type { ManifestPage } from '../../main/osint/extension/protocol';

export const CAPTURE_RATIONALE = 'Captured by the OSINT Copilot browser extension';

/** The only paths a placement may name: main's own folder and name scheme. */
const PLACED_PATH = /^OSINTCopilot\/Evidence\/[a-z0-9-]+(?:\.viewport)?\.(?:mhtml|png|pdf|md)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ROLES = new Set<InboxPlacedFile['role']>(['archive', 'fullpage', 'viewport', 'pdf', 'markdown']);

/** Placed files read back from IPC or a journal, keeping only well-formed ones. */
export function normalizePlacedFiles(raw: unknown): InboxPlacedFile[] {
    if (!Array.isArray(raw)) return [];
    const files: InboxPlacedFile[] = [];
    for (const f of raw as unknown[]) {
        const r = f as Record<string, unknown> | null;
        if (!r || typeof r !== 'object') continue;
        if (!ROLES.has(r.role as InboxPlacedFile['role'])) continue;
        if (typeof r.path !== 'string' || !PLACED_PATH.test(r.path)) continue;
        if (typeof r.sha256 !== 'string' || !SHA256.test(r.sha256)) continue;
        files.push({ role: r.role as InboxPlacedFile['role'], path: r.path, sha256: r.sha256, created: r.created === true });
    }
    return files;
}

/** A placement for this bundle read back from IPC or the journal, or null if it names no archive. */
export function normalizePlacement(raw: unknown, bundleId: string): InboxPlacement | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    if (o.bundleId !== bundleId) return null;
    const files = normalizePlacedFiles(o.files);
    return files.some((f) => f.role === 'archive') ? { bundleId, files } : null;
}

export function placedFile(placement: InboxPlacement, role: InboxPlacedFile['role']): InboxPlacedFile | undefined {
    return placement.files.find((f) => f.role === role);
}

/**
 * Page text that is shown in an entity note's body as it is written there (the note's
 * heading and property list are markdown). `![` and `!` before a scheme are the two ways
 * a line of text makes Tangent embed, and so fetch, a remote address; a zero-width space
 * after the `!` leaves the text as it reads and the parser with nothing to embed.
 */
export function defuseEmbeds(text: string): string {
    return text.replace(/!(?=\[|[a-z][a-z0-9+.-]*:)/gi, '!\u200b');
}

export interface CaptureFacts {
    page: ManifestPage;
    derived: InboxCaptureDerived;
    placement: InboxPlacement;
    /** Main's clock when the capture arrived. */
    receivedAt: string;
}

/** Title as the tab showed it, else the archived document's own, else the address. */
export function captureName({ page, derived }: Pick<CaptureFacts, 'page' | 'derived'>): string {
    return page.title.trim() || derived.title.trim() || page.url;
}

/** What went wrong or does not match, for the entity's description and the Sources note. */
export function captureWarnings({ page, derived }: Pick<CaptureFacts, 'page' | 'derived'>): string[] {
    const out: string[] = [];
    if (derived.urlMismatch) {
        out.push(derived.contentLocation
            ? `The archive records its address as ${derived.contentLocation}, not ${page.url}, the page the extension named.`
            : `The archive does not record its address, so it cannot be tied to ${page.url}, the page the extension named.`);
    }
    if (derived.status === 'failed') {
        out.push('No readable text could be made from the archive'
            + (derived.errors.length ? ` (${derived.errors.join('; ')})` : '')
            + '; the archive itself is intact.');
    }
    return out;
}

export interface EvidenceTarget {
    schema: string;
    properties: Record<string, unknown>;
    identifierKey: string;
}

export function evidenceTargetFor(facts: CaptureFacts): EvidenceTarget | null {
    const archive = placedFile(facts.placement, 'archive');
    if (!archive) return null;
    const key = identifierKey('evidence', archive.sha256);
    if (!key) return null;
    const readable = placedFile(facts.placement, 'markdown') ?? archive;
    const description = [
        `Web page captured by the OSINT Copilot browser extension from ${facts.page.url}, received ${facts.receivedAt}.`,
        // Said on the entity itself, because it is what a reader would otherwise assume.
        'The archive is the page\'s DOM after JavaScript ran, with scripts removed: not the bytes the server sent.',
        ...captureWarnings(facts).map((w) => `Warning: ${w}`),
    ].join(' ');
    return {
        schema: EntityType.Evidence,
        properties: {
            name: defuseEmbeds(captureName(facts)),
            url: facts.page.url,
            sha256: archive.sha256,
            // The markdown, not the archive: this is the one a person can read in the app.
            filePath: readable.path,
            description: defuseEmbeds(description),
        },
        identifierKey: key,
    };
}

/**
 * Two sources, deliberately. The live URL is what a Wayback lookup resolves (where the
 * investigation allows one): an attestation nobody here controls. The `vault://` archive
 * is the one that still works when the page is gone or the site is hostile, and its
 * digest says the archive has not changed since it arrived; it is not a record of what the
 * server sent. Neither alone is enough.
 */
export function evidenceSourcesFor(
    facts: CaptureFacts,
    stamp: { bundleId: string; clientId: string; allowWayback: boolean },
): OsintSourceInput[] {
    const archive = placedFile(facts.placement, 'archive');
    if (!archive) return [];
    const provenance = {
        inferred: false,
        captured_at: facts.receivedAt,
        received_at: facts.receivedAt,
        via: 'extension',
        client_id: stamp.clientId,
        ...(stamp.allowWayback ? {} : { archive_status: 'skipped' as const }),
    };
    return [
        {
            id: `ext_${stamp.bundleId}`,
            source_url: facts.page.url,
            // Each capture of a page is its own attestation, so its own source, even when
            // the archive is byte-for-byte one already held (whose source it then shares).
            rationale: `${CAPTURE_RATIONALE}; received ${facts.receivedAt}.`,
            ...provenance,
        },
        {
            id: `ext_${stamp.bundleId}_archive`,
            source_url: `vault://${archive.path}`,
            rationale: `${CAPTURE_RATIONALE}: local MHTML archive of the page as it rendered, sha256 ${archive.sha256}. `
                + 'Attests that the archive has not changed since it was received; it is not a record of what the server sent.',
            sha256: archive.sha256,
            ...provenance,
        },
    ];
}
