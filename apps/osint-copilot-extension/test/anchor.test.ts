// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { describe, it, expect } from 'vitest';
import { buildTextModel, rangeFromOffsets, offsetOfPoint } from '../src/content/text-model';
import { describeRange, xpathOf } from '../src/content/describe';
import { anchor } from '../src/content/anchor';
import { validateManifest } from '../src/shared/validate';
import type { HighlightSelectors } from '../src/shared/protocol';

function page(html: string): void {
	document.body.innerHTML = html;
}

/** Selects `phrase` (its n-th occurrence) through the DOM, as a user's selection would. */
function select(phrase: string, occurrence = 0): Range {
	const model = buildTextModel(document.body);
	let at = -1;
	for (let i = 0; i <= occurrence; i++) at = model.text.indexOf(phrase, at + 1);
	if (at < 0) throw new Error(`"${phrase}" not on the page`);
	return rangeFromOffsets(model, at, at + phrase.length)!;
}

function describe_(phrase: string, occurrence = 0): HighlightSelectors {
	const d = describeRange(buildTextModel(document.body), select(phrase, occurrence));
	if (!d.ok) throw new Error(d.reason);
	return d.selectors;
}

function found(selectors: HighlightSelectors): string | null {
	const model = buildTextModel(document.body);
	const a = anchor(model, selectors);
	return a ? rangeFromOffsets(model, a.start, a.end)!.toString() : null;
}

describe('text model v1', () => {
	it('joins the text of the body in document order and skips what a reader does not see', () => {
		page('<p>one <b>two</b></p><script>var x = 1</script><style>p{}</style><template><p>t</p></template><noscript>n</noscript><textarea>ta</textarea><p>three</p>');
		expect(buildTextModel(document.body).text).toBe('one twothree');
	});

	it('maps a range to offsets and back, across element boundaries', () => {
		page('<p>alpha <i>beta</i> gamma</p>');
		const model = buildTextModel(document.body);
		const range = rangeFromOffsets(model, 3, 13)!;
		expect(range.toString()).toBe('ha beta ga');
		expect(offsetOfPoint(model, range.startContainer, range.startOffset)).toBe(3);
		expect(offsetOfPoint(model, range.endContainer, range.endOffset)).toBe(13);
	});

	it('maps a point between elements to where the next text begins', () => {
		page('<p>ab</p><p>cd</p>');
		const model = buildTextModel(document.body);
		expect(offsetOfPoint(model, document.body, 1)).toBe(2);
		expect(offsetOfPoint(model, document.body, 2)).toBe(4);
	});
});

describe('describing a selection', () => {
	it('records the quote, 32 characters of context each side, the position, and element paths', () => {
		page('<div><p>The quick brown fox jumps over the lazy dog.</p></div>');
		const [quote, position, range] = describe_('quick brown');
		expect(quote).toEqual({ type: 'TextQuoteSelector', exact: 'quick brown', prefix: 'The ', suffix: ' fox jumps over the lazy dog.' });
		expect(position).toEqual({ type: 'TextPositionSelector', start: 4, end: 15 });
		expect(range?.startSelector.value).toBe('/html[1]/body[1]/div[1]/p[1]');
		expect(range?.startSelector.refinedBy).toEqual({ type: 'TextPositionSelector', start: 4, end: 4 });
	});

	it('produces an annotation the app accepts', () => {
		page('<p>Contact: <b>alice@example.com</b> for details</p>');
		const selectors = describe_('alice@example.com for');
		const manifest = {
			v: 1, bundleId: '0b7e7c1e-3f7a-4c56-9a3e-2d4f5b6c7d8e', workspaceId: 'A'.repeat(22), kind: 'highlight',
			page: { url: 'https://example.com/x', title: '' }, clientTime: '2026-09-19T00:00:00.000Z',
			highlight: { annotation: {
				id: 'urn:uuid:5f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f60', textModel: 'v1',
				created: '2026-09-19T00:00:00.000Z', modified: '2026-09-19T00:00:00.000Z',
				target: { source: 'https://example.com/x', selector: selectors },
			} },
		};
		expect(validateManifest(manifest)).toMatchObject({ ok: true });
	});

	it('writes no path through an SVG element, and refuses an empty selection', () => {
		page('<svg><text>in svg</text></svg><p>after</p>');
		const svgText = document.querySelector('text')!;
		expect(xpathOf(svgText)).toBeNull();
		const model = buildTextModel(document.body);
		const empty = document.createRange();
		empty.setStart(document.body, 0);
		expect(describeRange(model, empty)).toEqual({ ok: false, reason: 'empty' });
	});
});

