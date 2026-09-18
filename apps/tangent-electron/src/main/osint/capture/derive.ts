/**
 * What main makes from a capture's archive: inert markdown of the document, its title,
 * and the address the archive says it is of.
 *
 * Pure, and synchronous over up to 50 MB of hostile input, so it never runs on main's own
 * thread: derive-worker.ts runs it in a utility process that main kills at a timeout. The
 * tests call it directly.
 *
 * No electron import.
 */
import * as fs from 'fs';
import { extractMainDocument } from './mhtml';
import { htmlToMarkdown } from './html-to-markdown-node';
import { CAPTURE_FILE_CAPS } from '../extension/protocol';

export interface ParseJob {
    /** The stored page.mhtml, in the pending bundle's folder. */
    archivePath: string;
    /** manifest.page.url: the page the extension says it captured. */
    pageUrl: string;
}

export interface ParsedCapture {
    markdown: string;
    /** Snapshot-Content-Location, else the document part's Content-Location, cleaned; or null. */
    contentLocation: string | null;
    urlMismatch: boolean;
    title: string;
    errors: string[];
}

export type ParseOutcome = { ok: true; result: ParsedCapture } | { ok: false; error: string };

const MAX_LOCATION = 2048;
const MAX_TITLE = 1024;

/** C0, DEL, C1, line/paragraph separators, bidi controls: as validate.ts strips them. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function unfoldedHeaders(mhtml: string): string {
    const end = mhtml.search(/\r?\n\r?\n/);
    return (end < 0 ? '' : mhtml.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
}

/** The top-level Snapshot-Content-Location Blink writes: the URL of the tab it saved. */
export function snapshotContentLocation(mhtml: string): string | undefined {
    const match = unfoldedHeaders(mhtml).match(/^Snapshot-Content-Location:\s*(.*)$/im);
    return match ? match[1].trim() : undefined;
}

/** Cleaned and bounded, or null: this is page-chosen text. */
function cleanLocation(raw: string | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw.replace(CONTROL, '').trim();
    return cleaned && cleaned.length <= MAX_LOCATION ? cleaned : null;
}

/**
 * The same page for evidence purposes: equal after dropping the fragment and any
 * credentials, which the extension strips from page.url. Anything unparseable is not the
 * same page.
 */
export function samePage(a: string, b: string): boolean {
    const norm = (raw: string): string | null => {
        try {
            const url = new URL(raw);
            url.hash = '';
            url.username = '';
            url.password = '';
            return url.href;
        } catch {
            return null;
        }
    };
    const na = norm(a);
    return na !== null && na === norm(b);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (whole, body: string) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
        }
        return ENTITIES[body.toLowerCase()] ?? whole;
    });
}

/** The document's <title>, as text: whitespace collapsed, controls removed, bounded. */
export function documentTitle(html: string): string {
    const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
    if (!match) return '';
    const text = decodeEntities(match[1]).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
    return text.length > MAX_TITLE ? text.slice(0, MAX_TITLE) : text;
}

/** Throws (MhtmlParseError) only when there is no document in the archive at all. */
export function deriveFromMhtml(mhtml: string, pageUrl: string): ParsedCapture {
    const errors: string[] = [];
    const doc = extractMainDocument(mhtml);
    const contentLocation = cleanLocation(snapshotContentLocation(mhtml)) ?? cleanLocation(doc.contentLocation);
    let urlMismatch: boolean;
    if (!contentLocation) {
        // Evidence that cannot say which page it is of is not assumed to be the right one.
        urlMismatch = true;
        errors.push('the archive does not record its address');
    } else {
        urlMismatch = !samePage(contentLocation, pageUrl);
    }
    // Relative links resolve against where the document really came from, when known.
    const sourceUrl = contentLocation && /^https?:/i.test(contentLocation) ? contentLocation : pageUrl;
    const markdown = htmlToMarkdown(doc.html, { sourceUrl });
    return { markdown, contentLocation, urlMismatch, title: documentTitle(doc.html), errors };
}

/** What the worker runs: read the archive (bounded), derive, never throw. */
export function runParseJob(job: ParseJob): ParseOutcome {
    try {
        const stats = fs.statSync(job.archivePath);
        if (!stats.isFile()) return { ok: false, error: 'the archive is not a file' };
        if (stats.size > CAPTURE_FILE_CAPS['page.mhtml']) return { ok: false, error: 'the archive is larger than a capture may be' };
        const mhtml = fs.readFileSync(job.archivePath, 'utf8');
        return { ok: true, result: deriveFromMhtml(mhtml, job.pageUrl) };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
