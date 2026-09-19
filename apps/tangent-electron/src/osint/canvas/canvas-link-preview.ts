/**
 * Link previews: fetching a pasted URL's title, description and thumbnail.
 *
 * The threat model here is not hypothetical. An analyst pastes a link they did not author,
 * pointing at a page an adversary controls, into a renderer that has no CSP and exposes
 * window.api. Everything below assumes the response is hostile.
 *
 * The defences, and why each one is where it is:
 *
 * - All network goes through `requestUrl`, which is main-process HTTP behind net-guard
 *   (non-HTTP schemes refused, private/link-local addresses refused after DNS, and since
 *   guardedFetch, every redirect hop re-checked). The renderer never fetches, so nothing
 *   here can reach a host the guard has not cleared.
 * - HTML is parsed with DOMParser into a document with no browsing context. Such a document
 *   is inert by specification: scripts do not run and subresources are not loaded, so an
 *   `<img src>` or `<script>` in the response is never fetched or executed. We only ever
 *   read attribute values out of it, and never insert a node from it into the live DOM.
 * - The thumbnail is identified by MAGIC BYTES, not by Content-Type or by the URL's
 *   extension, both of which the attacker chooses. Its filename is constructed from a hash,
 *   never from attacker text, so path traversal and extension spoofing are not reachable.
 * - SVG is refused even though it is an image format: it is XML that can carry script, and
 *   the value of accepting it does not justify reasoning about every renderer path.
 */
import { requestUrl } from '../obsidian-shim/core/request-url';

/** Extra keys written onto a link node. Preserved verbatim by the format layer. */
export const LINK_TITLE_KEY = 'osintLinkTitle';
export const LINK_DESCRIPTION_KEY = 'osintLinkDescription';
export const LINK_IMAGE_KEY = 'osintLinkImage';
export const LINK_SITE_KEY = 'osintLinkSite';
export const LINK_FETCHED_KEY = 'osintLinkFetchedAt';

/**
 * Caps.
 *
 * These bound what we PARSE and what we WRITE. They cannot bound what main downloads,
 * because requestUrl materialises the whole body before returning -- a real limitation
 * worth knowing, and the reason the HTML cap is generous rather than tight.
 */
const MAX_HTML_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 400;

export interface LinkPreview {
    title?: string;
    description?: string;
    siteName?: string;
    /** Absolute URL of the thumbnail, still to be downloaded and vaulted. */
    imageUrl?: string;
}

