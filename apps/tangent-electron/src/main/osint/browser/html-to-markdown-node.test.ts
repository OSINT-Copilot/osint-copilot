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
		expect(markdown).toContain('![Face](https://site.example/pic.png)')
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
})
