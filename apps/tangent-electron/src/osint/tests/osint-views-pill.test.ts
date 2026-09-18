import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { OSINT_VIEWS } from '../integration/osint-view-types'

/**
 * Every OSINT surface has a button in the toolbar pill.
 *
 * Read as source rather than rendered, because the pill mounts inside Tangent's
 * WorkspaceView with a `workspace` context and a live command registry; standing all that
 * up would test the harness more than the thing. What actually goes wrong here is simpler
 * and this catches it: someone adds a surface, wires its command, and never adds the
 * button. That shipped once, in 0.13.0: the command existed, the shortcut worked, and
 * the feature was invisible unless you already knew it was there.
 *
 * A feature reachable only by a keyboard shortcut nobody told you about is
 * indistinguishable, from the outside, from a feature that was never built.
 */
const pillSource = fs.readFileSync(
    path.join(__dirname, '../integration/OsintViewsPill.svelte'), 'utf8')

/** Commands for surfaces that are documents, not views, so they are not in OSINT_VIEWS. */
const DOCUMENT_COMMANDS = [
    { key: 'osintOpenCanvas', what: 'canvas boards' },
]

describe('the OSINT toolbar', () => {
    it('renders every view from the descriptor list, so none can be forgotten', () => {
        // The views are a loop over OSINT_VIEWS indexed by commandKey, which is why their
        // command keys never appear literally in the source -- and why adding a view
        // cannot leave it without a button. Only the hand-spelled surfaces below can.
        expect(pillSource).toContain('OSINT_VIEWS')
        expect(pillSource).toMatch(/\{#each views as view/)
        expect(pillSource).toContain('workspace.commands[view.commandKey]')
        expect(OSINT_VIEWS.length).toBeGreaterThan(0)
    })

    it('has a button for every document surface', () => {
        for (const { key, what } of DOCUMENT_COMMANDS) {
            expect(pillSource, `${what} have no toolbar button`).toContain(key)
        }
    })

    it('gives every button an accessible label', () => {
        const buttons = pillSource.match(/<button\b[\s\S]*?>/g) ?? []
        expect(buttons.length).toBeGreaterThan(0)
        for (const button of buttons) {
            expect(button, 'a toolbar button has no aria-label')
                .toMatch(/aria-label=/)
        }
    })

    it('drives every button through the command registry', () => {
        // `use:command` is what gives a button its tooltip, its shortcut, its disabled
        // state and its checked highlight. A button wired to a bare on:click would look
        // right and behave differently from every other one in the bar.
        const buttons = pillSource.match(/<button\b[\s\S]*?<\/button>/g) ?? []
        for (const button of buttons) {
            expect(button, 'a toolbar button bypasses use:command').toContain('use:command')
        }
    })
})
