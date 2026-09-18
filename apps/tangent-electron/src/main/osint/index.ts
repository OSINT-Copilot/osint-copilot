/**
 * OSINT Copilot's privileged half.
 *
 * Registers on import, the way Tangent's own message modules do, so wiring it up is a
 * single `import './osint'` in src/main/index.ts.
 *
 * Only capabilities Tangent does not already provide live here: spawning CLI runtimes,
 * guarded HTTP, document text extraction, and OS-keychain secrets. File I/O is
 * deliberately absent — that goes through Tangent's own `file` API and DirectoryStore.
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
import { host, requestFor } from './impl'
import * as vaultFs from './node/vault'
import * as basemap from './node/basemap'
import { configureKeychain, hasSecret } from './node/secrets'
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
import type { ExecOptions, HttpRequest, PlatformInfo, SecretRef } from '../../osint/host/types'

setWorkspaceRootsProvider(() => [...workspaceMap.keys()])

/**
 * Who may speak to the `osint:*` channels. Wired here rather than in guarded-ipc.ts
 * because `contentsMap` lives in Tangent's tree, and this file is already excluded from
 * `typecheck:osint` for exactly that reason.
 *
 * `contentsMap` is populated in createWindow() before the page loads, so a window's first
 * message -- the preload's sendSync -- is already attributable.
 */
setApplicationWindowPredicate(contents => contentsMap.has(contents as Electron.WebContents))

// safeStorage is only usable after the app is ready; until then the keychain source is
// inert and secrets fall back to env / vault files.
app.whenReady().then(() => {
	configureKeychain(safeStorage, app.getPath('userData'))
})

function platformSnapshot(): PlatformInfo {
	const p = host.platform
	return {
		os: p.os, arch: p.arch, homedir: p.homedir,
		pathSep: p.pathSep, pathDelimiter: p.pathDelimiter,
		isFlatpak: p.isFlatpak, electron: p.electron, chrome: p.chrome,
	}
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
// Deliberately no 'osint:secrets.get'. No channel returns a secret value.
// A vault-file ref is looked up in the asking window's own vault, never another's.
handle('osint:secrets.has', (e, ref: SecretRef) =>
	hasSecret(ref, vaultFs.findVaultForSender(e.sender.id)))
handle('osint:secrets.setKeychain', (_e, name: string, value: string) =>
	host.secrets.setKeychain(name, value))
handle('osint:secrets.deleteKeychain', (_e, name: string) => host.secrets.deleteKeychain(name))
handle('osint:secrets.listKeychain', () => host.secrets.listKeychain())

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
// they are confined. The workspace check lives here because workspaceMap is Tangent's.
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
handle('osint:basemap.close', (_e, handleId: string) => basemap.close(handleId))

Logger.info('[osint] main-process handlers registered')
