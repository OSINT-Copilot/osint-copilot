import { describe, it, expect } from 'vitest'

import * as parser from './parser'
import { extendFocusedLines, lineContinuesParagraphFocus } from './line'
import { buildOpsFromInsertList } from 'common/typewriterUtils'

const PUNCTUATION_ATTRIBUTES = {
	inline_code: 'html',
	code_syntax: 'punctuation'
}
const TAG_ATTRIBUTES = {
	inline_code: 'html',
	code_syntax: 'tag'
}

describe('Full parsing', () => {
	it('Should parse single inline elements', () => {
		const doc = parser.markdownToTextDocument(`This is my <a>Test</a> of html`)
		expect(doc.lines.length).toEqual(1)

		const line = doc.lines[0]
		expect(line.attributes.html).toBeTruthy()

		expect(line.content.ops).toEqual(buildOpsFromInsertList([
			'This is my ',
			'<', PUNCTUATION_ATTRIBUTES,
			'a', TAG_ATTRIBUTES,
			'>', PUNCTUATION_ATTRIBUTES,
			'Test', {
				inline_code: 'html'
			},
			'</', PUNCTUATION_ATTRIBUTES,
			'a', TAG_ATTRIBUTES,
			'>', PUNCTUATION_ATTRIBUTES,
			' of html'
		], true))
	})

	it('Should parse multi-line html', () => {
		const doc = parser.markdownToTextDocument(`I have some stuff here
It has <span>Some <strong>integrated</strong> html
that continues across <em>multiple</em> lines.
</span>. Pretty cool!
I think so.`)

		expect(doc.lines.length).toEqual(5)

		expect(doc.lines[0].attributes.html).toBeFalsy()
		expect(doc.lines[1].attributes.html).toBeTruthy()
		expect(doc.lines[2].attributes.html).toBeTruthy()
		expect(doc.lines[3].attributes.html).toBeTruthy()
		expect(doc.lines[4].attributes.html).toBeFalsy()

		expect(doc.lines[3].content.ops).toEqual(buildOpsFromInsertList([
			'</', PUNCTUATION_ATTRIBUTES,
			'span', TAG_ATTRIBUTES,
			'>', PUNCTUATION_ATTRIBUTES,
			'. Pretty cool!'
		], true))
	})
})

describe('Comments', () => {
	const COMMENT_ATTRIBUTES = {
		html_comment: true,
		hidden: true
	}

	function hasComment(line) {
		return line.content.ops.some(op => op.attributes?.html_comment)
	}

	it('Should hide a comment on its own line and mark the line', () => {
		const doc = parser.markdownToTextDocument(`<!-- oc:bundle 1234 -->`)
		expect(doc.lines.length).toEqual(1)

		const line = doc.lines[0]
		expect(line.content.ops).toEqual(buildOpsFromInsertList([
			'<!-- oc:bundle 1234 -->', COMMENT_ATTRIBUTES
		]))
		expect(line.attributes.commentLine).toBe(true)
		expect(line.attributes.html).toBeFalsy()
	})

	it('Should mark an indented comment line', () => {
		const doc = parser.markdownToTextDocument(`Before\n\t<!-- a comment -->  \nAfter`)
		expect(doc.lines.length).toEqual(3)

		const line = doc.lines[1]
		expect(line.content.ops).toEqual(buildOpsFromInsertList([
			'\t', { line_format: 'indent', hidden: true },
			'<!-- a comment -->', COMMENT_ATTRIBUTES,
			'  '
		], true))
		expect(line.attributes.commentLine).toBe(true)

		expect(doc.lines[0].attributes.commentLine).toBeFalsy()
		expect(doc.lines[2].attributes.commentLine).toBeFalsy()
	})

	it('Should hide an inline comment without marking the line', () => {
		const doc = parser.markdownToTextDocument(`a <!-- c --> b`)
		const line = doc.lines[0]
		expect(line.content.ops).toEqual(buildOpsFromInsertList([
			'a ',
			'<!-- c -->', COMMENT_ATTRIBUTES,
			' b'
		], true))
		expect(line.attributes.commentLine).toBeFalsy()

		const trailing = parser.markdownToTextDocument(`<!-- c --> b`)
		expect(hasComment(trailing.lines[0])).toBe(true)
		expect(trailing.lines[0].attributes.commentLine).toBeFalsy()
	})

	it('Should leave unclosed and multi-line comments as text', () => {
		for (const text of ['<!-- x', '<!-- x\n-->', '<!-->']) {
			const doc = parser.markdownToTextDocument(text)
			for (const line of doc.lines) {
				expect(hasComment(line)).toBe(false)
				expect(line.attributes.commentLine).toBeFalsy()
			}
		}
	})

	it('Should not find comments in code', () => {
		for (const text of ['`<!-- x -->`', '```\n<!-- x -->\n```']) {
			const doc = parser.markdownToTextDocument(text)
			for (const line of doc.lines) {
				expect(hasComment(line)).toBe(false)
				expect(line.attributes.commentLine).toBeFalsy()
			}
		}
	})

	it('Should not find links inside comments', () => {
		const doc = parser.markdownToTextDocument(`<!-- https://x.example -->`)
		const line = doc.lines[0]
		expect(line.content.ops).toEqual(buildOpsFromInsertList([
			'<!-- https://x.example -->', COMMENT_ATTRIBUTES
		]))
		expect(line.content.ops.some(op => op.attributes?.t_link)).toBe(false)
		expect(line.attributes.commentLine).toBe(true)
	})

	it('Should keep comment lines out of the focused paragraph', () => {
		const doc = parser.markdownToTextDocument(`Before\n<!-- oc:bundle 1 -->\nFirst line\nSecond line\n<!-- oc:bundle 2 -->\nAfter`)
		const text = (lines) => lines.map(line => doc.getText(doc.getLineRange(line)).trim())

		const focused = extendFocusedLines(doc, [doc.lines[2]], lineContinuesParagraphFocus)
		expect(text(focused)).toEqual(['First line', 'Second line'])

		// The caret on the comment line focuses that line alone
		const onComment = extendFocusedLines(doc, [doc.lines[1]], lineContinuesParagraphFocus)
		expect(onComment).toEqual([doc.lines[1]])
	})
})
