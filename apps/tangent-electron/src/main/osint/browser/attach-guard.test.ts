import { describe, it, expect, beforeEach } from 'vitest'
import {
	applyGuestPreferences,
	BROWSE_PARTITION_PREFIX,
	clearSessions,
	decideAttach,
	guardAttach,
	isBrowseUrlPermitted,
	registerSession,
	releaseSession,
} from './attach-guard'

beforeEach(() => clearSessions())

describe('which <webview> attaches are allowed', () => {
	it('refuses an attach with no session token', () => {
		expect(decideAttach({}).allowed).toBe(false)
		expect(decideAttach({ partition: '' }).allowed).toBe(false)
	})

	it('refuses a token main never issued', () => {
		// The renderer cannot mint one: this is what stops anything else in the window
		// from creating a guest, which is the whole basis for enabling webviewTag.
		expect(decideAttach({ partition: 'persist:whatever-i-like' }).allowed).toBe(false)
	})

	it('translates a known token into the partition main chose', () => {
		registerSession('tok-1', 'alpha')
		const decision = decideAttach({ partition: 'tok-1' })
		expect(decision.allowed).toBe(true)
		expect(decision.partition).toBe(`${BROWSE_PARTITION_PREFIX}alpha`)
	})

	it('stops honouring a released token', () => {
		registerSession('tok-1', 'alpha')
		releaseSession('tok-1')
		expect(decideAttach({ partition: 'tok-1' }).allowed).toBe(false)
	})

	it('permits only http and https as a starting address', () => {
		expect(isBrowseUrlPermitted(undefined)).toBe(true)
		expect(isBrowseUrlPermitted('about:blank')).toBe(true)
		expect(isBrowseUrlPermitted('https://example.com/')).toBe(true)
		expect(isBrowseUrlPermitted('http://example.com/')).toBe(true)

		// A guest pointed at file: would read the disk with the same-origin privileges of
		// a local page; data: and blob: are script-injection shapes.
		expect(isBrowseUrlPermitted('file:///etc/passwd')).toBe(false)
		expect(isBrowseUrlPermitted('data:text/html,<script>1</script>')).toBe(false)
		expect(isBrowseUrlPermitted('blob:https://example.com/x')).toBe(false)
		expect(isBrowseUrlPermitted('javascript:alert(1)')).toBe(false)
		expect(isBrowseUrlPermitted('not a url')).toBe(false)
	})

	it('refuses a valid token pointed at a scheme it may not open', () => {
		registerSession('tok-1', 'alpha')
		expect(decideAttach({ partition: 'tok-1', src: 'file:///etc/passwd' }).allowed).toBe(false)
	})
})

describe('what the guest ends up with, whatever it asked for', () => {
	it('overwrites the dangerous preferences rather than trusting inheritance', () => {
		// These are the values an attacker would want, and each is reachable from an
		// attribute on the element.
		const prefs: Record<string, unknown> = {
			preload: '/tmp/evil.js',
			nodeIntegration: true,
			nodeIntegrationInSubFrames: true,
			contextIsolation: false,
			sandbox: false,
			webSecurity: false,
			allowRunningInsecureContent: true,
		}
		applyGuestPreferences(prefs)

		expect(prefs.preload).toBeUndefined()
		expect(prefs.nodeIntegration).toBe(false)
		expect(prefs.nodeIntegrationInSubFrames).toBe(false)
		expect(prefs.contextIsolation).toBe(true)
		expect(prefs.sandbox).toBe(true)
		// Not inherited from the host at all -- Electron computes it from the
		// renderer-controlled `disablewebsecurity` attribute.
		expect(prefs.webSecurity).toBe(true)
		expect(prefs.allowRunningInsecureContent).toBe(false)
	})

	it('rewrites the live params on a permitted attach', () => {
		registerSession('tok-1', 'alpha')
		const params: Record<string, string> = {
			partition: 'tok-1',
			src: 'https://example.com/',
			preload: '/tmp/evil.js',
			disablewebsecurity: 'true',
		}
		const prefs: Record<string, unknown> = { sandbox: false }

		expect(guardAttach(params, prefs)).toBe(true)
		expect(params.partition).toBe(`${BROWSE_PARTITION_PREFIX}alpha`)
		expect(params.preload).toBeUndefined()
		expect(params.disablewebsecurity).toBe('')
		expect(prefs.sandbox).toBe(true)
	})

	it('leaves the params alone when it refuses, and says no', () => {
		const params: Record<string, string> = { partition: 'unknown', src: 'https://example.com/' }
		expect(guardAttach(params, {})).toBe(false)
		expect(params.partition).toBe('unknown')
	})
})
