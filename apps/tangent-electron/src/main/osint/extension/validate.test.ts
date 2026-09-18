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
