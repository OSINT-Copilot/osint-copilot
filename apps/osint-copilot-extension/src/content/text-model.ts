// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Text model v1 (PROTOCOL.md §8.4): what a highlight's offsets count over.
 *
 * The data of the Text nodes under <body>, in document order, joined with nothing in
 * between, skipping any inside script, style, noscript, template, textarea and input,
 * with no whitespace normalisation. Offsets are UTF-16 code units of that string.
 *
 * Both ends of a highlight's life use this one definition: describing a selection when
 * the investigator makes the highlight, and finding it again on a later visit. Changing
 * it would move every stored offset, which is why it carries a version.
 */
export const TEXT_MODEL = 'v1';

/** Elements whose text is not page text a reader sees. Lower-case local names. */
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'input']);

export interface TextModel {
	root: Element;
	/** The Text nodes, in document order. */
	nodes: Text[];
	/** starts[i] is where nodes[i] begins in `text`. */
	starts: number[];
	text: string;
}

export function buildTextModel(root: Element): TextModel {
	const doc = root.ownerDocument;
	const nodes: Text[] = [];
	const starts: number[] = [];
	const parts: string[] = [];
	let at = 0;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (node.nodeType === Node.ELEMENT_NODE) {
				// REJECT skips the element's whole subtree; SKIP only the element itself.
				return SKIPPED.has((node as Element).localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node as Text;
		nodes.push(text);
		starts.push(at);
		parts.push(text.data);
		at += text.data.length;
	}
	return { root, nodes, starts, text: parts.join('') };
}

/** Index of the last node that starts at or before `offset`. */
function nodeIndexAt(model: TextModel, offset: number): number {
	let lo = 0;
	let hi = model.starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (model.starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * A DOM Range over text offsets [start, end), or null when the model cannot place them.
 * The start lands at the beginning of the first node holding that character, the end at
 * the end of the last, so a range never begins or ends on an empty node.
 */
export function rangeFromOffsets(model: TextModel, start: number, end: number): Range | null {
	if (start < 0 || end > model.text.length || start >= end || model.nodes.length === 0) return null;
	let si = nodeIndexAt(model, start);
	// Past empty nodes, and past a node that ends exactly at `start`.
	while (si < model.nodes.length && model.starts[si] + model.nodes[si].data.length <= start) si++;
	let ei = nodeIndexAt(model, end - 1);
	while (ei > 0 && model.nodes[ei].data.length === 0) ei--;
	if (si >= model.nodes.length || ei < si) return null;
	const range = model.root.ownerDocument.createRange();
	range.setStart(model.nodes[si], start - model.starts[si]);
	range.setEnd(model.nodes[ei], end - model.starts[ei]);
	return range;
}

/**
 * The text offset of a DOM boundary point. A point inside a Text node of the model maps
 * directly; any other point (an element and a child index, or a node the model skips)
 * maps to where the next model text begins: that is where a selection starting or ending
 * there begins or ends in the model's text.
 */
export function offsetOfPoint(model: TextModel, container: Node, offset: number): number {
	if (container.nodeType === Node.TEXT_NODE) {
		const i = model.nodes.indexOf(container as Text);
		if (i >= 0) return model.starts[i] + Math.min(offset, (container as Text).data.length);
	}
	const point = model.root.ownerDocument.createRange();
	point.setStart(container, offset);
	// The first model node at or after the point: comparePoint says where a node's start
	// lies relative to the (collapsed) range, and the nodes are in document order.
	let lo = 0;
	let hi = model.nodes.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (point.comparePoint(model.nodes[mid], 0) < 0) lo = mid + 1;
		else hi = mid;
	}
	return lo < model.nodes.length ? model.starts[lo] : model.text.length;
}

/** Where the model's text inside `element` begins, or null when it holds none. */
export function elementTextStart(model: TextModel, element: Element): number | null {
	const offset = offsetOfPoint(model, element, 0);
	const i = model.starts.indexOf(offset);
	// The first node at or after the element's start must be inside it, else it has none.
	for (let j = i; j >= 0 && j < model.nodes.length && model.starts[j] === offset; j++) {
		if (element.contains(model.nodes[j])) return offset;
	}
	return null;
}
