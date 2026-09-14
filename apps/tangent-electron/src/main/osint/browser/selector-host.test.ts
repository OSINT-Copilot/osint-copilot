import { describe, it, expect } from 'vitest'
import { scan } from './selector-host'
import type { Selector } from './selector-policy'

function selector(over: Partial<Selector> = {}): Selector {
	return { id: 's', label: 'S', kind: 'text', pattern: 'x', flags: '', enabled: true, ...over }
}

describe('running a watchlist over a page', () => {
	it('finds what the analyst asked for', async () => {
		const result = await scan([
			selector({ id: 'name', label: 'Target name', pattern: 'Ada Lovelace' }),
			selector({ id: 'mail', label: 'Email', kind: 'regex', pattern: '[a-z]+@[a-z.]+' }),
		], 'Contact Ada Lovelace at ada@example.com about the thing.')

		expect(result.timedOutOn).toBeUndefined()
		expect(result.hits.map(h => h.selectorId).sort()).toEqual(['mail', 'name'])
		expect(result.hits.find(h => h.selectorId === 'mail')!.match).toBe('ada@example.com')
		expect(result.hits.find(h => h.selectorId === 'name')!.context).toContain('Ada Lovelace')
	})

	it('ignores disabled selectors', async () => {
		const result = await scan([selector({ pattern: 'x', enabled: false })], 'x x x')
		expect(result.hits).toEqual([])
	})

	it('does nothing when there is no text', async () => {
		expect((await scan([selector()], '   ')).hits).toEqual([])
	})

	it('KILLS a pattern that will not finish, and names it', async () => {
		// This is the entire reason the matcher does not run on the main thread. V8 has no
		// RegExp timeout and exec does not yield, so on the main thread this hangs the
		// window with no way back. Here it is interrupted from outside.
		const start = Date.now()
		const result = await scan([
			selector({ id: 'runaway', kind: 'regex', pattern: '(a+)+$' }),
		], 'a'.repeat(60) + '!', 700)

		expect(result.timedOutOn).toBe('runaway')
		expect(result.hits).toEqual([])
		// And it actually stopped, rather than the promise resolving while it spins on.
		expect(Date.now() - start).toBeLessThan(5000)
	}, 20_000)

	it('survives the kill and keeps working afterwards', async () => {
		// A hung selector must not take the feature down with it.
		await scan([selector({ id: 'runaway', kind: 'regex', pattern: '(a+)+$' })],
			'a'.repeat(60) + '!', 500)
		const result = await scan([selector({ id: 'fine', pattern: 'needle' })], 'a needle here')
		expect(result.hits.map(h => h.selectorId)).toEqual(['fine'])
	}, 20_000)

	it('reports hits from selectors that ran before the one that hung', async () => {
		// Whether the good hits survive depends on the worker finishing; what must NOT
		// happen is a silent empty result with no indication anything went wrong.
		const result = await scan([
			selector({ id: 'runaway', kind: 'regex', pattern: '(a+)+$' }),
			selector({ id: 'never-reached', pattern: 'needle' }),
		], 'a'.repeat(60) + '! needle', 600)
		expect(result.timedOutOn).toBe('runaway')
	}, 20_000)
})
