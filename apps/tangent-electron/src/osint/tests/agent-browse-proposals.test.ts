import { describe, it, expect } from 'vitest'
import { parseAgentTurnResult } from '../services/agent-runtime/parse-agent-turn-json'
import { AGENT_TURN_SCHEMA_VERSION } from '../services/agent-runtime/provider-types'
import { buildUnifiedAgentSystemPrompt } from '../services/agent-runtime/build-unified-agent-prompt'

function turn(extra: Record<string, unknown>): string {
    return JSON.stringify({
        version: AGENT_TURN_SCHEMA_VERSION,
        answer_markdown: 'Have a look at these.',
        retrieval_hits: [],
        graph_operations: [],
        custom_vault_operations: [],
        enricher_invocations: [],
        ...extra,
    })
}

describe('pages the assistant proposes opening', () => {
    it('accepts http(s) proposals with their reasons', () => {
        const r = parseAgentTurnResult(turn({
            browse_proposals: [
                { url: 'https://site.example/a', reason: 'the registration record' },
                { url: 'http://other.example/b' },
            ],
        }), 'claude-code')

        expect(r.browse_proposals).toHaveLength(2)
        expect(r.browse_proposals![0]).toEqual({
            url: 'https://site.example/a', reason: 'the registration record',
        })
        expect(r.browse_proposals![1].reason).toBeUndefined()
    })

    it('drops schemes that have no business being proposed', () => {
        // These become panes, so a bad entry costs a file rather than a request -- but a
        // file: or javascript: url should never get that far.
        const r = parseAgentTurnResult(turn({
            browse_proposals: [
                { url: 'file:///etc/passwd' },
                { url: 'javascript:alert(1)' },
                { url: 'data:text/html,<script>1</script>' },
                { url: 'https://fine.example/' },
            ],
        }), 'claude-code')
        expect(r.browse_proposals!.map(p => p.url)).toEqual(['https://fine.example/'])
    })

    it('deduplicates and caps, so one turn cannot fill the thread', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ url: `https://s.example/${i}` }))
        const r = parseAgentTurnResult(turn({
            browse_proposals: [...many, { url: 'https://s.example/0' }],
        }), 'claude-code')
        expect(r.browse_proposals!.length).toBeLessThanOrEqual(8)
        expect(new Set(r.browse_proposals!.map(p => p.url)).size).toBe(r.browse_proposals!.length)
    })

    it('survives junk and an older provider that emits nothing', () => {
        expect(parseAgentTurnResult(turn({ browse_proposals: 'nope' }), 'claude-code')
            .browse_proposals).toEqual([])
        expect(parseAgentTurnResult(turn({ browse_proposals: [1, null, {}, { url: 5 }] }), 'claude-code')
            .browse_proposals).toEqual([])
        // Absent entirely: the field is optional so an older provider still parses.
        expect(parseAgentTurnResult(turn({}), 'claude-code').browse_proposals).toEqual([])
    })
})

describe('what the assistant is told about proposing pages', () => {
    const prompt = buildUnifiedAgentSystemPrompt('Claude Code')

    it('puts browse_proposals in the turn contract', () => {
        expect(prompt).toContain('browse_proposals')
        expect(prompt).toContain('Rules for browse_proposals')
    })

    it('says plainly that the pages are not loaded', () => {
        // The whole safety property is that proposing costs the user nothing and tells the
        // site nothing. If the prompt does not say so, the model will describe these as
        // pages it read.
        expect(prompt).toMatch(/not\s+\*\*loaded\*\*|not loaded/i)
        expect(prompt).toContain('Do NOT describe these as pages you visited')
    })

    it('still tells the truth about enrichers, and points at the alternative', () => {
        // The old clause was accurate -- enrichers really do run in main with no browser
        // cookies -- so it was amended rather than deleted.
        expect(prompt).toContain('no browser tab, no user browser cookies')
        expect(prompt).toContain('use browse_proposals instead')
    })
})
