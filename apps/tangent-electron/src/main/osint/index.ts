/**
 * OSINT Copilot's privileged half.
 *
 * Registers on import, the way OSINT Copilot's own message modules do, so wiring it up is a
 * single `import './osint'` in src/main/index.ts.
 *
 * Only capabilities OSINT Copilot does not already provide live here: spawning CLI runtimes,
 * guarded HTTP with main-side secrets, and document text extraction. File I/O is
 * deliberately absent — that goes through OSINT Copilot's own `file` API and DirectoryStore.
 *
 * Trust boundary rules, all enforced on this side because the renderer is untrusted:
 *   - no channel returns a secret value; main resolves and injects them (see impl.ts)
 *   - exec is limited to binaries main derived from settings itself (see exec-guard.ts)
 *   - HTTP is checked against the per-enricher domain allowlist and refuses private,
 *     loopback, link-local, CGNAT and cloud-metadata addresses after DNS resolution
 */
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import Logger from 'js-logger'

import { contentsMap, workspaceMap } from 'main/workspaces'
import { getDocumentationPath } from 'main/documentation'
import { licenseStatus, onLicenseChanged } from 'main/license'
import { mode } from 'main/environment'
import { host, requestFor } from './impl'
import * as vaultFs from './node/vault'
import * as basemap from './node/basemap'
import {
	assertCwdPermitted,
	assertExecPermitted,
	filterEnvOverrides,
	noteResolved,
	setWorkspaceRootsProvider,
} from './exec-guard'
import { handle, on } from './guarded-ipc'
import { registerVaultHandlers } from './vault-ipc'
import { setApplicationWindowPredicate } from './sender-guard'
import { ExtensionController } from './extension/controller'
import type { ConfirmPairing } from './extension/pairing'
import { registerExtensionHandlers, registerInboxHandlers } from './inbox/ipc'
import { tangentInboxHost, workspacePathOf } from './inbox/tangent-host'
import { utilityParserRunner } from './capture/utility-runner'
import { RENDER_PARTITION, renderArchive, renderSessionStats } from './capture/capture-surface'
import type { ExecOptions, HttpRequest, PlatformInfo } from '../../osint/host/types'

setWorkspaceRootsProvider(() => [...workspaceMap.keys()])

/**
 * Who may speak to the `osint:*` channels. Wired here rather than in guarded-ipc.ts
 * because `contentsMap` lives in OSINT Copilot's tree, and this file is already excluded from
 * `typecheck:osint` for exactly that reason.
 *
 * `contentsMap` is populated in createWindow() before the page loads, so a window's first
 * message -- the preload's sendSync -- is already attributable.
 */
setApplicationWindowPredicate(contents => contentsMap.has(contents as Electron.WebContents))

function platformSnapshot(): PlatformInfo {
	const p = host.platform
	return { os: p.os, homedir: p.homedir, pathSep: p.pathSep, isFlatpak: p.isFlatpak }
}

/**
 * Synchronous by design. The renderer needs os/homedir/pathSep before it builds any CLI
 * candidate path, and `host.platform` is read synchronously at seven sites. This fires
 * exactly once, from preload, before the page loads — unlike a per-lookup sendSync it
 * costs nothing measurable.
 */
on('osint:platform', event => {
	event.returnValue = platformSnapshot()
})

// ------------------------------------------------------------------------ secrets
// Deliberately no 'osint:secrets.get'. No channel returns a secret value: net.request
// below resolves and injects them.

// ---------------------------------------------------------------------------- cli
handle('osint:cli.resolve', async (
	_e, configured: string | undefined, fallback: string, extras?: string[], timeout?: number,
) => {
	// Resolution is a read-only probe, but its *result* is only useful if exec accepts it,
	// so record it against the name main already permits.
	await assertExecPermitted(configured?.trim() || fallback)
	const resolved = await host.cli.resolve(configured, fallback, extras, timeout)
	noteResolved(resolved)
	return resolved
})

handle('osint:cli.exec', async (
	_e, execId: string, binary: string, args: string[], options?: ExecOptions,
) => {
	await assertExecPermitted(binary)
	assertCwdPermitted(options?.cwd)
	return host.cli.exec(execId, binary, args, {
		...options,
		envOverrides: filterEnvOverrides(options?.envOverrides),
	})
})

on('osint:cli.kill', (_e, execId: string) => host.cli.kill(execId))

// --------------------------------------------------------------------------- net
// The sender's vault, so vault-file auth reads the asking window's credentials.
handle('osint:net.request', (e, request: HttpRequest) =>
	requestFor(request, vaultFs.findVaultForSender(e.sender.id)))

// ----------------------------------------------------------------------- extract
handle('osint:extract.pdfText', (_e, data: ArrayBuffer) => host.extract.pdfText(data))
handle('osint:extract.docxText', (_e, data: ArrayBuffer) => host.extract.docxText(data))

// --------------------------------------------------------------------------- vault
// The channels themselves are in vault-ipc.ts; see there for why they exist and how
// they are confined. The workspace check lives here because workspaceMap is OSINT Copilot's.
registerVaultHandlers({
	handle,
	assertIsOpenWorkspace(dir: string): void {
		const roots = [...workspaceMap.keys()]
		if (!roots.includes(dir)) {
			throw new Error(`Refusing to open "${dir}" as a vault: it is not an open workspace.`)
		}
	},
	trashItem: absolutePath => shell.trashItem(absolutePath),
})

// ------------------------------------------------------------------------ basemap
/**
 * Byte-range reads of a local PMTiles archive, for the offline map basemap.
 *
 * Note what is absent: no channel takes a path. `pick` opens a dialog main owns, `open`
 * reads the remembered path from main's own userData, and reads address an opaque handle
 * bound to a descriptor main holds. A byte-range read of a caller-supplied path would be
 * an arbitrary-file-read primitive; see node/basemap.ts.
 */
