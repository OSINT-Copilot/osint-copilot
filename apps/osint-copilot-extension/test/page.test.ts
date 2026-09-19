// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeRange } from '../src/content/describe';
import { DEBOUNCE_MS, MAX_DELAY_MS, PageHighlights, RETRY_MS, hidesText } from '../src/content/page';
import { Painter, type HighlightApi } from '../src/content/render';
import { buildTextModel, rangeFromOffsets } from '../src/content/text-model';
import type { ContentHighlight, ContentReady, ContentRequest } from '../src/shared/highlights';

const anchorCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/content/anchor', async (original) => {
	const real = await original<typeof import('../src/content/anchor')>();
	return { ...real, anchor: (...args: Parameters<typeof real.anchor>) => (anchorCalls.n++, real.anchor(...args)) };
});

/** CSS.highlights as a page sees it: a map of names to sets of ranges, which it may change. */
class FakeHighlight extends Set<Range> {}

function fakeApi() {
	const registry = new Map<string, FakeHighlight>();
	const api = { registry, create: () => new FakeHighlight() } as unknown as HighlightApi;
	return { api, registry };
}

function highlightOf(phrase: string, id: string, occurrence = 0): ContentHighlight {
	const model = buildTextModel(document.body);
	let at = -1;
	for (let i = 0; i <= occurrence; i++) at = model.text.indexOf(phrase, at + 1);
	const d = describeRange(model, rangeFromOffsets(model, at, at + phrase.length)!);
	if (!d.ok) throw new Error(d.reason);
	return { id, selectors: d.selectors };
}

function harness(replies: Array<ContentReady | Promise<ContentReady>> = []) {
	const { api, registry } = fakeApi();
	const painter = new Painter(api);
	const sent: ContentRequest[] = [];
	const timers: Array<{ run: () => void; ms: number }> = [];
	let clock = 1_000_000;
	const page = new PageHighlights({
		document,
		painter,
		send: async (message) => {
			sent.push(message);
			if (message.type === 'content.ready') return replies.shift() ?? { highlights: [] };
			return { ok: true };
		},
		now: () => clock,
		later: (run, ms) => { timers.push({ run, ms }); },
	});
	const reportMessages = () => sent.filter((m): m is Extract<ContentRequest, { type: 'content.report' }> => m.type === 'content.report');
	const reports = () => reportMessages().map((m) => m.statuses);
	/** Runs what page changes scheduled, as the debounce timer would. */
	const settle = () => {
		for (let t = timers.shift(); t; t = timers.shift()) t.run();
	};
	const painted = () => [...(registry.values())].flatMap((h) => [...h].map((r) => r.toString()));
	return { page, painter, registry, sent, timers, reports, reportMessages, settle, painted, tick: (ms: number) => { clock += ms; } };
}

beforeEach(() => {
	anchorCalls.n = 0;
	// jsdom has no layout, so no scrolling.
	Element.prototype.scrollIntoView ??= () => {};
	history.replaceState(null, '', '/article');
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the painter', () => {
	it('puts back one of our ranges a page swapped for its own, though the count is the same', () => {
		document.body.innerHTML = '<p>Alice paid Bob</p>';
		const { api, registry } = fakeApi();
		const p = new Painter(api);
		const ours = rangeFromOffsets(buildTextModel(document.body), 0, 5)!;
		p.update([{ id: 'a', range: ours, fuzzy: false }]);
		const h = registry.get(p.names.exact)!;
		h.delete(ours);
		h.add(document.createRange());
		p.ensureRegistered();
		expect(h.has(ours)).toBe(true);
		expect(h.size).toBe(1);
	});

	it('redraws once for a batch', () => {
		document.body.innerHTML = '<p>one two three</p>';
		const { api, registry } = fakeApi();
		const p = new Painter(api);
		const model = buildTextModel(document.body);
		p.update([{ id: 'old', range: rangeFromOffsets(model, 0, 3)!, fuzzy: false }]);
		const clear = vi.spyOn(FakeHighlight.prototype, 'clear');
		p.update([
			{ id: 'a', range: rangeFromOffsets(model, 4, 7)!, fuzzy: false },
			{ id: 'b', range: rangeFromOffsets(model, 8, 13)!, fuzzy: true },
		], ['old']);
		// Each of the two highlights is cleared once and refilled.
		expect(clear).toHaveBeenCalledTimes(2);
		expect([...registry.get(p.names.exact)!].map(String)).toEqual(['two']);
		expect([...registry.get(p.names.fuzzy)!].map(String)).toEqual(['three']);
	});
});

