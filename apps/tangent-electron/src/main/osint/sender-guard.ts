/**
 * Which frames may speak to the privileged `osint:*` channels.
 *
 * Every handler in index.ts is sender-agnostic: it answers whoever calls it. That is
 * safe only while the app has exactly one webContents and it is the one main created.
 * The moment a second webContents exists that renders content main did not author — a
 * `<webview>` guest showing a live website, say — "whoever calls it" stops being a
 * trustworthy set.
 *
 * It matters more than it looks, because the privileged surface composes into a chain:
 * `osint:vault.write` may write `<workspace>/.osint-copilot/data.json` (it is inside the
 * vault root, and exec-guard.ts reads `customAgentRuntimes[].cliPath` back out of it on
 * every exec), and `osint:cli.exec` will then run what that file names. Neither half is
 * a bug on its own; together they are arbitrary code execution for anyone who can reach
 * the channels. This module is the thing that decides who can.
 *
 * The rule: the sender must be the **top frame** of a webContents main itself created
 * for an application window. Subframes are refused because nothing legitimate speaks
 * from one — `nodeIntegrationInSubFrames` is off, so an iframe has no preload and no
 * ipcRenderer at all — and guests are refused because they are not application windows.
 *
 * Electron-free by design, like exec-guard.ts beside it: the window registry is injected,
 * so the policy is unit-testable without booting an app.
 */
import Logger from 'js-logger'

export class SenderNotPermittedError extends Error {}

/**
 * Answers "did main create this webContents for an application window?".
 *
 * Injected rather than importing main/workspaces, so this module stays free of Electron
 * and of OSINT Copilot's workspace bookkeeping. Defaults to refusing everything: if the wiring
 * is ever dropped, the channels go silent rather than open.
 */
let isApplicationWindow: (contents: unknown) => boolean = () => false

export function setApplicationWindowPredicate(predicate: (contents: unknown) => boolean): void {
	isApplicationWindow = predicate
}

/** The parts of an IpcMain event this policy reads. Structural, so tests need no Electron. */
export interface SenderIdentity {
	sender: unknown
	/** Null once the frame has gone away; Electron documents this as possible. */
	senderFrame?: { parent: unknown | null } | null
}

export function isTrustedSender(event: SenderIdentity): boolean {
	const frame = event.senderFrame
	// A message that outlived its frame cannot be attributed to anything. Refuse it.
	if (!frame) return false
	// Top frame only. `parent` is null exactly for the top frame of a webContents.
	if (frame.parent !== null && frame.parent !== undefined) return false
	return isApplicationWindow(event.sender)
}

/**
 * Throws unless the event came from an application window's top frame.
 *
 * Named after the channel so a refusal in the log says which capability was reached for.
 */
export function assertTrustedSender(channel: string, event: SenderIdentity): void {
	if (isTrustedSender(event)) return
	Logger.warn(`[osint] refused ${channel}: sender is not an application window's top frame`)
	throw new SenderNotPermittedError(
		`Refusing ${channel}: only the application window may use this channel.`)
}
