/**
 * Reading the document back out of an MHTML snapshot.
 *
 * Why bother, when the extension could just send `document.documentElement.outerHTML`:
 * because then the bytes that were hashed, the markdown shown to the analyst, and the
 * archive on disk would be three different moments of a page that is still changing under
 * you. A feed that appends while you capture would produce a hash attesting to something
 * the markdown does not say.
 *
 * Taking the HTML out of the MHTML instead means all three describe one instant, and the
 * hash covers the thing the markdown was derived from.
 *
 * Deliberately a small MIME reader rather than a dependency: this parses exactly one
 * shape, the output of Blink's MHTML serializer, which the extension reaches through
 * `chrome.pageCapture.saveAsMHTML`.
 */

export class MhtmlParseError extends Error {}

function headerValue(headers: string, name: string): string | undefined {
	// Unfold continuation lines first: MIME allows a header to wrap onto an indented line,
	// and Chromium wraps long Content-Location values that way.
	const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ')
	const match = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'))
	return match ? match[1].trim() : undefined
}

function decodeQuotedPrintable(body: string): Buffer {
	// Soft line breaks first, then the hex escapes -- in that order, or an `=` at the end
	// of a line is mistaken for a truncated escape.
	const joined = body.replace(/=\r?\n/g, '')
	const bytes: number[] = []
	for (let i = 0; i < joined.length; i++) {
		const char = joined[i]
		if (char === '=' && i + 2 < joined.length) {
			const hex = joined.slice(i + 1, i + 3)
			if (/^[0-9a-f]{2}$/i.test(hex)) {
				bytes.push(parseInt(hex, 16))
				i += 2
				continue
			}
		}
		bytes.push(char.charCodeAt(0) & 0xff)
	}
	return Buffer.from(bytes)
}

function decodePart(body: string, encoding: string | undefined): string {
	switch ((encoding ?? '').toLowerCase()) {
		case 'quoted-printable':
			return decodeQuotedPrintable(body).toString('utf8')
		case 'base64':
			return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
		default:
			// 7bit, 8bit, binary, or absent.
			return body
	}
}

export interface MhtmlDocument {
	html: string
	/** The address Chromium recorded for the main part, which is what it actually fetched. */
	contentLocation?: string
}

/**
 * Returns the main HTML document of an MHTML archive.
 *
 * "Main" is the first `text/html` part. Chromium emits it first, before the subresources,
 * and taking the first rather than searching means a page that embeds an HTML subresource
 * cannot substitute itself for the document.
 */
export function extractMainDocument(mhtml: string): MhtmlDocument {
	const separator = mhtml.search(/\r?\n\r?\n/)
	if (separator < 0) throw new MhtmlParseError('Not an MHTML archive: no header block.')

	const topHeaders = mhtml.slice(0, separator)
	const contentType = headerValue(topHeaders, 'Content-Type') ?? ''
	const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i)

	// A single-part snapshot has no boundary; the body is the document.
	if (!boundaryMatch) {
		if (!/text\/html/i.test(contentType)) {
			throw new MhtmlParseError('Not an MHTML archive: no boundary and not text/html.')
		}
		const body = mhtml.slice(separator).replace(/^\r?\n\r?\n/, '')
		return {
			html: decodePart(body, headerValue(topHeaders, 'Content-Transfer-Encoding')),
			contentLocation: headerValue(topHeaders, 'Content-Location'),
		}
	}

	const boundary = `--${boundaryMatch[1]}`
	const parts = mhtml.split(boundary).slice(1)

	for (const part of parts) {
		const cut = part.search(/\r?\n\r?\n/)
		if (cut < 0) continue
		const headers = part.slice(0, cut)
		if (!/text\/html/i.test(headerValue(headers, 'Content-Type') ?? '')) continue

		// The blank line after the part headers, and the CRLF that belongs to the boundary
		// line rather than to the body. Leaving the latter in appends a stray newline to
		// every captured document.
		const body = part
			.slice(cut)
			.replace(/^\r?\n\r?\n/, '')
			.replace(/\r?\n$/, '')
		return {
			html: decodePart(body, headerValue(headers, 'Content-Transfer-Encoding')),
			contentLocation: headerValue(headers, 'Content-Location'),
		}
	}

	throw new MhtmlParseError('MHTML archive contains no text/html part.')
}