describe('loading a page\'s highlights', () => {
	it('paints them and reports what was found', async () => {
		document.body.innerHTML = '<p>The handle darkfox99 posted twice.</p>';
		const h = harness([{ highlights: [highlightOf('darkfox99', 'a')] }]);
		await h.page.load();
		expect(h.painted()).toEqual(['darkfox99']);
		expect(h.reports()).toEqual([[{ id: 'a', status: 'exact' }]]);
	});

	it('keeps the newest load\'s answer when an older one arrives after it', async () => {
		document.body.innerHTML = '<p>alpha beta</p>';
		let answerFirst!: (v: { highlights: ContentHighlight[] }) => void;
		const first = new Promise<{ highlights: ContentHighlight[] }>((resolve) => { answerFirst = resolve; });
		const h = harness([first, { highlights: [highlightOf('beta', 'new')] }]);
		const older = h.page.load();
		await h.page.load();
		answerFirst({ highlights: [highlightOf('alpha', 'old')] });
		await older;
		expect(h.painted()).toEqual(['beta']);
		expect(h.reports()).toEqual([[{ id: 'new', status: 'exact' }]]);
	});

	it('keeps a highlight made while the page\'s first answer was on its way', async () => {
		document.body.innerHTML = '<p>alpha beta</p>';
		let answer!: (v: ContentReady) => void;
		const h = harness([new Promise((resolve) => { answer = resolve; })]);
		// Put into the page to make a highlight: it asks for the page's highlights as it starts.
		const loading = h.page.load();
		h.page.handle({ type: 'content.add', highlight: highlightOf('beta', 'new') });
		// The answer was read before the new one was stored.
		answer({ highlights: [highlightOf('alpha', 'old')] });
		await loading;
		expect(h.painted().sort()).toEqual(['alpha', 'beta']);
		expect(h.reports().at(-1)).toEqual([{ id: 'old', status: 'exact' }, { id: 'new', status: 'exact' }]);
	});

	it('drops an answer for the page the tab has since navigated away from, and looks again', async () => {
		document.body.innerHTML = '<p>alpha beta</p>';
		let answer!: (v: { highlights: ContentHighlight[] }) => void;
		const h = harness([new Promise((resolve) => { answer = resolve; })]);
		const loading = h.page.load();
		history.pushState(null, '', '/other');
		h.page.check();
		answer({ highlights: [highlightOf('alpha', 'a')] });
		await loading;
		expect(h.painted()).toEqual([]);
		expect(h.sent.filter((m) => m.type === 'content.ready')).toHaveLength(2);
	});
});

describe('a single-page site', () => {
	it('shows nothing on an address the document was not loaded from, until the investigator asks', async () => {
		document.body.innerHTML = '<p>The handle darkfox99 posted twice.</p>';
		const h = harness([{ highlights: [], navigated: true }]);
		await h.page.load();
		expect(h.painted()).toEqual([]);
		expect(h.reportMessages().at(-1)).toMatchObject({ statuses: [], navigated: true });
		expect(h.page.handle({ type: 'content.status' })).toEqual({ statuses: [], navigated: true });

		const status = h.page.handle({ type: 'content.paint', highlights: [highlightOf('darkfox99', 'a')] });
		expect(status).toEqual({ statuses: [{ id: 'a', status: 'exact' }], navigated: false });
		expect(h.painted()).toEqual(['darkfox99']);
		expect(h.reportMessages().at(-1)).toMatchObject({ navigated: false });
	});

	it('keeps what the investigator asked for when an earlier load answers after it', async () => {
		document.body.innerHTML = '<p>alpha beta</p>';
		let answer!: (v: ContentReady) => void;
		const h = harness([new Promise((resolve) => { answer = resolve; })]);
		const loading = h.page.load();
		h.page.handle({ type: 'content.paint', highlights: [highlightOf('beta', 'asked')] });
		answer({ highlights: [highlightOf('alpha', 'old')] });
		await loading;
		expect(h.painted()).toEqual(['beta']);
	});

	it('asks again after moving its address, and shows what the answer allows', async () => {
		document.body.innerHTML = '<p>alpha beta</p>';
		const h = harness([{ highlights: [highlightOf('alpha', 'a')] }, { highlights: [], navigated: true }]);
		await h.page.load();
		history.pushState(null, '', '/article/2');
		h.page.changed();
		h.settle();
		await vi.waitFor(() => expect(h.reportMessages().at(-1)).toMatchObject({ navigated: true }));
		expect(h.painted()).toEqual([]);
	});
});

