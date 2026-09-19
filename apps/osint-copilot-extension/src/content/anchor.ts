// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Finding a highlight again (PROTOCOL.md §8.4), in the text model of the page as it is now.
 *
 * In order, stopping at the first that works:
 *   1. the element path (RangeSelector), if the text there is still exactly the quote and
 *      the text around it still exactly the stored context;
 *   2. the stored position, likewise;
 *   3. every exact occurrence of the quote, ranked by how well the text around it matches
 *      the stored context, then by how close it is to where the hints point;
 *   4. an approximate match (approx-string-match, Myers' bit-parallel edit distance), for
 *      quotes long enough that one can mean anything, accepted only above a similarity
 *      threshold with its context recognisably the same, and marked fuzzy: the text has
 *      changed.
 *
 * The hints are not trusted on the quote alone. A repeated value ("Yes" in a table, a name
 * said twice) can sit at the stored place after the page changed, while the passage that
 * was highlighted has moved; the context is what tells them apart.
 *
 * A fuzzy match is shown as such and never rewrites the stored quote: what the vault
 * records is what the investigator selected, not what the page says now.
 */
import search from 'approx-string-match';
import type { HighlightSelectors, TextQuoteSelector } from '../shared/protocol';
import { elementTextStart, type TextModel } from './text-model';

export interface Anchored {
	start: number;
	end: number;
	fuzzy: boolean;
	/** 1 for an exact match; the similarity for a fuzzy one. */
	similarity: number;
}

/** Below this, an approximate match is more likely a different passage than an edited one. */
export const MIN_SIMILARITY = 0.8;
/**
 * Shorter quotes are never matched approximately. Up to 20% of a quote may differ, which
 * for a name of five letters is one letter anywhere on the page: "Smith" would land on the
 * "smith" of a smith's shop.
 */
export const FUZZY_MIN_QUOTE = 16;
/** An approximate match's context must be at least this much the stored one. */
export const FUZZY_MIN_CONTEXT = 0.5;
/** Quotes longer than this are not searched approximately: the cost grows with length. */
const FUZZY_MAX_QUOTE = 2000;
/** On a very long page, the approximate search looks this far either side of the old position. */
const FUZZY_WINDOW = 100_000;
/** More exact occurrences than this are not worth ranking: the context decides among the first. */
const MAX_OCCURRENCES = 1000;
/**
 * How much nearness to the hints counts against the context: only as a tie-break. Any real
 * difference in context outweighs any difference in distance, because the hints are exactly
 * what goes stale when a page changes around a repeated quote.
 */
const PROXIMITY_WEIGHT = 0.01;

function commonSuffix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

function commonPrefix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

/** How well the text around [start, end) matches the stored context: 0 to 1. */
function contextScore(text: string, start: number, end: number, quote: TextQuoteSelector): number {
	const before = text.slice(Math.max(0, start - quote.prefix.length), start);
	const after = text.slice(end, end + quote.suffix.length);
	const p = quote.prefix.length ? commonSuffix(before, quote.prefix) / quote.prefix.length : 1;
	const s = quote.suffix.length ? commonPrefix(after, quote.suffix) / quote.suffix.length : 1;
	return (p + s) / 2;
}

function proximity(at: number, hint: number, length: number): number {
	return 1 - Math.min(Math.abs(at - hint) / Math.max(length, 1), 1);
}

function byXPath(model: TextModel, selectors: HighlightSelectors): [number, number] | null {
	const range = selectors[2];
	if (!range) return null;
	const doc = model.root.ownerDocument;
	const find = (path: string): Element | null => {
		try {
			const node = doc.evaluate(path, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
			return node instanceof Element ? node : null;
		} catch {
			return null;
		}
	};
	const startEl = find(range.startSelector.value);
	const endEl = find(range.endSelector.value);
	if (!startEl || !endEl) return null;
	const startBase = elementTextStart(model, startEl);
	const endBase = elementTextStart(model, endEl);
	if (startBase === null || endBase === null) return null;
	return [startBase + range.startSelector.refinedBy.start, endBase + range.endSelector.refinedBy.start];
}

export function anchor(model: TextModel, selectors: HighlightSelectors): Anchored | null {
	const [quote, position] = selectors;
	const { exact } = quote;
	const text = model.text;
	const exactAt = (start: number, end: number) => end - start === exact.length && text.slice(start, end) === exact;

	// A hint is taken as it is only where the quote AND all of its context still match.
	const viaPath = byXPath(model, selectors);
	const exactWithContext = (start: number, end: number) => exactAt(start, end) && contextScore(text, start, end, quote) === 1;
	if (viaPath && exactWithContext(viaPath[0], viaPath[1])) return { start: viaPath[0], end: viaPath[1], fuzzy: false, similarity: 1 };
	if (exactWithContext(position.start, position.end)) return { start: position.start, end: position.end, fuzzy: false, similarity: 1 };

	// Otherwise the hints only say where to look first: ties in context go to the nearest.
	const hint = viaPath && exactAt(viaPath[0], viaPath[1]) ? viaPath[0] : position.start;
	let best: { at: number; score: number } | null = null;
	for (let i = text.indexOf(exact), n = 0; i >= 0 && n < MAX_OCCURRENCES; i = text.indexOf(exact, i + 1), n++) {
		const score = contextScore(text, i, i + exact.length, quote) + PROXIMITY_WEIGHT * proximity(i, hint, text.length);
		if (!best || score > best.score) best = { at: i, score };
	}
	if (best) return { start: best.at, end: best.at + exact.length, fuzzy: false, similarity: 1 };

	return fuzzy(model, quote, hint);
}

function fuzzy(model: TextModel, quote: TextQuoteSelector, hint: number): Anchored | null {
	const { exact } = quote;
	const maxErrors = Math.min(64, Math.floor(0.2 * exact.length));
	// A short quote could match too much, and a long one would take too long.
	if (exact.length < FUZZY_MIN_QUOTE || exact.length > FUZZY_MAX_QUOTE) return null;
	const text = model.text;
	const from = text.length > 2 * FUZZY_WINDOW ? Math.max(0, hint - FUZZY_WINDOW) : 0;
	const to = text.length > 2 * FUZZY_WINDOW ? Math.min(text.length, hint + FUZZY_WINDOW) : text.length;
	const matches = search(text.slice(from, to), exact, maxErrors);

	let best: (Anchored & { score: number }) | null = null;
	for (const m of matches) {
		const start = from + m.start;
		const end = from + m.end;
		const similarity = 1 - m.errors / exact.length;
		if (similarity < MIN_SIMILARITY) continue;
		// The text around it must be recognisably the same passage, not just similar words.
		const context = contextScore(text, start, end, quote);
		if (context < FUZZY_MIN_CONTEXT) continue;
		const score = 3 * similarity + context + PROXIMITY_WEIGHT * proximity(start, hint, text.length);
		if (!best || score > best.score) best = { start, end, fuzzy: true, similarity, score };
	}
	if (!best) return null;
	return { start: best.start, end: best.end, fuzzy: true, similarity: best.similarity };
}
