import { describe, it, expect } from 'vitest'
import {
	addCapture, checkBudget, EMPTY_INDEX, isDuplicate, lastCaptureOf,
	normaliseCaptureUrl, parseCaptureIndex, serialiseCaptureIndex,
	type CaptureIndex, type CaptureRecord,
} from './capture-index'

function record(over: Partial<CaptureRecord> = {}): CaptureRecord {
	return {
		id: 'c1', url: 'https://site.example/a', normalisedUrl: 'https://site.example/a',
		title: 'A', capturedAt: '2026-01-01T00:00:00.000Z', sha256: 'sha', domHash: 'dom',
		profileId: 'alpha', files: { mhtml: 'a.mhtml', markdown: 'a.md' }, bytes: 1000,
		...over,
	}
}

describe('the dedupe key', () => {
	it('ignores the fragment, which never reaches the server', () => {
		expect(normaliseCaptureUrl('https://s.example/a#top'))
			.toBe(normaliseCaptureUrl('https://s.example/a'))
	})

	it('keeps the query, which does change what was served', () => {
		expect(normaliseCaptureUrl('https://s.example/a?id=1'))
			.not.toBe(normaliseCaptureUrl('https://s.example/a?id=2'))
	})

	it('passes through vault paths and nonsense untouched', () => {
		expect(normaliseCaptureUrl('vault://Evidence/x.mhtml')).toBe('vault://Evidence/x.mhtml')
		expect(normaliseCaptureUrl('  not a url  ')).toBe('not a url')
	})
})

describe('deciding whether to write another copy', () => {
	it('skips a page that has not changed since the last capture of it', () => {
		const index = addCapture(EMPTY_INDEX, record())
		expect(isDuplicate(index, 'https://site.example/a', 'dom')).toBe(true)
		expect(isDuplicate(index, 'https://site.example/a#anchor', 'dom')).toBe(true)
	})

	it('captures again when the document changed', () => {
		const index = addCapture(EMPTY_INDEX, record())
		expect(isDuplicate(index, 'https://site.example/a', 'different')).toBe(false)
	})

	it('treats the same content at a different address as separate evidence', () => {
		const index = addCapture(EMPTY_INDEX, record())
		expect(isDuplicate(index, 'https://other.example/a', 'dom')).toBe(false)
	})

	it('compares against the LAST capture, so a page that flaps records every change', () => {
		// Someone watching a page for edits needs the flapping, not one sample per state.
		let index: CaptureIndex = addCapture(EMPTY_INDEX, record({ id: 'c1', domHash: 'v1' }))
		index = addCapture(index, record({ id: 'c2', domHash: 'v2' }))
		expect(isDuplicate(index, 'https://site.example/a', 'v1')).toBe(false)
		expect(lastCaptureOf(index, 'https://site.example/a')?.id).toBe('c2')
	})
})

describe('the disk budget', () => {
	it('counts only the profile being captured', () => {
		let index: CaptureIndex = addCapture(EMPTY_INDEX, record({ profileId: 'alpha', bytes: 500 }))
		index = addCapture(index, record({ profileId: 'beta', bytes: 9_000 }))
		expect(checkBudget(index, 'alpha', 1000, 400).permitted).toBe(true)
	})

	it('stops capturing rather than deleting the oldest evidence', () => {
		// Pruning to make room is the wrong failure for a chain of custody: an
		// investigator should find a gap they were told about, not a rewritten record.
		const index = addCapture(EMPTY_INDEX, record({ bytes: 900 }))
		const verdict = checkBudget(index, 'alpha', 1000, 200)
		expect(verdict.permitted).toBe(false)
		expect(verdict.reason).toMatch(/Nothing has been deleted/)
		expect(index.captures).toHaveLength(1)
	})

	it('treats a budget of zero as no limit', () => {
		const index = addCapture(EMPTY_INDEX, record({ bytes: 10 ** 9 }))
		expect(checkBudget(index, 'alpha', 0, 10 ** 9).permitted).toBe(true)
	})
})

describe('the index file', () => {
	it('round-trips', () => {
		const index = addCapture(EMPTY_INDEX, record())
		expect(parseCaptureIndex(serialiseCaptureIndex(index))).toEqual(index)
	})

	it('survives a corrupt or missing file rather than blocking capture', () => {
		for (const input of [null, '', 'not json', '{}', '[]', '{"captures":"nope"}']) {
			expect(parseCaptureIndex(input).captures).toEqual([])
		}
	})
})
