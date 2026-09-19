/**
 * Does a file's content look like what its name says? Checked on the first bytes of each
 * upload, so a PNG sent as page.mhtml (or anything sent as anything) is refused rather
 * than stored under a name that the rest of the app trusts.
 *
 * These are shape checks, not validation: a file that passes can still be malformed, and
 * everything that reads one later treats it as hostile.
 *
 * No electron import.
 */
import type { CaptureFileName } from '../extension/protocol';

/** How much of the start of a file the checks need to see. */
export const SNIFF_BYTES = 64 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A MIME message whose top-level Content-Type is multipart/related with a boundary, as
 * Chrome's pageCapture writes it. The header block must end within SNIFF_BYTES.
 */
function looksLikeMhtml(head: Buffer): boolean {
    const text = head.subarray(0, SNIFF_BYTES).toString('latin1');
    const end = text.search(/\r?\n\r?\n/);
    if (end <= 0) return false;
    const headers = text.slice(0, end);
    // Every line is a header or a continuation; a binary blob with a stray blank line is not.
    if (!headers.split(/\r?\n/).every(line => /^[!-9;-~]+:/.test(line) || /^[ \t]/.test(line))) return false;
    const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
    const type = unfolded.match(/^content-type:\s*(.*)$/im);
    return !!type && /^multipart\/related\s*;/i.test(type[1]) && /boundary=/i.test(type[1]);
}

function looksLikePng(head: Buffer): boolean {
    return head.length >= PNG_SIGNATURE.length && head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function looksLikePdf(head: Buffer): boolean {
    return head.subarray(0, 5).toString('latin1') === '%PDF-';
}

export function sniffCaptureFile(name: CaptureFileName, head: Buffer): boolean {
    switch (name) {
        case 'page.mhtml': return looksLikeMhtml(head);
        case 'viewport.png': return looksLikePng(head);
        case 'page.pdf': return looksLikePdf(head);
    }
}
