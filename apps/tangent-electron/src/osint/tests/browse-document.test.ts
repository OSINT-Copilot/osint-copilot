import { describe, it, expect } from 'vitest'
import { BrowseDocumentStore, parseBrowseDocument, serializeBrowseDocument, SAVE_DEBOUNCE_MS } from '../browser/browse-document'

function fakeFiles(initial: string | null = null) {
    const state = { text: initial, writes: 0 }
    return {
        state,
        read: async () => state.text,
        write: async (_p: string, contents: string) => { state.text = contents; state.writes++ },
    }
}

describe('what a browsing pane remembers', () => {
    it('survives a corrupt or empty file rather than losing the pane', () => {
        for (const input of [null, '', 'not json', '[]', '"a string"']) {
            expect(parseBrowseDocument(input)).toEqual({})
        }
    })

    it('preserves fields it does not recognise', async () => {
        // An older build must not eat a newer build's data on the next save.
        const files = fakeFiles(JSON.stringify({ url: 'https://a.example/', futureField: 42 }))
        const store = new BrowseDocumentStore('/p.osintbrowse', files)
        await store.load()
        store.record('https://b.example/', 'B')
        await store.flush()
        expect(JSON.parse(files.state.text!).futureField).toBe(42)
    })

    it('refuses to write before it has loaded', async () => {
        // A lens can be built while a session is restoring, before the vault adapter
        // exists. Writing then would put an empty document over a real one.
        const files = fakeFiles(JSON.stringify({ url: 'https://real.example/' }))
        const store = new BrowseDocumentStore('/p.osintbrowse', files)
        store.record('https://other.example/', 'x')
        await store.flush()
        expect(files.state.writes).toBe(0)
        expect(JSON.parse(files.state.text!).url).toBe('https://real.example/')
    })

    it('does not treat about:blank as somewhere the operator went', async () => {
        const files = fakeFiles(JSON.stringify({ url: 'https://real.example/' }))
        const store = new BrowseDocumentStore('/p.osintbrowse', files)
        await store.load()
        store.record('about:blank', undefined)
        await store.flush()
        expect(store.value.url).toBeUndefined()
    })

    it('remembers the identity the pane was using', async () => {
        const files = fakeFiles(null)
        const store = new BrowseDocumentStore('/p.osintbrowse', files)
        await store.load()
        store.recordProfile('alpha')
        await store.flush()
        expect(JSON.parse(files.state.text!).profileId).toBe('alpha')
    })

    it('writes nothing when nothing changed', async () => {
        const files = fakeFiles(JSON.stringify({ url: 'https://a.example/', title: 'A' }))
        const store = new BrowseDocumentStore('/p.osintbrowse', files)
        await store.load()
        store.record('https://a.example/', 'A')
        await store.flush()
        expect(files.state.writes).toBe(0)
    })

    it('round-trips through serialize/parse', () => {
        const doc = { url: 'https://a.example/', title: 'A', profileId: 'alpha' }
        expect(parseBrowseDocument(serializeBrowseDocument(doc))).toEqual(doc)
    })

    it('debounces rather than writing per navigation', () => {
        // Every write lands under Tangent's watcher and fans an event to every window.
        expect(SAVE_DEBOUNCE_MS).toBeGreaterThanOrEqual(500)
    })
})