describe('finding highlights again as the page changes', () => {
	it('notices a mark whose text node the page replaced, though the range still has text', async () => {
		document.body.innerHTML = '<p><span id="a">ONE</span><span id="b">two</span></p>';
		const h = harness([{ highlights: [highlightOf('NEtw', 'x')] }]);
		await h.page.load();
		expect(h.painted()).toEqual(['NEtw']);
		// A framework re-render: the first node is replaced with new text of the same kind.
		const a = document.getElementById('a')!;
		a.replaceChild(document.createTextNode('ONE-NEW'), a.firstChild!);
		h.page.changed();
		h.settle();
		// "NEtw" is no longer on the page: its mark must not stretch over the new text.
		expect(h.painted()).toEqual([]);
		expect(h.reports().at(-1)).toEqual([{ id: 'x', status: 'orphan' }]);
	});

	it('re-places only the marks that were lost', async () => {
		document.body.innerHTML = '<p id="p1">first passage here</p><p id="p2">second passage here</p>';
		const h = harness([{ highlights: [highlightOf('first passage', 'a'), highlightOf('second passage', 'b')] }]);
		await h.page.load();
		anchorCalls.n = 0;
		document.getElementById('p2')!.firstChild!.replaceWith(document.createTextNode('second passage here, again'));
		h.page.changed();
		h.settle();
		expect(anchorCalls.n).toBe(1);
		expect(h.painted().sort()).toEqual(['first passage', 'second passage']);
		// Found again as before: nothing new for the panel.
		expect(h.reports()).toHaveLength(1);
	});

	it('still puts back a lost mark after the first minute, and says when it is gone', async () => {
		document.body.innerHTML = '<p id="p">a passage here</p>';
		const h = harness([{ highlights: [highlightOf('passage', 'a')] }]);
		await h.page.load();
		h.tick(RETRY_MS + 1);
		const p = document.getElementById('p')!;
		p.firstChild!.replaceWith(document.createTextNode('the passage here'));
		h.page.changed();
		h.settle();
		expect(h.painted()).toEqual(['passage']);
		p.firstChild!.replaceWith(document.createTextNode('nothing left'));
		h.page.changed();
		h.settle();
		expect(h.painted()).toEqual([]);
		expect(h.reports().at(-1)).toEqual([{ id: 'a', status: 'orphan' }]);
	});

	it('finds a highlight that arrives late, within the first minute', async () => {
		document.body.innerHTML = '<p>The handle darkfox99 posted twice.</p>';
		const late = highlightOf('darkfox99', 'a');
		document.body.innerHTML = '<p>loading</p>';
		const h = harness([{ highlights: [late] }]);
		await h.page.load();
		expect(h.reports()).toEqual([[{ id: 'a', status: 'orphan' }]]);
		document.body.innerHTML = '<p>The handle darkfox99 posted twice.</p>';
		h.page.changed();
		h.settle();
		expect(h.painted()).toEqual(['darkfox99']);
		expect(h.reports().at(-1)).toEqual([{ id: 'a', status: 'exact' }]);
	});

	it('does not search for one not found in text it already searched, and backs off', async () => {
		document.body.innerHTML = '<p>The handle darkfox99 posted twice.</p>';
		const gone = highlightOf('darkfox99', 'a');
		document.body.innerHTML = '<p>Nothing to see here.</p>';
		const h = harness([{ highlights: [gone] }]);
		await h.page.load();
		anchorCalls.n = 0;
		const delays: number[] = [];
		const look = () => {
			h.page.changed();
			delays.push(h.timers[0].ms);
			h.settle();
		};
		// Changes that leave the text as it was (an attribute, a node moved and put back).
		for (let i = 0; i < 3; i++) look();
		expect(anchorCalls.n).toBe(0);
		// New text: searched again.
		for (let i = 0; i < 5; i++) {
			document.body.append(document.createTextNode(` more ${i}`));
			look();
		}
		expect(anchorCalls.n).toBe(5);
		// Each look that finds nothing waits longer for the next, up to a limit.
		expect(delays[0]).toBe(DEBOUNCE_MS);
		expect(delays[1]).toBe(2 * DEBOUNCE_MS);
		expect(delays.every((d, i) => i === 0 || d >= delays[i - 1])).toBe(true);
		expect(delays.at(-1)).toBe(MAX_DELAY_MS);
		// Found: back to looking promptly.
		document.body.innerHTML = '<p>The handle darkfox99 posted twice.</p>';
		look();
		h.page.changed();
		expect(h.timers[0].ms).toBe(DEBOUNCE_MS);
	});

	it('stops searching for ones not found after the first minute', async () => {
		document.body.innerHTML = '<p>The handle darkfox99 posted twice.</p>';
		const gone = highlightOf('darkfox99', 'a');
		document.body.innerHTML = '<p>Nothing to see here.</p>';
		const h = harness([{ highlights: [gone] }]);
		await h.page.load();
		h.tick(RETRY_MS + 1);
		anchorCalls.n = 0;
		document.body.innerHTML = '<p>The handle darkfox99 posted twice.</p>';
		h.page.changed();
		h.settle();
		expect(anchorCalls.n).toBe(0);
		// Find again, from the panel, still works.
		expect(h.page.handle({ type: 'content.findAgain', id: 'a' })).toEqual({ status: 'exact' });
	});
});

