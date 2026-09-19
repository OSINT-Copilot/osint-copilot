/**
 * Runs derive-worker.ts in an Electron utility process, one process per archive.
 *
 * kill() is a real kill: a parser stuck in a regular expression or a turndown pass over a
 * pathological DOM cannot be interrupted any other way, and the deriver calls it at its
 * timeout. The process gets no arguments beyond the job, and the job is a path main chose
 * inside the bundle folder and the page URL from the MAC-verified manifest.
 *
 * Electron-only; imported by osint/index.ts, never by a test.
 */
import * as nodePath from 'path'
import { utilityProcess } from 'electron'
import type { ParseJob, ParseOutcome } from './derive'
import type { ParserProcess, ParserRunner } from './deriver'

/** webpack emits the worker beside the main bundle (see src/main/webpack.config.js). */
const WORKER_FILE = 'osint-capture-worker.js'

export function utilityParserRunner(): ParserRunner {
	const workerPath = nodePath.join(__dirname, WORKER_FILE)
	return (job: ParseJob): ParserProcess => {
		const child = utilityProcess.fork(workerPath, [], {
			serviceName: 'OSINT Copilot capture parser',
			stdio: 'ignore',
		})
		let settled = false
		const result = new Promise<ParseOutcome>(resolve => {
			const finish = (outcome: ParseOutcome) => {
				if (settled) return
				settled = true
				resolve(outcome)
				child.kill()
			}
			child.once('message', (message: ParseOutcome) => finish(
				message && typeof message === 'object' && typeof message.ok === 'boolean'
					? message
					: { ok: false, error: 'the parser sent something that is not a result' }))
			child.once('exit', code => finish({ ok: false, error: `the parser exited (${code}) without a result` }))
			child.once('spawn', () => child.postMessage(job))
		})
		return {
			result,
			kill: () => {
				if (!settled) child.kill()
			},
		}
	}
}
