// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Paints highlights with the CSS Custom Highlight API: Highlight objects over live DOM
 * Ranges, drawn by ::highlight() rules. Nothing is inserted into the page, so its scripts
 * see no new elements, its frameworks cannot break our marks or be broken by them, and a
 * copy of the page's text carries none of ours.
 *
 * Not invisible, though. The registry (CSS.highlights) belongs to the window, and the
 * page's own scripts share it: they can list it, read the ranges, and delete them. So the
 * names are random for each document, the painter re-registers what the page removed
 * (ensureRegistered, called on every mutation batch and visibility change), and what the
 * marks mean -- which highlight, its note -- lives only in this isolated world. What the
 * page shows is cosmetic; the investigation's record is in the vault.
 */

export interface PaintEntry {
	id: string;
	range: Range;
	fuzzy: boolean;
}

/** The two things the painter needs from the window, injectable for tests. */
export interface HighlightApi {
	registry: HighlightRegistry;
	create(): Highlight;
}

export function windowHighlightApi(win: Window & typeof globalThis): HighlightApi | null {
	if (!('highlights' in win.CSS) || typeof win.Highlight !== 'function') return null;
	return { registry: win.CSS.highlights, create: () => new win.Highlight() };
}

function randomName(random: () => number): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let s = 'oc-';
	for (let i = 0; i < 12; i++) s += alphabet[Math.floor(random() * alphabet.length)];
	return s;
}

export class Painter {
	/** The ::highlight() names; the service worker styles exactly these. */
	readonly names: { exact: string; fuzzy: string };
	private readonly exact: Highlight;
	private readonly fuzzy: Highlight;
	private readonly entries = new Map<string, PaintEntry>();

	constructor(private readonly api: HighlightApi, random: () => number = Math.random) {
		this.names = { exact: randomName(random), fuzzy: randomName(random) };
		this.exact = api.create();
		this.fuzzy = api.create();
	}

	/** Replaces everything painted with `entries`. */
	paint(entries: PaintEntry[]): void {
		this.entries.clear();
		for (const e of entries) this.entries.set(e.id, e);
		this.sync();
	}

	set(entry: PaintEntry): void {
		this.entries.set(entry.id, entry);
		this.sync();
	}

	remove(id: string): void {
		if (this.entries.delete(id)) this.sync();
	}

	clear(): void {
		this.entries.clear();
		this.exact.clear();
		this.fuzzy.clear();
		this.api.registry.delete(this.names.exact);
		this.api.registry.delete(this.names.fuzzy);
	}

	entry(id: string): PaintEntry | undefined {
		return this.entries.get(id);
	}

	/**
	 * Puts our highlights back if the page deleted, replaced or emptied them. Returns
	 * whether anything had to be restored.
	 */
	ensureRegistered(): boolean {
		let restored = false;
		const expected = (h: Highlight, fuzzy: boolean) => [...this.entries.values()].filter((e) => e.fuzzy === fuzzy).length === h.size;
		if (!expected(this.exact, false) || !expected(this.fuzzy, true)) {
			this.fill();
			restored = true;
		}
		for (const [name, highlight] of [[this.names.exact, this.exact], [this.names.fuzzy, this.fuzzy]] as const) {
			const wanted = highlight.size > 0;
			const present = this.api.registry.get(name) === highlight;
			if (wanted && !present) {
				this.api.registry.set(name, highlight);
				restored = true;
			} else if (!wanted && this.api.registry.has(name)) {
				this.api.registry.delete(name);
			}
		}
		return restored;
	}

	/** The highlight at a DOM point (from caretPositionFromPoint), if any. */
	idAt(node: Node, offset: number): string | null {
		for (const e of this.entries.values()) {
			try {
				if (e.range.isPointInRange(node, offset)) return e.id;
			} catch {
				// A point in another document, or a range the page detached: not ours.
			}
		}
		return null;
	}

	private fill(): void {
		this.exact.clear();
		this.fuzzy.clear();
		for (const e of this.entries.values()) (e.fuzzy ? this.fuzzy : this.exact).add(e.range);
	}

	private sync(): void {
		this.fill();
		this.ensureRegistered();
	}
}
