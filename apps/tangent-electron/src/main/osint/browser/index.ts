/**
 * The browsing surface's privileged half.
 *
 * Registers on import from ../index.ts, like the rest of the OSINT main-process code.
 *
 * The shape to keep in mind: the renderer owns a `<webview>` element and nothing else.
 * It cannot choose the guest's preferences, its cookie jar, or what it may navigate to --
 * all three are decided here, because the renderer is the side that handles content from
 * the pages being investigated.
 */
import { randomUUID } from 'crypto'
import { app, session, webContents } from 'electron'
import Logger from 'js-logger'

import * as vaultFs from '../node/vault'
import { handle } from '../guarded-ipc'
import {
	guardAttach,
	isBrowseUrlPermitted,
	registerSession,
	releaseSession,
} from './attach-guard'
import { configureProfileSession, findProfile, loadProfiles, partitionFor } from './profiles'
import { interpret, REALITY_CHECK_SNIPPET, type RealitySignals } from './reality-check'
import { captureGuest } from './capture'
import { isWatching, loadSelectors, rescan, setWatching } from './selector-runtime'
import { parseCaptureIndex } from './capture-index'
import { CAPTURE_INDEX_PATH } from './capture'
import {
	armProfile, cancelCapture, captureBudgetBytes, forgetGuest, guestProfile, isArmed,
	partitionOwner, rememberGuest, rememberGuestHost, scheduleCapture, setCaptureBudgetBytes,
} from './capture-runtime'

/**
 * Installed on every webContents rather than in createWindow(), so a window added later
 * cannot come up without the guard. `will-attach-webview` fires on the *host*, which is
 * why this is the right hook.
 */
app.on('web-contents-created', (_event, contents) => {
	contents.on('will-attach-webview', (event, webPreferences, params) => {
		const partition = guardAttach(
			params as Record<string, string>, webPreferences as Record<string, unknown>)
		if (!partition) {
			event.preventDefault()
			return
		}
		// The load-bearing line. Electron resolves a guest's partition from the element's
		// own attribute, so rewriting params.partition alone leaves the guest in whatever
		// jar the renderer named -- which, with an opaque per-claim token there, meant a
		// fresh empty jar every mount and profiles that never persisted anything.
		// Handing over the Session object is what actually binds the guest to the profile.
		;(webPreferences as Record<string, unknown>).session = session.fromPartition(partition)
	})

	contents.on('did-attach-webview', (_e, guest) => hardenGuest(guest, contents))
})

/**
 * Everything a guest is not allowed to do, applied once it exists.
 *
 * Separate from the preferences overwrite because these are behaviours rather than
 * settings: they need the live webContents.
 */