app.whenReady().then(() => {
	basemap.configureBasemap(app.getPath('userData'), async () => {
		const focused = BrowserWindow.getFocusedWindow()
		const options: Electron.OpenDialogOptions = {
			title: 'Select an offline basemap',
			buttonLabel: 'Use this archive',
			properties: ['openFile', 'dontAddToRecent'],
			filters: [{ name: 'PMTiles archive', extensions: ['pmtiles'] }],
		}
		const result = focused
			? await dialog.showOpenDialog(focused, options)
			: await dialog.showOpenDialog(options)
		return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
	})
})

/** Handles die with the window that opened them. */
const basemapSenders = new Set<number>()
function trackBasemapOwner(event: Electron.IpcMainInvokeEvent): void {
	const id = event.sender.id
	if (basemapSenders.has(id)) return
	basemapSenders.add(id)
	event.sender.once('destroyed', () => {
		basemapSenders.delete(id)
		void basemap.closeAll()
	})
}

handle('osint:basemap.pick', (e) => { trackBasemapOwner(e); return basemap.pick() })
handle('osint:basemap.open', (e) => { trackBasemapOwner(e); return basemap.open() })
handle('osint:basemap.forget', () => basemap.forget())
handle('osint:basemap.read', (_e, handleId: string, offset: number, length: number) =>
	basemap.read(handleId, offset, length))

// -------------------------------------------------------------- browser extension
/**
 * The loopback channel the OSINT Copilot browser extension sends notes and entities
 * over, and the inbox they land in. The protocol and its threat model are in
 * extension/PROTOCOL.md; what decides whether the port is open is ExtensionController.
 *
 * Wired here because it needs OSINT Copilot's workspaceMap and contentsMap, the licence and
 * Electron's dialog and safeStorage, none of which the electron-free modules import.
 */
const RECONCILE_EVERY_MS = 10 * 60_000

/**
 * The native "allow this extension?" dialog, on the focused window. Deny is the default
 * and the cancel answer. End-to-end tests may skip it, but never in a packaged build:
 * `mode` comes from NODE_ENV at run time, so it alone would let an environment variable
 * switch the dialog off in a shipped app.
 */
const confirmPairing: ConfirmPairing = async ({ origin, extVersion }) => {
	if (process.env.OC_TEST_AUTO_CONFIRM_PAIR === '1' && mode !== 'production' && !app.isPackaged) return true
	const options: Electron.MessageBoxOptions = {
		type: 'question',
		buttons: ['Allow', 'Deny'],
		defaultId: 1,
		cancelId: 1,
		noLink: true,
		title: 'Pair a browser extension',
		message: 'Allow this browser extension to add notes and entities to your investigations?',
		detail: `Extension: ${origin}\nVersion: ${extVersion}\n\n`
			+ 'Allow only if you have just pasted a pairing string from OSINT Copilot into the extension.',
	}
	const focused = BrowserWindow.getFocusedWindow()
	const result = focused
		? await dialog.showMessageBox(focused, options)
		: await dialog.showMessageBox(options)
	return result.response === 0
}

async function hasOsintEntitlement(): Promise<boolean> {
	const status = await licenseStatus()
	return status.valid && status.entitlements?.osint === true
}

const inboxHost = tangentInboxHost({
	workspaceMap,
	contentsMap,
	documentationPath: () => getDocumentationPath(),
})

// safeStorage is only usable once the app is ready.
const extensionReady: Promise<ExtensionController> = app.whenReady().then(() =>
	ExtensionController.open({
		userDataDir: app.getPath('userData'),
		encryptor: safeStorage,
		confirm: confirmPairing,
		licensed: hasOsintEntitlement,
		host: inboxHost,
		appVersion: app.getVersion(),
		log: Logger.get('osint-extension'),
		// Parsing in a killable utility process; the render needs a window, so main.
		capture: { runParser: utilityParserRunner(), renderArchive },
	}))

extensionReady.then(controller => {
	void controller.reconcile()
	onLicenseChanged(() => { void controller.reconcile() })
	// A subscription can lapse with no event to hear, so look again now and then.
	setInterval(() => { void controller.reconcile() }, RECONCILE_EVERY_MS).unref?.()
	// On 'quit', not 'before-quit': Tangent's will-quit can still cancel a quit while its
	// workspaces close, and stop() keeps the port shut for good.
	app.on('quit', () => { void controller.stop() })
}, err => {
	Logger.error('[osint] the browser extension channel could not be set up:', err)
})

/**
 * The integration tests' way to render an archive in this real main process
 * (tests-integration/capture-render.test.ts): the render's network isolation is only
 * provable in a real Chromium. A global, not an IPC channel, so no page can reach it;
 * and webpack replaces process.env.NODE_ENV in a production build, which drops this
 * block from the shipped bundle altogether.
 */
if (process.env.NODE_ENV !== 'production' && process.env.INTEGRATION_TEST && !app.isPackaged) {
	;(globalThis as any).__osintCaptureRenderTest = { renderArchive, renderSessionStats, RENDER_PARTITION }
}

registerInboxHandlers({
	handle,
	inbox: () => extensionReady.then(c => c.inbox),
	// The sender's own window, from main's own map: never a path the renderer names.
	workspacePathOf: sender => workspacePathOf(contentsMap.get(sender as Electron.WebContents)),
})

registerExtensionHandlers({
	handle,
	control: () => extensionReady,
})

Logger.info('[osint] main-process handlers registered')
