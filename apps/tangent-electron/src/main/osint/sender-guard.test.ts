import { describe, it, expect, beforeEach } from 'vitest'
import {
	assertTrustedSender,
	isTrustedSender,
	SenderNotPermittedError,
	setApplicationWindowPredicate,
} from './sender-guard'

/** Stand-ins for WebContents; identity is all the policy uses. */
const appWindow = { id: 1 }
const guest = { id: 2 }

const topFrame = { parent: null }
const subFrame = { parent: topFrame }

beforeEach(() => {
	setApplicationWindowPredicate(contents => contents === appWindow)
})

describe('sender guard', () => {
	it('admits the top frame of an application window', () => {
		expect(isTrustedSender({ sender: appWindow, senderFrame: topFrame })).toBe(true)
	})

	it('refuses a webContents main did not create for a window', () => {
		// A <webview> guest is its own webContents, and its top frame has no parent --
		// so the frame check alone would pass it. This is the check that stops it.
		expect(isTrustedSender({ sender: guest, senderFrame: topFrame })).toBe(false)
	})

	it('refuses a subframe of an application window', () => {
		// Same webContents as the app, so the window check alone would pass it.
		expect(isTrustedSender({ sender: appWindow, senderFrame: subFrame })).toBe(false)
	})

	it('refuses a message whose frame has gone away', () => {
		expect(isTrustedSender({ sender: appWindow, senderFrame: null })).toBe(false)
		expect(isTrustedSender({ sender: appWindow })).toBe(false)
	})

	it('refuses everything when the predicate was never wired up', () => {
		// If the wiring is ever dropped, the channels must go silent, not open.
		setApplicationWindowPredicate(() => false)
		expect(isTrustedSender({ sender: appWindow, senderFrame: topFrame })).toBe(false)
	})

	it('names the channel in the refusal, and throws a typed error', () => {
		expect(() => assertTrustedSender('osint:cli.exec', { sender: guest, senderFrame: topFrame }))
			.toThrow(SenderNotPermittedError)
		expect(() => assertTrustedSender('osint:cli.exec', { sender: guest, senderFrame: topFrame }))
			.toThrow(/osint:cli\.exec/)
	})

	it('lets a permitted sender through assertTrustedSender', () => {
		expect(() => assertTrustedSender('osint:vault.write', { sender: appWindow, senderFrame: topFrame }))
			.not.toThrow()
	})
})