/** Only formats whose magic bytes are unambiguous, and none that can carry script. */
const IMAGE_SIGNATURES: { ext: string; test: (b: Uint8Array) => boolean }[] = [
    { ext: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
    { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: 'gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
    {
        ext: 'webp',
        test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
            && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
    },
];

/**
 * The image format these bytes actually are, or null.
 *
 * Deliberately ignores Content-Type and the URL: both are chosen by the same party that
 * chose the bytes. Returning null is a refusal to write the file at all.
 */
export function detectImageType(bytes: Uint8Array): string | null {
    if (bytes.length < 12) return null;
    for (const signature of IMAGE_SIGNATURES) {
        if (signature.test(bytes)) return signature.ext;
    }
    return null;
}

/** Collapses whitespace and truncates, so a card cannot be given a megabyte of "title". */
export function tidyText(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH - 1) + '…' : text;
}

/** Only http/https may be stored or fetched. Refuses javascript:, data:, file: and friends. */
export function isFetchableUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/** The bit of a URL worth showing when there is no title. */
export function displayHost(value: string): string {
    try {
        return new URL(value).hostname.replace(/^www\./, '');
    } catch {
        return value;
    }
}

function metaContent(doc: Document, selectors: string[]): string | undefined {
    for (const selector of selectors) {
        const element = doc.querySelector(selector);
        const content = element?.getAttribute('content');
        const tidied = tidyText(content);
        if (tidied) return tidied;
    }
    return undefined;
}

/**
 * Reads OpenGraph/Twitter/standard metadata out of a hostile HTML document.
 *
 * `DOMParser.parseFromString(html, 'text/html')` yields a document with no browsing
 * context, which the HTML specification defines as inert: no script executes, no
 * subresource is fetched. That is what makes it safe to hand this attacker-controlled
 * markup at all -- and why nothing from `doc` may ever be adopted into the live document.
 */
export function parseLinkMetadata(html: string, sourceUrl: string): LinkPreview {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const title = metaContent(doc, [
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
    ]) ?? tidyText(doc.querySelector('title')?.textContent);

    const description = metaContent(doc, [
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
        'meta[name="description"]',
    ]);

    const siteName = metaContent(doc, ['meta[property="og:site_name"]']) ?? displayHost(sourceUrl);

    const rawImage = metaContent(doc, [
        'meta[property="og:image"]',
        'meta[property="og:image:url"]',
        'meta[name="twitter:image"]',
    ]);

    let imageUrl: string | undefined;
    if (rawImage) {
        try {
            // Resolved against the page, since og:image is often relative. The result is
            // re-checked below, because a page may point og:image at javascript: or file:.
            const resolved = new URL(rawImage, sourceUrl).toString();
            if (isFetchableUrl(resolved)) imageUrl = resolved;
        } catch { /* unusable image URL; the preview is still worth having */ }
    }

    return { title, description, siteName, imageUrl };
}

/**
 * A vault filename for a thumbnail.
 *
 * Built from a hash of the URL plus the extension implied by the BYTES. No part of it is
 * attacker text, so traversal (`../`), absolute paths, control characters, reserved
 * Windows names, unicode look-alikes and overlong names are all unreachable by
 * construction rather than by filtering.
 */
export function thumbnailFileName(sourceUrl: string, extension: string): string {
    let hash = 2166136261;
    for (let i = 0; i < sourceUrl.length; i++) {
        hash ^= sourceUrl.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    // The host is included only for human readability, and only after being reduced to a
    // conservative charset with a hard length cap.
    const host = displayHost(sourceUrl).toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 40);
    const safeHost = host.replace(/^[.-]+/, '') || 'link';
    return `${safeHost}-${hash.toString(16).padStart(8, '0')}.${extension}`;
}

export interface FetchedPreview extends LinkPreview {
    /** Present only when the bytes were verified to be an image we accept. */
    image?: { bytes: ArrayBuffer; extension: string; fileName: string };
}

/**
 * Fetches a URL's preview. Never throws: a preview is a nicety, and a link card must
 * remain usable when the page is gone, blocked, or hostile.
 */
export async function fetchLinkPreview(url: string): Promise<FetchedPreview | null> {
    if (!isFetchableUrl(url)) return null;

    let html: string;
    try {
        const response = await requestUrl({
            url,
            // Non-2xx resolves rather than throwing: a 404 page often still carries useful
            // metadata, and either way we want the failure handled here, not upstream.
            throw: false,
            headers: { Accept: 'text/html,application/xhtml+xml' },
        });
        if (response.status >= 400) return null;
        if (response.arrayBuffer.byteLength > MAX_HTML_BYTES) return null;
        html = response.text;
    } catch (e) {
        console.debug('[Canvas] link preview fetch failed', url, e);
        return null;
    }

    const preview = parseLinkMetadata(html, url);
    if (!preview.imageUrl) return preview;

    try {
        const image = await requestUrl({ url: preview.imageUrl, throw: false });
        if (image.status >= 400) return preview;
        if (image.arrayBuffer.byteLength > MAX_IMAGE_BYTES) return preview;

        const bytes = new Uint8Array(image.arrayBuffer);
        const extension = detectImageType(bytes);
        // Not an image we recognise: keep the text preview, write nothing to the vault.
        if (!extension) return preview;

        return {
            ...preview,
            image: {
                bytes: image.arrayBuffer,
                extension,
                fileName: thumbnailFileName(preview.imageUrl, extension),
            },
        };
    } catch (e) {
        console.debug('[Canvas] link thumbnail fetch failed', preview.imageUrl, e);
        return preview;
    }
}