describe('finding a highlight again', () => {
	const article = '<article><h1>Report</h1><p>The suspect used the handle darkfox99 on two forums.</p><p>Payments went to a wallet.</p></article>';

	it('finds it on the unchanged page', () => {
		page(article);
		const s = describe_('handle darkfox99');
		expect(found(s)).toBe('handle darkfox99');
	});

	it('finds it after text is inserted above it, by its quote and context', () => {
		page(article);
		const s = describe_('handle darkfox99');
		page(`<div>A new banner that shifts every offset on the page.</div>${article}`);
		const model = buildTextModel(document.body);
		const a = anchor(model, s)!;
		expect(a.fuzzy).toBe(false);
		expect(model.text.slice(a.start, a.end)).toBe('handle darkfox99');
	});

	it('picks the right one of a repeated quote by its context', () => {
		page('<p>First mention: the wallet was empty.</p><p>Second mention: the wallet was drained yesterday.</p>');
		const s = describe_('the wallet was', 1);
		page('<p>Intro.</p><p>First mention: the wallet was empty.</p><p>Second mention: the wallet was drained yesterday.</p>');
		const model = buildTextModel(document.body);
		const a = anchor(model, s)!;
		expect(model.text.slice(a.end, a.end + 8)).toBe(' drained');
	});

	it('marks an edited quote fuzzy, and never matches it exactly', () => {
		page('<p>Funds were moved to an account at First Metro Bank on 3 March 2024.</p>');
		const s = describe_('an account at First Metro Bank on 3 March');
		page('<p>Funds were moved to an account at First Metro Bnak on 3 March 2024.</p>');
		const a = anchor(buildTextModel(document.body), s)!;
		expect(a.fuzzy).toBe(true);
		expect(a.similarity).toBeGreaterThanOrEqual(0.8);
	});

	it('finds nothing when the passage is gone, rather than something unrelated', () => {
		page(article);
		const s = describe_('handle darkfox99 on two forums');
		page('<article><h1>Report</h1><p>This section was removed by the site.</p></article>');
		expect(found(s)).toBeNull();
	});

	it('the element path alone decides between identical quotes with no context', () => {
		page('<p>dup</p><p>filler</p><p>dup</p>');
		// Built by hand: no context, and a stale position that favours the first "dup".
		const selectors: HighlightSelectors = [
			{ type: 'TextQuoteSelector', exact: 'dup', prefix: '', suffix: '' },
			{ type: 'TextPositionSelector', start: 1, end: 4 },
			{
				type: 'RangeSelector',
				startSelector: { type: 'XPathSelector', value: '/html[1]/body[1]/p[3]', refinedBy: { type: 'TextPositionSelector', start: 0, end: 0 } },
				endSelector: { type: 'XPathSelector', value: '/html[1]/body[1]/p[3]', refinedBy: { type: 'TextPositionSelector', start: 3, end: 3 } },
			},
		];
		const a = anchor(buildTextModel(document.body), selectors)!;
		expect(a.start).toBe(9);
		// Without the path, proximity picks the first one: the path is what decided.
		expect(anchor(buildTextModel(document.body), [selectors[0], selectors[1]])!.start).toBe(0);
	});

	it('does not take a repeated value at the old place when the highlighted one has moved', () => {
		const table = (rows: string[][]) => `<table>${rows.map(([n, v]) => `<tr><td>${n}</td><td>${v}</td></tr>`).join('')}</table>`;
		page(table([['Alice', 'Yes'], ['Bob', 'No'], ['Carol', 'Yes']]));
		const s = describe_('Yes', 1);
		// A row above, and Bob's answer changed: Bob's "Yes" now sits where Carol's was.
		page(table([['Dave', 'No'], ['Alice', 'Yes'], ['Bob', 'Yes'], ['Carol', 'Yes']]));
		const model = buildTextModel(document.body);
		const a = anchor(model, s)!;
		expect(model.text.slice(a.start - 5, a.start)).toBe('Carol');
	});

	it('does not take the right words at the stored position in the wrong sentence', () => {
		page('<p>Witness: Mary. Suspect: John.</p>');
		const s = describe_('Mary');
		page('<p>Suspect: Mary. Witness: Mary.</p>');
		const model = buildTextModel(document.body);
		const a = anchor(model, s)!;
		expect(model.text.slice(a.start - 9, a.start)).toBe('Witness: ');
	});

	it('never matches a short quote approximately: a vanished name is not found in a similar word', () => {
		page('<p>Contact Smith at the office.</p>');
		const s = describe_('Smith');
		page('<p>Contact us at the office. The smith shop is closed.</p>');
		expect(anchor(buildTextModel(document.body), s)).toBeNull();
	});

	it('does not match approximately in an unrelated passage', () => {
		page('<p>Invoice 4471: payment routed via Brightwater Holdings Ltd in March.</p>');
		const s = describe_('payment routed via Brightwater Holdings');
		// Similar words, but nothing around them is the passage that was highlighted.
		page('<p>Unrelated article. Comment: a payment routed via Brightwater Holding was rumoured, nobody knows.</p>');
		expect(anchor(buildTextModel(document.body), s)).toBeNull();
	});

	it('uses the element path when the page has only changed elsewhere', () => {
		page('<p>aaa</p><p>target text here</p>');
		const s = describe_('target text');
		// Same structure, the stored position is now wrong, and the quote occurs twice:
		// only the path (and context) can pick the right one.
		page('<p>aaa target text x</p><p>target text here</p>');
		const model = buildTextModel(document.body);
		const a = anchor(model, s)!;
		const r = rangeFromOffsets(model, a.start, a.end)!;
		expect(r.startContainer.parentElement?.textContent).toBe('target text here');
	});
});