function hardenGuest(guest: Electron.WebContents, host: Electron.WebContents): void {
	// A page may not navigate the guest anywhere the pane would not have taken it.
	guest.on('will-navigate', (event, url) => {
		if (!isBrowseUrlPermitted(url)) {
			Logger.warn('[osint] blocked a guest navigation to', url)
			event.preventDefault()
		}
	})

	// window.open and target=_blank. Handing these to the OS browser would silently move
	// the investigation out of the profile it belongs to, so they are refused for now;
	// Phase 5 routes them into a new pane inheriting this guest's profile instead.
	guest.setWindowOpenHandler(({ url }) => {
		Logger.info('[osint] refused a popup from a browsing guest:', url)
		return { action: 'deny' }
	})

	// App chords must not be swallowed by the page, and the page must not reach the
	// application menu's accelerators.
	guest.setIgnoreMenuShortcuts?.(true)

	// WebRTC will happily hand a page the machine's real local and public addresses over
	// UDP, going around any proxy the profile set -- the classic way a "proxied" browser
	// deanonymises its user. This is a WebContents method, not a session one, so it has to
	// be applied to every guest individually; it runs here because a pane mounts at
	// about:blank and its first real navigation comes later, through loadURL.
	guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

	// Where capture results are reported back to.
	rememberGuestHost(guest.id, host)

	// Downloads are not wired to anywhere yet; a silent write into the user's Downloads
	// folder from a page they are investigating is not a good default.
	guest.session.on('will-download', (event) => {
		Logger.info('[osint] blocked a download from a browsing guest')
		event.preventDefault()
	})

	// Capture triggers.
	//
	// NOT on navigation commit: MHTML serialises the CURRENT DOM, so a commit-time capture
	// records a near-empty document. And `did-navigate` is not emitted at all for in-page
	// navigation, which is how every large social site moves between profiles -- capturing
	// only on it would mean capturing nothing on exactly the sites that matter.
	guest.on('did-stop-loading', () => scheduleCapture(guest))
	guest.on('did-navigate-in-page', () => scheduleCapture(guest))
	guest.on('destroyed', () => { cancelCapture(guest.id); forgetGuest(guest.id) })

	// Keyboard events inside a guest never reach the host document, so while the page has
	// focus the app's own shortcuts are simply dead. Listeners cannot be attached to the
	// <webview> element either, so this is the only place to catch them.
	guest.on('before-input-event', (event, input) => {
		if (!isApplicationChord(input)) return
		event.preventDefault()
		host.send('osint:browse.shortcut', {
			key: input.key,
			code: input.code,
			control: input.control,
			meta: input.meta,
			alt: input.alt,
			shift: input.shift,
		})
	})
}

/**
 * Which chords are taken from the page and given back to the app.
 *
 * Deliberately narrow: Ctrl/Cmd **and** Alt together. That is the family the OSINT views
 * use (Mod+Alt+1..8) and essentially nothing a web page or a text field wants.
 *
 * The tempting rule -- forward every Ctrl/Cmd chord -- would break copy, paste,
 * select-all and find inside the page, which an investigator needs far more than they
 * need Mod+N to open a note while they are reading a profile. Claiming the rest properly
 * means consulting Tangent's shortcut registry, which lives in the renderer; until then,
 * taking less is the safer error.
 */
function isApplicationChord(input: Electron.Input): boolean {
	return input.type === 'keyDown' && (input.control || input.meta) && input.alt
}

/** The renderer asks for a session; it never learns the partition behind the token. */
handle('osint:browse.claim', async (_e, profileId: unknown) => {
	const profile = await findProfile(typeof profileId === 'string' ? profileId : 'default')
	// Before the token exists: a guest must never attach to a session whose proxy or
	// permissions have not been applied yet, and configureProfileSession throws rather
	// than degrading to a direct connection.
	await configureProfileSession(profile)
	const token = randomUUID()
	registerSession(token, partitionFor(profile.id))
	return { token, profile }
})

/** The profiles the operator has defined, for the pane's picker. */
handle('osint:browse.profiles', () => loadProfiles())

/**
 * Binds a guest to the profile whose session it was given.
 *
 * The renderer supplies its own session token rather than a profile name, so it cannot
 * claim a guest belongs to an identity it never claimed: the token is main-issued and is
 * resolved here through the same map the attach guard uses.
 */
handle('osint:browse.bindGuest', (_e, webContentsId: unknown, token: unknown) => {
	if (typeof webContentsId !== 'number' || typeof token !== 'string') return false
	const profileId = partitionOwner(token)
	if (!profileId) return false
	rememberGuest(webContentsId, profileId)
	return true
})

/**
 * Arms or disarms automatic capture for a profile.
 *
 * Per profile rather than per pane, and off by default: arming is a decision about an
 * identity's whole session, and it is the moment the operator accepts that everything
 * they look at as this identity is written down.
 */
handle('osint:browse.setArmed', (_e, token: unknown, armed: unknown) => {
	if (typeof token !== 'string') return false
	const profileId = partitionOwner(token)
	if (!profileId) return false
	armProfile(profileId, armed === true)
	return isArmed(profileId)
})

handle('osint:browse.isArmed', (_e, token: unknown) => {
	if (typeof token !== 'string') return false
	const profileId = partitionOwner(token)
	return profileId ? isArmed(profileId) : false
})

