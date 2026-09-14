import { describe, it, expect } from 'vitest'
import {
	BUNDLED_PIVOTS, buildUrl, classify, cleanValue, mergePivots,
	normalisePivot, parsePivots, pivotsFor, type Pivot,
} from './pivot-policy'

function pivot(over: Partial<Pivot> = {}): Pivot {
	return {
		id: 'p', label: 'P', category: 'C', url: 'https://x.example/?q={value}',
		appliesTo: ['text'], enabled: true, ...over,
	}
}

describe('working out what a selected value is', () => {
	it('recognises the shapes an analyst actually selects', () => {
		expect(classify('ada@example.com')).toBe('email')
		expect(classify('https://site.example/a/b')).toBe('url')
		expect(classify('192.168.1.10')).toBe('ipv4')
		expect(classify('2001:db8::1')).toBe('ipv6')
		expect(classify('example.co.uk')).toBe('domain')
		expect(classify('ada_lovelace')).toBe('username')
		expect(classify('Ada Lovelace')).toBe('text')
	})

	it('does not read a four-part number over 255 as an address', () => {
		expect(classify('999.1.1.1')).not.toBe('ipv4')
	})

	it('tells an ETH address from a hash, which are both 40 hex characters', () => {
		// Order matters here: without the 0x check first, every ETH address is a hash.
		expect(classify('0x' + 'a'.repeat(40))).toBe('eth')
		expect(classify('a'.repeat(40))).toBe('hash')
		expect(classify('a'.repeat(64))).toBe('hash')
	})

	it('recognises both bitcoin address shapes', () => {
		expect(classify('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe('btc')
		expect(classify('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe('btc')
	})

	it('allows for the punctuation people type into phone numbers', () => {
		expect(classify('+44 7700 900123')).toBe('phone')
		expect(classify('(020) 7946-0958')).toBe('phone')
	})

	it('falls back to text rather than guessing', () => {
		// A wrong kind offers the wrong pivots, which wastes the analyst's attention and
		// sends the value to sites that were never going to know anything about it.
		expect(classify('the quick brown fox')).toBe('text')
		expect(classify('')).toBe('text')
	})

	it('strips the @ people paste around handles', () => {
		expect(cleanValue('@ada', 'username')).toBe('ada')
		expect(cleanValue('ada@example.com', 'email')).toBe('ada@example.com')
	})
})

describe('the directory', () => {
	it('encodes the value into the template', () => {
		expect(buildUrl(pivot(), 'a b&c')).toBe('https://x.example/?q=a%20b%26c')
	})

	it('refuses a template that ignores the value', () => {
		// Silently opening the same page for every selection is worse than no pivot.
		expect(normalisePivot({ id: 'a', url: 'https://x.example/' })).toBeNull()
	})

	it('refuses a non-http scheme', () => {
		expect(normalisePivot({ id: 'a', url: 'file:///etc/{value}' })).toBeNull()
		expect(normalisePivot({ id: 'a', url: 'javascript:alert({value})' })).toBeNull()
	})

	it('lets a user entry replace a bundled one of the same id', () => {
		// So a rotted bundled link can be fixed, or one disabled, without maintaining
		// the whole list.
		const merged = mergePivots(
			[pivot({ id: 'google-exact', label: 'Bundled' })],
			[pivot({ id: 'google-exact', label: 'Mine', url: 'https://mine.example/{value}' })])
		expect(merged).toHaveLength(1)
		expect(merged[0].label).toBe('Mine')
	})

	it('offers only pivots that apply to the value in hand', () => {
		const all = [
			pivot({ id: 'a', appliesTo: ['username'] }),
			pivot({ id: 'b', appliesTo: ['domain'] }),
			pivot({ id: 'c', appliesTo: ['username'], enabled: false }),
		]
		expect(pivotsFor(all, 'username').map(p => p.id)).toEqual(['a'])
	})

	it('survives a corrupt user file', () => {
		for (const input of [null, '', 'not json', '{}', '{"pivots":3}']) {
			expect(parsePivots(input)).toEqual([])
		}
	})
})

describe('the bundled list', () => {
	it('has unique ids and usable templates', () => {
		const ids = BUNDLED_PIVOTS.map(p => p.id)
		expect(new Set(ids).size).toBe(ids.length)
		for (const entry of BUNDLED_PIVOTS) {
			expect(entry.url, entry.id).toMatch(/^https:\/\//)
			expect(entry.url, entry.id).toContain('{value}')
			expect(entry.appliesTo.length, entry.id).toBeGreaterThan(0)
		}
	})

	it('offers something for every kind a value can be classified as', () => {
		for (const kind of ['email', 'phone', 'username', 'domain', 'ipv4', 'btc', 'eth', 'text'] as const) {
			expect(pivotsFor(BUNDLED_PIVOTS, kind).length, kind).toBeGreaterThan(0)
		}
	})

	it('round-trips through the user file format', () => {
		const text = JSON.stringify({ pivots: BUNDLED_PIVOTS })
		expect(parsePivots(text).map(p => p.id).sort()).toEqual(BUNDLED_PIVOTS.map(p => p.id).sort())
	})
})
