/**
 * The only way an `osint:*` channel should be registered.
 *
 * Registering with `ipcMain` directly would opt a channel out of the sender check
 * silently, and the check is what stops a webContents rendering hostile content from
 * reaching capabilities that compose into code execution. See sender-guard.ts.
 */
import { ipcMain } from 'electron'

import { assertTrustedSender } from './sender-guard'

/**
 * Deliberately does NOT import main/workspaces to wire the window predicate up itself.
 * This file is inside `typecheck:osint`, and reaching into OSINT Copilot's tree pulls common/
 * in under strictNullChecks, where it reports errors in code the fork does not own --
 * which is why index.ts is in that config's `exclude` list. index.ts owns the wiring;
 * sender-guard refuses everything until it runs, so the failure mode is closed channels.
 */

/** `ipcMain.handle` with the sender check applied. */
export function handle(
	channel: string,
	listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any,
): void {
	ipcMain.handle(channel, (event, ...args) => {
		assertTrustedSender(channel, event)
		return listener(event, ...args)
	})
}

/**
 * `ipcMain.on` with the same check.
 *
 * Refusal sets `returnValue` before throwing: 'osint:platform' is delivered with
 * sendSync, and a sync send whose handler throws without setting it blocks the calling
 * renderer rather than erroring.
 */
export function on(
	channel: string,
	listener: (event: Electron.IpcMainEvent, ...args: any[]) => void,
): void {
	ipcMain.on(channel, (event, ...args) => {
		try {
			assertTrustedSender(channel, event)
		}
		catch (e) {
			event.returnValue = null
			throw e
		}
		listener(event, ...args)
	})
}
