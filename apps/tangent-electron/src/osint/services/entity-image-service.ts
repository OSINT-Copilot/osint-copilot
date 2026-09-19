/**
 * Giving an entity a picture.
 *
 * The graph draws an entity as a tile when it has one and a coloured placeholder when it
 * does not (views/graph-node-visual.ts). This is what puts a vault path into
 * `properties.image` so that tile has something to show, from any of the three sources:
 * a URL the model supplies, a file already in the vault, or a file the analyst attaches.
 *
 * ## Reuse, deliberately
 *
 * Every network primitive here comes from canvas/canvas-link-preview.ts rather than being
 * written again. That module already survived an adversarial review that found five
 * security problems in it, and a second fetcher would be a second chance to get any of
 * them wrong. Its defences carry over unchanged:
 *
 *  - all traffic goes through `requestUrl` into the main process, where net-guard refuses
 *    non-HTTP schemes and private, loopback and link-local addresses AFTER DNS, and
 *    re-applies the check to every redirect hop;
 *  - the file type comes from MAGIC BYTES, never Content-Type and never the URL, and only
 *    png/jpg/gif/webp are accepted -- SVG stays refused because it is XML that can carry
 *    script;
 *  - the filename is a hash of the URL plus a sanitised host, never attacker-chosen text.
 *
 * One thing IS new and worth naming: the URL is now chosen by a language model, which may
 * have read it off a hostile page. That makes prompt injection a path to "make this app
 * fetch a URL". It reaches exactly the same guard as a link card, which is why none of it
 * is reimplemented or relaxed here.
 */
import { normalizePath, TFile, type App } from 'obsidian';
import { requestUrl } from '../obsidian-shim/core/request-url';
import {
    MAX_IMAGE_BYTES,
    detectImageType,
    isFetchableUrl,
    thumbnailFileName,
} from '../canvas/canvas-link-preview';
import { isSafeAssetName } from '../canvas/canvas-runtime';
import { ensureFolderExists } from '../utils/vault-bootstrap-fs';
import { isGraphImageExtension, isRemoteUrl } from '../views/graph-node-visual';

/** The property holding a picture of the entity, as a vault-relative path. */
export const ENTITY_IMAGE_KEY = 'image';

/**
 * Where the model puts a URL it has not fetched yet.
 *
 * Kept as a separate key rather than overloading `image` so that a download which fails
 * leaves something to retry, and so `image` only ever holds a path that resolves.
 */
const ENTITY_IMAGE_URL_KEY = 'image_url';

/**
 * A slow host must not look like a hung app.
 *
 * requestUrl has no timeout of its own, and one unreachable server in a batch of thirty
 * entities would otherwise stall the whole confirm-and-apply.
 */
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

export interface EntityImageHost {
    app: App;
    /** Folder for downloaded pictures, vault-relative. */
    folder: string;
}

/** What happened, so the caller can tell the user something true. */
export type EntityImageOutcome =
    | { kind: 'none' }
    | { kind: 'existing'; path: string }
    | { kind: 'downloaded'; path: string; url: string }
    | { kind: 'failed'; url: string; reason: string };

export interface ResolvedEntityImage {
    properties: Record<string, unknown>;
    outcome: EntityImageOutcome;
}

function asTrimmedString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A vault path that exists and is an image we are willing to paint. */
function resolveVaultImage(app: App, candidate: string): string | undefined {
    if (!isGraphImageExtension(candidate)) return undefined;
    const file = app.vault.getAbstractFileByPath(normalizePath(candidate));
    return file instanceof TFile ? file.path : undefined;
}

/**
 * Turns whatever the model (or a form) put in `image` / `image_url` into a vault path.
 *
 * Never throws and never rejects: an entity with no picture is a perfectly good entity,
 * and one failed download must not take a batch of thirty down with it.
 */
export async function resolveEntityImage(
    host: EntityImageHost,
    properties: Record<string, unknown>,
): Promise<ResolvedEntityImage> {
    const next = { ...properties };
    const image = asTrimmedString(next[ENTITY_IMAGE_KEY]);
    const imageUrl = asTrimmedString(next[ENTITY_IMAGE_URL_KEY]);

    // A path already in the vault wins, and costs no network at all. Checked first so a
    // model that fills in both keys does not trigger a pointless download.
    if (image && !isRemoteUrl(image)) {
        const resolved = resolveVaultImage(host.app, image);
        if (resolved) {
            next[ENTITY_IMAGE_KEY] = resolved;
            delete next[ENTITY_IMAGE_URL_KEY];
            return { properties: next, outcome: { kind: 'existing', path: resolved } };
        }
        // Names a file that is not there: drop it rather than leave the tile pointing at
        // nothing, but keep any URL so the download below still gets its turn.
        delete next[ENTITY_IMAGE_KEY];
    }

    // `image` holding a URL is a mistake we can simply absorb rather than refuse.
    const url = imageUrl ?? (image && isRemoteUrl(image) ? image : undefined);
    if (!url) {
        delete next[ENTITY_IMAGE_URL_KEY];
        return { properties: next, outcome: { kind: 'none' } };
    }

    if (!isFetchableUrl(url)) {
        return { properties: next, outcome: { kind: 'failed', url, reason: 'not a fetchable http(s) URL' } };
    }

    const downloaded = await downloadImage(host, url);
    if (!downloaded) {
        // image_url survives on purpose: it is the retry, and it records what was meant.
        return { properties: next, outcome: { kind: 'failed', url, reason: 'could not be downloaded' } };
    }

    next[ENTITY_IMAGE_KEY] = downloaded;
    delete next[ENTITY_IMAGE_URL_KEY];
    return { properties: next, outcome: { kind: 'downloaded', path: downloaded, url } };
}

/** Fetches, validates and stores one image. Returns its vault path, or null. */
async function downloadImage(host: EntityImageHost, url: string): Promise<string | null> {
    try {
        const response = await withTimeout(requestUrl({ url, throw: false }));
        if (!response || response.status >= 400) return null;
        if (response.arrayBuffer.byteLength > MAX_IMAGE_BYTES) return null;

        const bytes = new Uint8Array(response.arrayBuffer);
        // Magic bytes, not Content-Type: a server can claim anything, and an HTML error
        // page served as image/png is the common case rather than an exotic one.
        const extension = detectImageType(bytes);
        if (!extension) return null;

        const fileName = thumbnailFileName(url, extension);
        if (!isSafeAssetName(fileName)) return null;

        const folder = normalizePath(host.folder);
        await ensureFolderExists(host.app, folder);
        const path = normalizePath(`${folder}/${fileName}`);

        // The name is a hash of the URL, so an existing file of that name is the same
        // picture. Reusing it makes re-running an extraction cheap and idempotent.
        const existing = host.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) return existing.path;

        const created = await host.app.vault.createBinary(path, response.arrayBuffer);
        return created.path;
    } catch (error) {
        console.error('[osint] entity image download failed', url, error);
        return null;
    }
}

function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
    return Promise.race([
        promise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), IMAGE_FETCH_TIMEOUT_MS)),
    ]);
}
