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

import { handle } from '../guarded-ipc'
import { isRequestAddressPermitted } from './browser-net-guard'
import {
	BROWSE_PARTITION_PREFIX,
	guardAttach,
	isBrowseUrlPermitted,
	registerSession,
	releaseSession,
} from './attach-guard'

/**
 * Installed on every webContents rather than in createWindow(), so a window added later
 * cannot come up without the guard. `will-attach-webview` fires on the *host*, which is
 * why this is the right hook.
 */
app.on('web-contents-created', (_event, contents) => {
	contents.on('will-attach-webview', (event, webPreferences, params) => {
		if (!guardAttach(params as Record<string, string>, webPreferences as Record<string, unknown>)) {
			event.preventDefault()
		}
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

	// Downloads are not wired to anywhere yet; a silent write into the user's Downloads
	// folder from a page they are investigating is not a good default.
	guest.session.on('will-download', (event) => {
		Logger.info('[osint] blocked a download from a browsing guest')
		event.preventDefault()
	})

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

/**
 * Locks a browsing partition down before anything loads in it.
 *
 * Permissions are denied wholesale rather than prompted: every one of these is a way for
 * a page to learn something about the operator, and an investigator clicking through a
 * prompt on a hostile page is exactly the mistake this tool should not offer them.
 */
function configurePartition(partition: string): void {
	const ses = session.fromPartition(partition)
	ses.setPermissionRequestHandler((_contents, permission, callback) => {
		Logger.info('[osint] denied a guest permission request:', permission)
		callback(false)
	})
	ses.setPermissionCheckHandler(() => false)

	// The integration suite serves its fixture page from 127.0.0.1. Pointing it at the
	// live internet instead would make a test of our own rendering depend on someone
	// else's uptime, so loopback is permitted only under the harness's own flag.
	const allowLoopback = process.env.INTEGRATION_TEST === '1'

	ses.webRequest.onBeforeRequest((details, callback) => {
		if (isRequestAddressPermitted(details.url, { allowLoopback })) {
			callback({ cancel: false })
			return
		}
		Logger.warn('[osint] blocked a guest request to a local address:', details.url)
		callback({ cancel: true })
	})
}

/** The renderer asks for a session; it never learns the partition behind the token. */
handle('osint:browse.claim', (_e, profileId: unknown) => {
	const id = typeof profileId === 'string' && /^[a-z0-9-]{1,64}$/i.test(profileId)
		? profileId
		: 'default'
	const token = randomUUID()
	registerSession(token, id)
	configurePartition(BROWSE_PARTITION_PREFIX + id)
	return token
})

handle('osint:browse.release', (_e, token: unknown) => {
	if (typeof token === 'string') releaseSession(token)
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
