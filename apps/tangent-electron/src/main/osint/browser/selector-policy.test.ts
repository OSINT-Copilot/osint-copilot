import { describe, it, expect } from 'vitest'
import {
	capText, compile, contextAround, escapeLiteral, matchOne,
	MAX_HITS_PER_SELECTOR, MAX_TEXT_BYTES, normaliseSelector, parseSelectors,
	type Selector,
} from './selector-policy'

function selector(over: Partial<Selector> = {}): Selector {
	return { id: 's', label: 'S', kind: 'text', pattern: 'x', flags: '', enabled: true, ...over }
}

describe('reading a watchlist', () => {
	it('accepts a bare array or a { selectors: [] } wrapper', () => {
		const one = parseSelectors(JSON.stringify([{ id: 'a', pattern: 'x' }]))
		const two = parseSelectors(JSON.stringify({ selectors: [{ id: 'a', pattern: 'x' }] }))
		expect(one.map(s => s.id)).toEqual(['a'])
		expect(two.map(s => s.id)).toEqual(['a'])
	})

	it('returns nothing rather than throwing on junk', () => {
		for (const input of [null, '', 'not json', '{}', '[]', '{"selectors":5}']) {
			expect(parseSelectors(input)).toEqual([])
		}
	})

	it('drops a regex that will not compile, instead of failing mid-scan', () => {
		// Inside the matcher this would look like a hung scan rather than a bad pattern.
		expect(normaliseSelector({ id: 'bad', kind: 'regex', pattern: '([' })).toBeNull()
		expect(normaliseSelector({ id: 'ok', kind: 'regex', pattern: '[a-z]+' })).not.toBeNull()
	})

	it('refuses flags that would silently change what a watchlist means', () => {
		// `y` matches only at a fixed offset, which reads as a no-op; `g` is applied by the
		// matcher itself, so accepting it here would mean fighting over lastIndex.
		const s = normaliseSelector({ id: 'a', kind: 'regex', pattern: 'x', flags: 'gyimsu' })!
		expect(s.flags).toBe('ims')
	})

	it('refuses duplicate and malformed ids', () => {
		const selectors = parseSelectors(JSON.stringify([
			{ id: 'a', pattern: '1' }, { id: 'a', pattern: '2' },
			{ id: 'Has Space', pattern: '3' }, { pattern: '4' },
		]))
		expect(selectors.map(s => s.id)).toEqual(['a'])
		expect(selectors[0].pattern).toBe('1')
	})
})

describe('what a selector matches', () => {
	it('treats a text selector as a literal, not a pattern', () => {
		// Otherwise a watchlist entry like "a.b@example.com" would match "axb@example.com".
		expect(escapeLiteral('a.b+c')).toBe('a\\.b\\+c')
		expect(matchOne(selector({ pattern: 'a.c' }), 'abc a.c')).toHaveLength(1)
	})

	it('matches text selectors case-insensitively', () => {
		// Nobody writing a watchlist means "this name, but only in this capitalisation".
		expect(matchOne(selector({ pattern: 'Smith' }), 'john smith')).toHaveLength(1)
	})

	it('runs a regex selector as written', () => {
		const hits = matchOne(
			selector({ kind: 'regex', pattern: '[a-z0-9._]+@[a-z.]+', flags: 'i' }),
			'write to Ada.L@example.com or bob@x.org')
		expect(hits.map(h => h.match)).toEqual(['Ada.L@example.com', 'bob@x.org'])
	})

	it('does not loop forever on a pattern that can match nothing', () => {
		const hits = matchOne(selector({ kind: 'regex', pattern: 'x*' }), 'abc')
		expect(hits).toEqual([])
	})

	it('caps hits so one greedy pattern cannot flood the case', () => {
		const hits = matchOne(selector({ kind: 'regex', pattern: 'a' }), 'a'.repeat(5000))
		expect(hits).toHaveLength(MAX_HITS_PER_SELECTOR)
	})

	it('carries enough context to judge a hit without opening the page', () => {
		const text = 'The quick brown fox jumps over the lazy dog, repeatedly and at length.'
		const hit = matchOne(selector({ pattern: 'fox' }), text)[0]
		expect(hit.context).toContain('fox')
		expect(hit.context.length).toBeLessThan(text.length + 10)
	})

	it('marks truncated context so a hit is never read as the whole page', () => {
		const text = 'z'.repeat(500) + 'needle' + 'z'.repeat(500)
		expect(contextAround(text, 500, 6)).toMatch(/^…/)
		expect(contextAround(text, 500, 6)).toMatch(/…$/)
	})

	it('truncates enormous pages rather than refusing them', () => {
		// A huge page still has a top worth checking.
		const capped = capText('x'.repeat(MAX_TEXT_BYTES + 1000))
		expect(capped).toHaveLength(MAX_TEXT_BYTES)
	})

	it('always compiles with g, so a scan finds every occurrence', () => {
		expect(compile(selector()).flags).toContain('g')
	})
})
