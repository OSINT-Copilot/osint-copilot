// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * A selection, described so it can be found again (PROTOCOL.md §8.4): the quote with 32
 * characters of context either side, its position in the text model, and, when every
 * element on the way down is a plain HTML element, an element path to each end.
 *
 * The quote is the part that must match later; the position and the path are hints that
 * make the common case (the page has not changed) fast.
 */
import { LIMITS, type HighlightSelectors, type RangeSelector, type XPathPoint } from '../shared/protocol';
import { elementTextStart, offsetOfPoint, type TextModel } from './text-model';

const XHTML = 'http://www.w3.org/1999/xhtml';
const XPATH_STEP = /^[A-Za-z][A-Za-z0-9._-]*$/;

export type Described =
	| { ok: true; selectors: HighlightSelectors; exact: string }
	| { ok: false; reason: 'empty' | 'too-long' };

/**
 * `/html[1]/body[1]/div[3]` for an element, or null when the path could not be followed
 * back: an element outside the HTML namespace (SVG, MathML) is not matched by an
 * unprefixed XPath name test, and a name the protocol's path grammar does not allow is
 * not written.
 */
export function xpathOf(element: Element): string | null {
	const steps: string[] = [];
	for (let el: Element | null = element; el; el = el.parentElement) {
		if (el.namespaceURI !== XHTML || !XPATH_STEP.test(el.localName)) return null;
		let n = 1;
		for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
			if (sib.localName === el.localName) n++;
		}
		steps.unshift(`/${el.localName}[${n}]`);
	}
	const path = steps.join('');
	return path.length <= LIMITS.xpath ? path : null;
}

/** The element whose text an offset is counted into, for the path hint. */
function hostElement(model: TextModel, offset: number, atEnd: boolean): Element | null {
	// The Text node holding the character just after (start) or just before (end) the offset.
	const target = atEnd ? offset - 1 : offset;
	for (let i = 0; i < model.nodes.length; i++) {
		const start = model.starts[i];
		const len = model.nodes[i].data.length;
		if (len > 0 && target >= start && target < start + len) return model.nodes[i].parentElement;
	}
	return null;
}

function point(model: TextModel, offset: number, atEnd: boolean): XPathPoint | null {
	const host = hostElement(model, offset, atEnd);
	if (!host) return null;
	const value = xpathOf(host);
	const base = elementTextStart(model, host);
	if (!value || base === null || offset < base) return null;
	const at = offset - base;
	return { type: 'XPathSelector', value, refinedBy: { type: 'TextPositionSelector', start: at, end: at } };
}

export function describeRange(model: TextModel, range: Range): Described {
	const start = offsetOfPoint(model, range.startContainer, range.startOffset);
	const end = offsetOfPoint(model, range.endContainer, range.endOffset);
	if (end <= start) return { ok: false, reason: 'empty' };
	const exact = model.text.slice(start, end);
	if (!exact.trim()) return { ok: false, reason: 'empty' };
	if (exact.length > LIMITS.quoteExact) return { ok: false, reason: 'too-long' };
	const quote = {
		type: 'TextQuoteSelector' as const,
		exact,
		prefix: model.text.slice(Math.max(0, start - LIMITS.quoteContext), start),
		suffix: model.text.slice(end, end + LIMITS.quoteContext),
	};
	const position = { type: 'TextPositionSelector' as const, start, end };
	const startPoint = point(model, start, false);
	const endPoint = point(model, end, true);
	if (!startPoint || !endPoint) return { ok: true, exact, selectors: [quote, position] };
	const rangeSelector: RangeSelector = { type: 'RangeSelector', startSelector: startPoint, endSelector: endPoint };
	return { ok: true, exact, selectors: [quote, position, rangeSelector] };
}