describe('describing the selection', () => {
	function selectAll(): void {
		const range = document.createRange();
		range.selectNodeContents(document.body.firstElementChild!);
		document.getSelection()!.removeAllRanges();
		document.getSelection()!.addRange(range);
	}

	it('refuses a selection holding text the page hides', () => {
		document.body.innerHTML = '<p>Alice paid <span style="display:none">no money to </span>Bob</p>';
		selectAll();
		const h = harness();
		// jsdom has no layout, so it reads hidden text into the selection; Chrome leaves it out.
		vi.spyOn(Selection.prototype, 'toString').mockReturnValue('Alice paid Bob');
		expect(h.page.describeSelection()).toEqual({ ok: false, reason: 'hidden-text' });
	});

	it('takes a selection whose visible text is the quote, and says what was shown', () => {
		document.body.innerHTML = '<p>Alice paid Bob</p>';
		selectAll();
		const h = harness();
		expect(h.page.describeSelection()).toMatchObject({ ok: true, exact: 'Alice paid Bob', shown: 'Alice paid Bob' });
	});
});

describe('hidden text in a quote', () => {
	it('is text of the quote the shown selection does not have', () => {
		expect(hidesText('Alice paid no money to Bob', 'Alice paid Bob')).toBe(true);
		expect(hidesText('Alice paid Bob', 'Alice paid Bob')).toBe(false);
	});

	it('is not spacing, line breaks, case, soft hyphens, or extra shown text', () => {
		expect(hidesText('John SmithLondon', 'John Smith\nLondon')).toBe(false);
		expect(hidesText('Straße', 'STRASSE')).toBe(false);
		expect(hidesText('Ermittlungs­verfahren', 'Ermittlungsverfahren')).toBe(false);
		expect(hidesText('one two', '1. one\n2. two')).toBe(false);
	});
});
