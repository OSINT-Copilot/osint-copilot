import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { extractMainDocument, MhtmlParseError } from './mhtml'

/** The shape Chromium's Page.captureSnapshot actually emits. */
function archive(body: string, encoding = 'quoted-printable', contentType = 'text/html') {
	return [
		'From: <Saved by Blink>',
		'Subject: Probe',
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; type="text/html"; boundary="----BOUNDARY"',
		'',
		'------BOUNDARY',
		`Content-Type: ${contentType}`,
		`Content-Transfer-Encoding: ${encoding}`,
		'Content-Location: https://site.example/page',
		'',
		body,
		'------BOUNDARY--',
		'',
	].join('\r\n')
}

describe('reading the document out of an MHTML snapshot', () => {
	it('decodes quoted-printable, including soft line breaks', () => {
		// Chromium wraps at 76 columns with a trailing `=`, which can split a word in two.
		const doc = extractMainDocument(archive('<p>Hello wo=\r\nrld</p>'))
		expect(doc.html).toBe('<p>Hello world</p>')
	})

	it('decodes escaped bytes back into text', () => {
		const doc = extractMainDocument(archive('<p>caf=C3=A9</p>'))
		expect(doc.html).toBe('<p>café</p>')
	})

	it('leaves a lone = alone rather than eating the next character', () => {
		const doc = extractMainDocument(archive('<p>a =zz b</p>'))
		expect(doc.html).toContain('=zz')
	})

	it('decodes base64 parts', () => {
		const encoded = Buffer.from('<p>Base</p>', 'utf8').toString('base64')
		expect(extractMainDocument(archive(encoded, 'base64')).html).toBe('<p>Base</p>')
	})

	it('passes 8bit bodies through untouched', () => {
		expect(extractMainDocument(archive('<p>Plain</p>', '8bit')).html).toBe('<p>Plain</p>')
	})

	it('reports the address Chromium recorded for the document', () => {
		expect(extractMainDocument(archive('<p>x</p>')).contentLocation)
			.toBe('https://site.example/page')
	})

	it('takes the FIRST html part, so an embedded document cannot pose as the page', () => {
		const two = [
			'MIME-Version: 1.0',
			'Content-Type: multipart/related; boundary="----B"',
			'',
			'------B',
			'Content-Type: text/html',
			'Content-Transfer-Encoding: 8bit',
			'',
			'<p>the page</p>',
			'------B',
			'Content-Type: text/html',
			'Content-Transfer-Encoding: 8bit',
			'',
			'<p>an iframe</p>',
			'------B--',
			'',
		].join('\r\n')
		expect(extractMainDocument(two).html).toContain('the page')
		expect(extractMainDocument(two).html).not.toContain('an iframe')
	})

	it('skips non-html parts on the way to the document', () => {
		const withImage = [
			'MIME-Version: 1.0',
			'Content-Type: multipart/related; boundary="----B"',
			'',
			'------B',
			'Content-Type: image/png',
			'Content-Transfer-Encoding: base64',
			'',
			'iVBORw0KGgo=',
			'------B',
			'Content-Type: text/html',
			'Content-Transfer-Encoding: 8bit',
			'',
			'<p>after the image</p>',
			'------B--',
			'',
		].join('\r\n')
		expect(extractMainDocument(withImage).html).toContain('after the image')
	})

	it('handles a single-part snapshot with no boundary', () => {
		const single = 'Content-Type: text/html\r\nContent-Transfer-Encoding: 8bit\r\n\r\n<p>Solo</p>'
		expect(extractMainDocument(single).html).toBe('<p>Solo</p>')
	})

	it('refuses what is not an archive rather than returning nonsense', () => {
		expect(() => extractMainDocument('')).toThrow(MhtmlParseError)
		expect(() => extractMainDocument('just some text')).toThrow(MhtmlParseError)
		const noHtml = 'MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="----B"\r\n\r\n'
			+ '------B\r\nContent-Type: image/png\r\n\r\nxx\r\n------B--\r\n'
		expect(() => extractMainDocument(noHtml)).toThrow(/no text\/html part/)
	})

	it('reads an archive shaped like chrome.pageCapture\'s: folded top headers, a blank line before the first part, subresources after', () => {
		// fixtures/blink-page.mhtml: "From: <Saved by Blink>", Snapshot-Content-Location, an
		// RFC 2047 Subject, a Content-Type folded over three lines, CRLF throughout, the
		// document quoted-printable with 76-column soft breaks, then CSS and an image.
		const mhtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'blink-page.mhtml'), 'utf8')
		const doc = extractMainDocument(mhtml)
		expect(doc.contentLocation).toBe('https://news.example/2026/09/cafe-owner?ref=home')
		expect(doc.html.startsWith('<!DOCTYPE html>')).toBe(true)
		expect(doc.html).toContain('<title>Café owner profile — Example News</title>')
		expect(doc.html).toContain('reachable at <a href="mailto:owner@cafe.example">')
		expect(doc.html).toContain('Prices rose by 5% = a lot.')
		expect(doc.html).toContain('seventy-six columns of text.')
		expect(doc.html).not.toContain('font-family')
		expect(doc.html.endsWith('</html>')).toBe(true)
	})
})
