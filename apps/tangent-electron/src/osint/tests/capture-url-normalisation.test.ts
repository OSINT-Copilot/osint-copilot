import { describe, it, expect } from 'vitest'
import { normalizeSourceUrl } from '../services/osint-confidence-engine'
import { normaliseCaptureUrl } from '../../main/osint/browser/capture-index'
import { EVIDENCE_FOLDER } from '../../main/osint/browser/capture'
import { DEFAULT_EVIDENCE_FOLDER } from '../constants/vault-layout'

/**
 * The capture index dedupes on a normalised URL, and so does OsintSource provenance. They
 * are two copies of the same rule, because main's tsconfig cannot resolve `osint/*` and
 * reaching across that boundary drags Tangent's tree into the strict typecheck.
 *
 * Two copies that disagree would be worse than one: a capture would be filed under one key
 * and its source record under another, so the evidence and the provenance would stop
 * matching up. This is the test that keeps them honest.
 */
describe('main and the renderer normalise URLs the same way', () => {
    const cases = [
        'https://site.example/page',
        'https://site.example/page#fragment',
        'https://site.example/page?a=1&b=2',
        'https://site.example/page?a=1#x',
        'http://site.example/',
        'https://SITE.example/Path',
        'https://site.example:8443/p',
        'vault://Evidence/capture.mhtml',
        'OSINTCopilot/Evidence/capture.mhtml',
        '  https://site.example/padded  ',
        'not a url at all',
        '',
    ]

    for (const input of cases) {
        it(`agrees on ${JSON.stringify(input)}`, () => {
            expect(normaliseCaptureUrl(input)).toBe(normalizeSourceUrl(input))
        })
    }
})

describe('main and the renderer agree on where evidence lives', () => {
    it('writes and reads the same folder', () => {
        // Main writes captures there; the renderer resolves the Evidence entity's filePath
        // against it. Two spellings would mean an entity pointing at nothing.
        expect(EVIDENCE_FOLDER).toBe(DEFAULT_EVIDENCE_FOLDER)
    })
})
