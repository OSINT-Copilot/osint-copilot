import { describe, it, expect } from 'vitest'
import { htmlToMarkdown } from './html-to-markdown-node'

describe('converting a captured page to markdown', () => {
	it('runs at all in a process with no document', () => {
		// The repo's existing converter dereferences the global `document` for any
		// doctype-prefixed input, which is a ReferenceError here. This is the whole reason
		// this module exists.
		expect(htmlToMarkdown('<!doctype html><html><body><p>Hello</p></body></html>'))
			.toContain('Hello')
	})

	it('keeps script contents out of the evidence', () => {
		// Next.js and JSON-LD blobs are the common case, and they are enormous.
		const html = `<body>
			<script id="__NEXT_DATA__" type="application/json">{"props":{"secret":"blob"}}</script>
			<script type="application/ld+json">{"@type":"Person"}</script>
			<p>Readable text</p>
		</body>`
		const markdown = htmlToMarkdown(html)
		expect(markdown).toContain('Readable text')
		expect(markdown).not.toContain('__NEXT_DATA__')
		expect(markdown).not.toContain('secret')
		expect(markdown).not.toContain('@type')
	})

	it('drops styles, inline SVG and templates', () => {
		const html = `<body>
			<style>.a{color:red}</style>
			<svg><path d="M0 0 L10 10"/><title>icon</title></svg>
			<template><p>not shown</p></template>
			<noscript>enable javascript</noscript>
			<p>Kept</p>
		</body>`
		const markdown = htmlToMarkdown(html)
		expect(markdown.trim()).toBe('Kept')
	})

	it('does not leave a bare URL where an iframe was', () => {
		// Whatever it framed is not in this document; implying otherwise misrepresents
		// what was captured.
		const markdown = htmlToMarkdown('<body><iframe src="https://player.example/x"></iframe><p>After</p></body>')
		expect(markdown).not.toContain('player.example')
		expect(markdown).toContain('After')
	})

	it('makes links and images absolute against the page they came from', () => {
		// A relative link in captured evidence is a dangling reference: nothing can
		// follow it back to what it pointed at.
		const html = '<body><a href="/profile/42">Them</a> <img src="../pic.png" alt="Face"></body>'
		const markdown = htmlToMarkdown(html, { sourceUrl: 'https://site.example/users/index.html' })
		expect(markdown).toContain('[Them](https://site.example/profile/42)')
		expect(markdown).toContain('[image: Face](https://site.example/pic.png)')
	})

	it('leaves links alone when there is nothing to resolve against', () => {
		expect(htmlToMarkdown('<a href="/x">X</a>')).toContain('[X](/x)')
	})

	it('drops a link with no visible text rather than emitting empty brackets', () => {
		expect(htmlToMarkdown('<body><a href="https://x.example"></a><p>Body</p></body>').trim())
			.toBe('Body')
	})

	it('uses atx headings and fenced code, like the rest of the vault', () => {
		const markdown = htmlToMarkdown('<h1>Title</h1><pre><code>x = 1</code></pre>')
		expect(markdown).toContain('# Title')
		expect(markdown).toContain('```')
		expect(markdown).not.toContain('====')
	})

	it('survives junk without throwing', () => {
		for (const input of ['', '<<<', '<p>unclosed', '<body><p>ok</p>']) {
			expect(() => htmlToMarkdown(input)).not.toThrow()
		}
	})

	it('drops the head, so the <title> does not lead the evidence', () => {
		expect(htmlToMarkdown('<html><head><title>T</title><meta name="x" content="y"></head><body><p>Body</p></body></html>').trim())
			.toBe('Body')
	})
})

/**
 * OSINT Copilot turns ![alt](url) and ![[name]] into embeds that load when a note is viewed, and
 * it renders HTML tags. Page-derived markdown carrying either would fetch the target's
 * tracker every time the analyst opened their own evidence.
 */
describe('page-derived markdown is inert', () => {
	const hostile = `<!doctype html><html><head><title>t</title></head><body>
		<p>Before <img src="https://tracker.example/beacon.gif?id=1" alt="pixel"> after</p>
		<picture>
			<source srcset="https://tracker.example/a.webp 1x, https://tracker.example/b.webp 2x" type="image/webp">
			<img src="https://tracker.example/fallback.jpg" alt="pic">
		</picture>
		<img srcset="https://tracker.example/s.png 2x">
		<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="inline">
		<iframe src="https://tracker.example/frame"></iframe>
		<object data="https://tracker.example/o.swf"></object>
		<embed src="https://tracker.example/e.swf">
		<p>Text that says ![x](https://tracker.example/y.png) and ![[z]] and [[w]]</p>
		<p>Look!<img src="https://tracker.example/after-bang.png" alt="b"></p>
		<pre><code>![c](https://tracker.example/code.png) ![[code]] <img src=x></code></pre>
		<p>Escaped markup: &lt;img src="https://tracker.example/t.png"&gt; &lt;!-- c --&gt; &lt;/p&gt;</p>
		<p><code>&lt;script&gt;</code></p>
		<a href="javascript:alert(1)">js link</a>
		<a href="https://site.example/a b(c)">spaced</a>
		<img alt="alt with ![x](y) and <b>tags</b> and ]( brackets" src="https://tracker.example/alt.png">
		<svg><image href="https://tracker.example/svg.png"/></svg>
		<script>document.write('<img src=https://tracker.example/s>')</script>
		<noscript><img src="https://tracker.example/ns.gif"></noscript>
	</body></html>`
	const markdown = htmlToMarkdown(hostile, { sourceUrl: 'https://site.example/page' })

	it('contains no embed syntax at all', () => {
		expect(markdown).not.toContain('![')
	})

	it('contains nothing that could open an HTML tag or comment', () => {
		expect(markdown).not.toMatch(/<[A-Za-z/!?]/)
	})

	it('keeps images as plain links, and says an inline one was there', () => {
		expect(markdown).toContain('[image: pixel](https://tracker.example/beacon.gif?id=1)')
		expect(markdown).toContain('[image: pic](https://tracker.example/fallback.jpg)')
		expect(markdown).toContain('[image: inline]')
		expect(markdown).not.toContain('base64')
	})

	it('drops what was never in the document: frames, objects, scripts, noscript, svg', () => {
		for (const gone of ['frame', 'o.swf', 'e.swf', 'svg.png', 'tracker.example/s>', 'ns.gif', 'webp']) {
			expect(markdown).not.toContain(gone)
		}
	})

	it('keeps the words of a link it will not emit, and makes an emitted target unbreakable', () => {
		expect(markdown).toContain('js link')
		expect(markdown).not.toContain('javascript:')
		expect(markdown).toContain('[spaced](https://site.example/a%20b%28c%29)')
	})

	it('still shows the page text that looked like markup, as text', () => {
		expect(markdown).toContain('&lt;img src=')
		expect(markdown).toContain('&lt;script>')
		expect(markdown).toMatch(/Text that says !\\\[x/)
	})
})
