import { describe, it, expect } from 'vitest'
import { htmlToMarkdown } from '../../main/osint/capture/html-to-markdown-node'
import { markdownToTextDocument } from '../../common/markdownModel/parser'

// Here rather than beside the converter (html-to-markdown-node.test.ts): Tangent's parser
// is not written to the strict null checks src/main/osint is typechecked with, and
// src/osint/tests is outside that check. What is asserted is the converter's text output,
// which does not depend on which DOM turndown parsed with.

/**
 * The check that matters: what Tangent's own parser makes of the output, as the editor
 * would render it. Tangent embeds a bare URL alone on its line (rawLinksAutoEmbed is on by
 * default) and `!https://...` anywhere, which no search for '![' or '<' would catch.
 */
describe('Tangent embeds nothing from a captured page', () => {
	function spansIn(markdown: string): Array<{ embed: boolean; href: string }> {
		const out: Array<{ embed: boolean; href: string }> = []
		for (const line of markdownToTextDocument(markdown).lines) {
			for (const op of line.content.ops) {
				const at = op.attributes as { t_embed?: boolean; t_link?: { href?: string } } | undefined
				if (at?.t_embed || at?.t_link) out.push({ embed: !!at.t_embed, href: String(at.t_link?.href ?? '') })
			}
		}
		return out
	}

	const attacks: Record<string, string> = {
		'a bare URL alone on its line': '<p>https://tracker.example/beacon.png</p>',
		'a bare URL as a list item': '<ul><li>https://tracker.example/li.png</li></ul>',
		'a bare URL in a heading': '<h2>https://tracker.example/h.png</h2>',
		'a bare URL after a line break': '<p>first<br>https://tracker.example/br.png</p>',
		'a bang before a scheme': '<p>see !https://tracker.example/x.gif</p>',
		'a bang before a scheme at the start': '<p>!https://tracker.example/start.gif</p>',
		'markdown image syntax as text': '<p>![x](https://tracker.example/y.png)</p>',
		'a wiki embed as text': '<p>![[OSINTCopilot/Entities/secret]]</p>',
		'an image': '<p><img src="https://tracker.example/img.png" alt="a"></p>',
		'an image alone in a link': '<a href="https://site.example/p"><img src="https://tracker.example/in-a.png"></a>',
		'a picture': '<picture><source srcset="https://tracker.example/p.webp"><img src="https://tracker.example/p.jpg"></picture>',
		'an iframe': '<iframe src="https://tracker.example/frame"></iframe>',
		'a bare URL in code': '<pre><code>https://tracker.example/code.png\n!https://tracker.example/code2.png</code></pre>',
		'a link whose text is its address': '<a href="https://tracker.example/l">https://tracker.example/l</a>',
		'an angle-bracket autolink as text': '<p>&lt;https://tracker.example/auto.png&gt;</p>',
	}

	for (const [name, body] of Object.entries(attacks)) {
		it(`for ${name}`, () => {
			const markdown = htmlToMarkdown(`<body>${body}</body>`, { sourceUrl: 'https://site.example/page' })
			const spans = spansIn(markdown)
			expect(spans.filter(s => s.embed), markdown).toEqual([])
			// What is still a link is one this module wrote: `[text](target)`, never raw.
			for (const span of spans) expect(markdown).toContain(`](${span.href})`)
		})
	}

	it('keeps the links it writes followable, even with an address in the query', () => {
		const markdown = htmlToMarkdown('<a href="https://site.example/r?u=https://other.example/x">go</a>')
		expect(markdown.trim()).toBe('[go](https://site.example/r?u=https://other.example/x)')
		expect(spansIn(markdown).map(s => s.href)).toContain('https://site.example/r?u=https://other.example/x')
	})

	it('shows page text that was an address, escaped', () => {
		expect(htmlToMarkdown('<p>https://tracker.example/beacon.png</p>').trim())
			.toBe('https:\\/\\/tracker.example/beacon.png')
	})
})
