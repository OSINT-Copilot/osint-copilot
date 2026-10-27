import { describe, it, expect } from 'vitest'
import vectors from './vectors/entity-vectors.json'
import { validateEntity, validateManifest, normalisePageUrl, stripControlChars, stripControlCharsMultiline } from './validate'

/**
 * The shared acceptance vectors: the extension runs the same file, so both ends agree on
 * what the app will take before a bundle is ever sent.
 */
describe('entity vectors', () => {
	it.each(vectors.entities.map(v => [v.note, v] as const))('%s', (_note, v) => {
		const result = validateEntity(v.entity)
		expect(result.ok, JSON.stringify(result)).toBe(v.expect === 'accept')
		if (result.ok && 'value' in v) expect(result.value.value).toBe(v.value)
	})
})

describe('manifest vectors', () => {
	it.each(vectors.manifests.map(v => [v.note, v] as const))('%s', (_note, v) => {
		const result = validateManifest(v.manifest)
		expect(result.ok, JSON.stringify(result)).toBe(v.expect === 'accept')
		if (result.ok) {
			if ('url' in v) expect(result.value.page.url).toBe(v.url)
			if ('bundleId' in v) expect(result.value.bundleId).toBe(v.bundleId)
			if ('text' in v && result.value.kind === 'note') expect(result.value.note.text).toBe(v.text)
		} else if ('detail' in v && result.ok === false) {
			expect(result.detail).toBe(v.detail)
		}
	})
})

/** Built from code points so no raw control character sits in this file. */
const ch = (...points: number[]) => String.fromCharCode(...points)

describe('text cleaning', () => {
	it('strips C0, DEL, C1 and the Unicode line/paragraph separators from single-line fields', () => {
		const dirty = ['a', ch(0x00), 'b', ch(0x1f), 'c', ch(0x7f), 'd', ch(0x85), 'e', ch(0x9f), 'f', ch(0x2028), 'g', ch(0x2029), 'h', ch(0x0a), 'i', ch(0x09), 'j'].join('')
		expect(stripControlChars(dirty)).toBe('abcdefghij')
	})

	it('strips bidi embeddings, overrides and isolates from both kinds of field, but not zero-width joiners', () => {
		const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
		const dirty = 'x' + bidi.map(p => ch(p) + 'y').join('')
		expect(stripControlChars(dirty)).toBe('x' + 'y'.repeat(bidi.length))
		expect(stripControlCharsMultiline(dirty)).toBe('x' + 'y'.repeat(bidi.length))
		const joined = ['a', ch(0x200d), 'b', ch(0x200c), 'c'].join('')
		expect(stripControlChars(joined)).toBe(joined)
	})

	it('keeps only newlines in note text, folding CRLF and CR into them', () => {
		const dirty = ['a', ch(0x0d, 0x0a), 'b', ch(0x0d), 'c', ch(0x0a), 'd', ch(0x09), 'e', ch(0x2028), 'f'].join('')
		expect(stripControlCharsMultiline(dirty)).toBe(['a', 'b', 'c', 'def'].join(ch(0x0a)))
	})
})

describe('normalisePageUrl', () => {
	it('drops credentials and keeps path, query and fragment', () => {
		expect(normalisePageUrl('https://alice:s3cret@example.com/p?q=1#h')).toBe('https://example.com/p?q=1#h')
	})

	it('refuses anything but http(s)', () => {
		for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', 'not a url']) {
			expect(normalisePageUrl(url)).toBeNull()
		}
	})
})

describe('highlights', () => {
	const annotation = (over: Record<string, unknown> = {}) => ({
		id: 'urn:uuid:5F0C6A2E-8B1D-4C3E-9F7A-1B2C3D4E5F60',
		textModel: 'v1',
		created: '2025-10-09T08:53:20.000Z',
		modified: '2025-10-09T08:53:20.000Z',
		target: {
			source: 'https://example.com/',
			selector: [
				{ type: 'TextQuoteSelector', exact: `a${ch(0x202e)}b${ch(0x0a)}c`, prefix: `x${ch(0x00)}`, suffix: '' },
				{ type: 'TextPositionSelector', start: 10, end: 15 },
			],
		},
		...over,
	})
	const manifest = (a: unknown, pageUrl = 'https://example.com/') => ({
		v: 1,
		bundleId: '0b7e7c1e-3f7a-4c56-9a3e-2d4f5b6c7d8e',
		workspaceId: 'AAAAAAAAAAAAAAAAAAAAAA',
		kind: 'highlight',
		page: { url: pageUrl, title: '' },
		clientTime: '2025-10-09T08:53:20.000Z',
		highlight: { annotation: a },
	})

	it('keeps the quote and its context exactly as the page had them, controls included', () => {
		const result = validateManifest(manifest(annotation()))
		expect(result.ok, JSON.stringify(result)).toBe(true)
		if (!result.ok || result.value.kind !== 'highlight') return
		const [quote] = result.value.highlight.annotation.target.selector
		// Cleaning would move the text off the page's own offsets and lose the highlight.
		expect(quote.exact).toBe(`a${ch(0x202e)}b${ch(0x0a)}c`)
		expect(quote.prefix).toBe(`x${ch(0x00)}`)
	})

	it('cleans the investigator\'s note like any note, and lowercases the id', () => {
		const result = validateManifest(manifest(annotation({
			body: { type: 'TextualBody', purpose: 'commenting', value: `one\r\ntwo${ch(0x202e)}three${ch(0x07)}` },
		})))
		expect(result.ok, JSON.stringify(result)).toBe(true)
		if (!result.ok || result.value.kind !== 'highlight') return
		expect(result.value.highlight.annotation.body?.value).toBe('one\ntwothree')
		expect(result.value.highlight.annotation.id).toBe('urn:uuid:5f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f60')
	})

	it('files a highlight under its page without the fragment, and strips credentials from both', () => {
		const result = validateManifest(manifest(
			annotation({ target: { ...annotation().target, source: 'https://user:pw@example.com/a#x' } }),
			'https://user:pw@example.com/a#y',
		))
		expect(result.ok, JSON.stringify(result)).toBe(true)
		if (!result.ok || result.value.kind !== 'highlight') return
		expect(result.value.highlight.annotation.target.source).toBe('https://example.com/a')
		expect(result.value.page.url).toBe('https://example.com/a#y')
	})
})
