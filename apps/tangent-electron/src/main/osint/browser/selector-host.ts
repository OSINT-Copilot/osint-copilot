/**
 * Running user-authored patterns over text from a page, without betting the app on them.
 *
 * A watchlist regex is written by the analyst and run against text chosen by whoever
 * controls the page. `(a+)+$` against the wrong input does not return; V8 offers no way to
 * time a RegExp out, and `exec` does not yield, so running it anywhere on the main thread
 * means the window stops responding with no way back.
 *
 * So it runs in a worker thread, which CAN be stopped: `terminate()` uses V8's
 * TerminateExecution and interrupts a spinning regex. The deadline names the pattern that
 * hung, because "a scan timed out" is not something an analyst can act on, and "the
 * selector called wallet-ish did not finish" is.
 *
 * (The plan said `utilityProcess`. A worker thread has the same property that matters --
 * a hard interrupt from outside -- and needs no second webpack entry, so the build stays
 * one bundle. The isolation being bought here is from a runaway loop, not from hostile
 * code: the patterns are the operator's own.)
 *
 * The worker is deliberately dumb. It is handed compiled `{source, flags}` and returns
 * offsets; every decision -- what a selector means, how to escape a literal, how much
 * context to show -- stays in selector-policy.ts where it is testable without threads.
 */
import { Worker } from 'worker_threads'
import Logger from 'js-logger'

import {
	capText, compile, contextAround, MAX_HITS_PER_SELECTOR,
	type Selector, type SelectorHit,
} from './selector-policy'

/** Long enough for a big page and a careless pattern; short enough to notice. */
export const SCAN_DEADLINE_MS = 5000

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads')
const { text, patterns } = workerData
const results = []
for (const pattern of patterns) {
	// Posted BEFORE the pattern runs, so if this one never returns the host still knows
	// which it was -- a message cannot be delivered from a thread that is spinning.
	parentPort.postMessage({ type: 'start', id: pattern.id })
	const expression = new RegExp(pattern.source, pattern.flags)
	const found = []
	let match
	while ((match = expression.exec(text)) !== null) {
		if (match[0] === '') { expression.lastIndex += 1; continue }
		found.push({ index: match.index, match: match[0].slice(0, 200) })
		if (found.length >= pattern.maxHits) break
	}
	results.push({ id: pattern.id, found })
}
parentPort.postMessage({ type: 'done', results })
`

export interface ScanResult {
	hits: SelectorHit[]
	/** Set when the scan was killed. Names the selector that did not finish. */
	timedOutOn?: string
}

export async function scan(
	selectors: Selector[],
	rawText: string,
	deadlineMs: number = SCAN_DEADLINE_MS,
): Promise<ScanResult> {
	const active = selectors.filter(selector => selector.enabled)
	if (!active.length || !rawText.trim()) return { hits: [] }

	const text = capText(rawText)
	const patterns = active.map(selector => {
		const expression = compile(selector)
		return {
			id: selector.id,
			source: expression.source,
			flags: expression.flags,
			maxHits: MAX_HITS_PER_SELECTOR,
		}
	})

	const byId = new Map(active.map(selector => [selector.id, selector]))

	return new Promise<ScanResult>((resolve) => {
		const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { text, patterns } })
		let running: string | undefined
		let settled = false

		const finish = (result: ScanResult) => {
			if (settled) return
			settled = true
			clearTimeout(deadline)
			void worker.terminate()
			resolve(result)
		}

		const deadline = setTimeout(() => {
			Logger.warn(`[osint] selector scan exceeded ${deadlineMs}ms on "${running}"`)
			finish({ hits: [], timedOutOn: running })
		}, deadlineMs)

		worker.on('message', (message: any) => {
			if (message?.type === 'start') {
				running = message.id
				return
			}
			if (message?.type !== 'done') return

			const hits: SelectorHit[] = []
			for (const result of message.results ?? []) {
				const selector = byId.get(result.id)
				if (!selector) continue
				for (const found of result.found ?? []) {
					hits.push({
						selectorId: selector.id,
						label: selector.label,
						match: found.match,
						index: found.index,
						// Built here rather than in the worker so the text never has to be
						// sent back, and so the context rule has one implementation.
						context: contextAround(text, found.index, found.match.length),
						entityType: selector.entityType,
					})
				}
			}
			finish({ hits })
		})

		worker.on('error', (error) => {
			Logger.warn('[osint] selector scan failed:', error)
			finish({ hits: [] })
		})

		worker.on('exit', () => finish({ hits: [] }))
	})
}
