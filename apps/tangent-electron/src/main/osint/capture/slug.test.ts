import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { evidenceSlug, evidenceStem } from './slug'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('evidence file names', () => {
	it('slugs the title, falling back to the host, then to "capture"', () => {
		expect(evidenceSlug('Café owner — Example News!', 'https://x.example/')).toBe('caf-owner-example-news')
		expect(evidenceSlug('  ', 'https://news.example/a')).toBe('news-example')
		expect(evidenceSlug('', 'not a url')).toBe('capture')
		expect(evidenceSlug('———', 'not a url')).toBe('capture')
	})

	it('keeps the names evidence already has: no accent folding, the same cut at 60', () => {
		const url = 'https://news.example/a'
		expect(evidenceSlug('--Leading and trailing--', url)).toBe('leading-and-trailing')
		expect(evidenceSlug('İstanbul ÉTÉ', url)).toBe('i-stanbul-t')
		expect(evidenceSlug('Ünïcode — Title: "Quoted"!', url)).toBe('n-code-title-quoted')
		expect(evidenceSlug('ﬁle Ⅻ ①', url)).toBe('le')
		expect(evidenceSlug('a'.repeat(58) + ' -- b', url)).toBe('a'.repeat(58) + '-b')
		expect(evidenceSlug('x'.repeat(59) + '!!!!!', url)).toBe('x'.repeat(59))
		expect(evidenceSlug('日本語のページ', url)).toBe('capture')
	})

	it('never yields a path separator, a dot or a leading dash, and stays short', () => {
		for (const title of ['../../etc/passwd', '..\\..\\win', '.hidden', '-flag', 'a/b', 'x'.repeat(500), 'a'.repeat(59) + ' b']) {
			const slug = evidenceSlug(title, 'https://x.example/')
			expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
			expect(slug.length).toBeLessThanOrEqual(60)
		}
	})

	it('suffixes the archive hash, so two captures of one page never share a name', () => {
		const a = evidenceStem('Same page', 'https://x.example/', sha('archive one'))
		const b = evidenceStem('Same page', 'https://x.example/', sha('archive two'))
		expect(a).toMatch(/^same-page-[0-9a-f]{8}$/)
		expect(a).not.toBe(b)
		expect(evidenceStem('Same page', 'https://x.example/', sha('archive one'))).toBe(a)
	})

	it('refuses something that is not a digest', () => {
		expect(() => evidenceStem('t', 'https://x.example/', '../../x')).toThrow()
	})
})