/** Capture this page now, whether or not the profile is armed. */
/**
 * Watching is per investigation, not per profile, and independent of capture.
 *
 * Someone can be looking for a phone number across every identity they browse as, without
 * writing any of those pages down -- and someone recording everything may not yet know
 * what they are looking for.
 */
handle('osint:browse.setWatching', (_e, value: unknown) => {
	setWatching(value === true)
	return isWatching()
})

handle('osint:browse.isWatching', () => isWatching())
handle('osint:browse.selectors', () => loadSelectors())

/**
 * Re-runs the current watchlist over everything already captured.
 *
 * The point of a watchlist is that you learn what matters partway through; one that only
 * looked forward would be the less useful half of the feature.
 */
handle('osint:browse.rescan', async () => {
	let captures: any[] = []
	try {
		captures = parseCaptureIndex(await vaultFs.read(CAPTURE_INDEX_PATH)).captures
	}
	catch {
		return []
	}
	return rescan(captures)
})

handle('osint:browse.setBudget', (_e, bytes: unknown) => {
	if (typeof bytes === 'number') setCaptureBudgetBytes(bytes)
	return captureBudgetBytes()
})

handle('osint:browse.captureNow', async (_e, webContentsId: unknown) => {
	if (typeof webContentsId !== 'number') throw new Error('captureNow: expected a webContents id')
	const guest = webContents.fromId(webContentsId)
	if (!guest) throw new Error(`captureNow: no webContents ${webContentsId}`)
	return captureGuest({ guest, profileId: guestProfile(webContentsId), budgetBytes: captureBudgetBytes() })
})

handle('osint:browse.release', (_e, token: unknown) => {
	if (typeof token === 'string') releaseSession(token)
})

/**
 * Measures what a profile is actually exposing, in the profile itself.
 *
 * Run from MAIN against a fixed snippet in the guest's ISOLATED world: the page cannot
 * read the probe, tamper with its result, or tell that it ran. There is no guest preload
 * and no channel a page could reach -- the string goes in, a value comes back.
 */
handle('osint:browse.realityCheck', async (_e, webContentsId: unknown, profileId: unknown) => {
	if (typeof webContentsId !== 'number') throw new Error('realityCheck: expected a webContents id')
	const guest = webContents.fromId(webContentsId)
	if (!guest) throw new Error(`realityCheck: no webContents ${webContentsId}`)

	const profile = await findProfile(typeof profileId === 'string' ? profileId : 'default')
	// World 1: not the page's main world, and not a world anything else here uses.
	const signals = await guest.executeJavaScriptInIsolatedWorld(
		1, [{ code: REALITY_CHECK_SNIPPET }]) as RealitySignals

	return { profile, signals, findings: interpret(signals, profile) }
})

/**
 * An MHTML snapshot of a guest, taken through CDP rather than `savePage`.
 *
 * `Page.captureSnapshot` returns the serialised document as a string, so the bytes that
 * get hashed, the markdown derived from them and the archive written to disk are all the
 * same instant of a live DOM. `savePage` writes straight to a file, which would make them
 * three different moments of a page that is still changing under you.
 */
handle('osint:browse.snapshot', async (_e, webContentsId: unknown) => {
	if (typeof webContentsId !== 'number') throw new Error('snapshot: expected a webContents id')
	const guest = webContents.fromId(webContentsId)
	if (!guest) throw new Error(`snapshot: no webContents ${webContentsId}`)

	const alreadyAttached = guest.debugger.isAttached()
	if (!alreadyAttached) guest.debugger.attach('1.3')
	try {
		const result = await guest.debugger.sendCommand('Page.captureSnapshot', { format: 'mhtml' })
		return (result as { data: string }).data
	}
	finally {
		// DevTools and the debugger are mutually exclusive; do not hold it open.
		if (!alreadyAttached) guest.debugger.detach()
	}
})

Logger.info('[osint] browser handlers registered')
