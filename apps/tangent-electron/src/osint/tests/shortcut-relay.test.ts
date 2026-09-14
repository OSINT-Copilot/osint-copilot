import { describe, it, expect, beforeEach, vi } from 'vitest'
import { installShortcutRelay, resetShortcutRelayForTests } from '../browser/shortcut-relay'

function fakeApi() {
    const handlers: Array<(input: any) => void> = []
    return {
        handlers,
        osint: { browse: { onShortcut: (h: (input: any) => void) => handlers.push(h) } },
    }
}

beforeEach(() => resetShortcutRelayForTests())

describe('chords that a browsing guest swallowed', () => {
    it('re-dispatches them into the window so app shortcuts still work', () => {
        const api = fakeApi()
        installShortcutRelay(api)

        const seen: KeyboardEvent[] = []
        document.addEventListener('keydown', e => seen.push(e as KeyboardEvent))

        api.handlers[0]({ key: '8', code: 'Digit8', control: true, meta: false, alt: true, shift: false })

        expect(seen).toHaveLength(1)
        expect(seen[0].key).toBe('8')
        expect(seen[0].ctrlKey).toBe(true)
        expect(seen[0].altKey).toBe(true)
        expect(seen[0].bubbles).toBe(true)
    })

    it('installs once per window, however many panes ask', () => {
        // Every pane calls this on mount; the message is delivered to the window, so a
        // second subscription would fire every shortcut twice.
        const api = fakeApi()
        installShortcutRelay(api)
        installShortcutRelay(api)
        installShortcutRelay(api)
        expect(api.handlers).toHaveLength(1)
    })

    it('does nothing when the bridge is missing', () => {
        // The lens must still mount in a context without the preload, such as a test.
        expect(() => installShortcutRelay(undefined)).not.toThrow()
        expect(() => installShortcutRelay({})).not.toThrow()
    })
})
