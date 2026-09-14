/**
 * Selectors: the strings and patterns an investigation is watching for.
 *
 * Hunchly's defining feature, and the cheapest version of entity extraction that actually
 * works: the analyst says what matters once, and every page they look at is checked
 * against it. It turns a pile of captures into an investigation.
 *
 * Two safety properties are decided here rather than at the call site, because both are
 * easy to get wrong once and never notice:
 *
 *  - Patterns are user-authored and run against attacker-controlled text. A regex with
 *    catastrophic backtracking is a hang, and V8 has no way to time a RegExp out. The
 *    matcher therefore runs somewhere killable (see selector-host.ts) and this module
 *    caps what it is handed.
 *  - A match is a PROPOSAL. Nothing here writes to the graph. A page can contain anything,
 *    including text chosen to make a plausible-looking entity appear in someone's case.
 *
 * Electron-free and Node-free, so the rules are testable and so the same file can be
 * loaded inside the worker.
 */

export const SELECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Past this, the text is truncated rather than refused: a huge page still has a top. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Per selector. A pattern matching every character would otherwise produce a hit per byte. */
export const MAX_HITS_PER_SELECTOR = 200

/** Characters either side of a hit, so the analyst can judge it without opening the page. */
export const CONTEXT_RADIUS = 60

export interface Selector {
	id: string
	label: string
	kind: 'text' | 'regex'
	pattern: string
	/** Regex flags, minus `g` which is always applied. `u` and `y` are refused. */
	flags: string
	/** Suggested entity type when a hit is promoted. Free-form; the graph validates it. */
	entityType?: string
	enabled: boolean
}

export interface SelectorHit {
	selectorId: string
	label: string
	/** The matched text, capped so a pathological pattern cannot return the whole page. */
	match: string
	index: number
	context: string
	entityType?: string
}

/**
 * Flags a selector may carry.
 *
 * `g` is applied unconditionally by the matcher, so accepting it here too would let a
 * user set `lastIndex` semantics we then fight. `y` (sticky) makes a pattern match only at
 * a fixed offset, which is never what a watchlist wants and reads as a silent no-op.
 */
const PERMITTED_FLAGS = ['i', 'm', 's']

export function normaliseSelector(raw: unknown): Selector | null {
	if (!raw || typeof raw !== 'object') return null
	const record = raw as Record<string, unknown>

	const id = typeof record.id === 'string' ? record.id.trim().toLowerCase() : ''
	if (!SELECTOR_ID_PATTERN.test(id)) return null

	const pattern = typeof record.pattern === 'string' ? record.pattern : ''
	if (!pattern.trim()) return null

	const kind = record.kind === 'regex' ? 'regex' : 'text'
	const flags = typeof record.flags === 'string'
		? Array.from(new Set(record.flags.split(''))).filter(f => PERMITTED_FLAGS.includes(f)).join('')
		: ''

	// A regex that will not compile is dropped here rather than throwing inside the
	// matcher, where the failure would look like a hung scan.
	if (kind === 'regex') {
		try {
			new RegExp(pattern, flags + 'g')
		}
		catch {
			return null
		}
	}

	return {
		id,
		label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id,
		kind,
		pattern,
		flags,
		entityType: typeof record.entityType === 'string' && record.entityType.trim()
			? record.entityType.trim()
			: undefined,
		enabled: record.enabled !== false,
	}
}

export function parseSelectors(text: string | null): Selector[] {
	if (!text) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	}
	catch {
		return []
	}
	const list = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as Record<string, unknown>)?.selectors)
			? (parsed as { selectors: unknown[] }).selectors
			: []

	const selectors: Selector[] = []
	const seen = new Set<string>()
	for (const entry of list) {
		const selector = normaliseSelector(entry)
		if (!selector || seen.has(selector.id)) continue
		seen.add(selector.id)
		selectors.push(selector)
	}
	return selectors
}

/** Escapes a literal so a text selector cannot smuggle regex syntax. */
export function escapeLiteral(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compile(selector: Selector): RegExp {
	const source = selector.kind === 'regex' ? selector.pattern : escapeLiteral(selector.pattern)
	// Text selectors are case-insensitive by default: nobody writing a watchlist means
	// "this name, but only in this capitalisation".
	const flags = selector.kind === 'regex' ? selector.flags : (selector.flags.includes('i') ? selector.flags : selector.flags + 'i')
	return new RegExp(source, flags + 'g')
}

export function contextAround(text: string, index: number, length: number): string {
	const start = Math.max(0, index - CONTEXT_RADIUS)
	const end = Math.min(text.length, index + length + CONTEXT_RADIUS)
	return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim()
		+ (end < text.length ? '…' : '')
}

/**
 * Runs one selector over the text.
 *
 * Exported so both the worker and its tests use the same code -- a matcher that behaves
 * differently in the worker than in a test is worse than no test.
 */
export function matchOne(selector: Selector, text: string): SelectorHit[] {
	const hits: SelectorHit[] = []
	const expression = compile(selector)
	let match: RegExpExecArray | null

	while ((match = expression.exec(text)) !== null) {
		// A pattern that can match the empty string would otherwise never advance.
		if (match[0] === '') {
			expression.lastIndex += 1
			continue
		}
		hits.push({
			selectorId: selector.id,
			label: selector.label,
			match: match[0].slice(0, 200),
			index: match.index,
			context: contextAround(text, match.index, match[0].length),
			entityType: selector.entityType,
		})
		if (hits.length >= MAX_HITS_PER_SELECTOR) break
	}
	return hits
}

export function capText(text: string): string {
	return text.length > MAX_TEXT_BYTES ? text.slice(0, MAX_TEXT_BYTES) : text
}
