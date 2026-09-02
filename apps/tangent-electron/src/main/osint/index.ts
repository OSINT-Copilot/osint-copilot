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
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import Logger from 'js-logger'

import { workspaceMap } from 'main/workspaces'
import { host } from './impl'
import * as vaultFs from './node/vault'
import * as basemap from './node/basemap'
import { configureKeychain } from './node/secrets'
import {
	assertCwdPermitted,
	assertExecPermitted,
	filterEnvOverrides,
	noteResolved,
	setWorkspaceRootsProvider,
} from './exec-guard'
import type { ExecOptions, HttpRequest, PlatformInfo, SecretRef } from '../../osint/host/types'

setWorkspaceRootsProvider(() => [...workspaceMap.keys()])

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
ipcMain.on('osint:platform', event => {
	event.returnValue = platformSnapshot()
})

// ------------------------------------------------------------------------ secrets
// Deliberately no 'osint:secrets.get'. No channel returns a secret value.
ipcMain.handle('osint:secrets.has', (_e, ref: SecretRef) => host.secrets.has(ref))
ipcMain.handle('osint:secrets.setKeychain', (_e, name: string, value: string) =>
	host.secrets.setKeychain(name, value))
ipcMain.handle('osint:secrets.deleteKeychain', (_e, name: string) => host.secrets.deleteKeychain(name))
ipcMain.handle('osint:secrets.listKeychain', () => host.secrets.listKeychain())

// ---------------------------------------------------------------------------- cli
ipcMain.handle('osint:cli.resolve', async (
	_e, configured: string | undefined, fallback: string, extras?: string[], timeout?: number,
) => {
	// Resolution is a read-only probe, but its *result* is only useful if exec accepts it,
	// so record it against the name main already permits.
	await assertExecPermitted(configured?.trim() || fallback)
	const resolved = await host.cli.resolve(configured, fallback, extras, timeout)
	noteResolved(resolved)
	return resolved
})

ipcMain.handle('osint:cli.exec', async (
	_e, execId: string, binary: string, args: string[], options?: ExecOptions,
) => {
	await assertExecPermitted(binary)
	assertCwdPermitted(options?.cwd)
	return host.cli.exec(execId, binary, args, {
		...options,
		envOverrides: filterEnvOverrides(options?.envOverrides),
	})
})

ipcMain.on('osint:cli.kill', (_e, execId: string) => host.cli.kill(execId))

// --------------------------------------------------------------------------- net
ipcMain.handle('osint:net.request', (_e, request: HttpRequest) => host.net.request(request))

// ----------------------------------------------------------------------- extract
ipcMain.handle('osint:extract.pdfText', (_e, data: ArrayBuffer) => host.extract.pdfText(data))
ipcMain.handle('osint:extract.docxText', (_e, data: ArrayBuffer) => host.extract.docxText(data))

// --------------------------------------------------------------------------- vault
/**
 * File I/O for the Obsidian Vault shim.
 *
 * This exists alongside Tangent's own `file` API rather than replacing it, because the
 * shim needs four things Tangent's API does not offer: a stat back from every write
 * (the shim's read cache and its self-write suppression are keyed on path+mtime+size),
 * binary read/write, real OS trash, and Obsidian's exact error strings
 * ("File already exists." / "Folder already exists."), which vault-bootstrap-fs.ts
 * matches on.
 *
 * It does NOT bring a second filesystem watcher: `open` is called with watch:false and
 * change events are derived from Tangent's own TreeChange stream in the renderer.
 *
 * Confinement is doubled up. vault.ts refuses any path escaping the open root, and the
 * root itself must be a workspace Tangent has open — the renderer cannot point this at
 * an arbitrary directory.
 */
function assertIsOpenWorkspace(dir: string): void {
	const roots = [...workspaceMap.keys()]
	if (!roots.includes(dir)) {
		throw new Error(`Refusing to open "${dir}" as a vault: it is not an open workspace.`)
	}
}

ipcMain.handle('osint:vault.open', (_e, dir: string) => {
	assertIsOpenWorkspace(dir)
	return vaultFs.open(dir, { watch: false })
})

ipcMain.handle('osint:vault.read', (_e, p: string) => vaultFs.read(p))
ipcMain.handle('osint:vault.readBinary', (_e, p: string) => vaultFs.readBinary(p))
ipcMain.handle('osint:vault.write', (_e, p: string, d: string) => vaultFs.write(p, d))
ipcMain.handle('osint:vault.writeBinary', (_e, p: string, d: Uint8Array) => vaultFs.writeBinary(p, d))
ipcMain.handle('osint:vault.create', (_e, p: string, d: string) => vaultFs.create(p, d))
ipcMain.handle('osint:vault.mkdir', (_e, p: string) => vaultFs.mkdir(p))
ipcMain.handle('osint:vault.remove', (_e, p: string) => vaultFs.remove(p))
ipcMain.handle('osint:vault.rename', (_e, from: string, to: string) => vaultFs.rename(from, to))
ipcMain.handle('osint:vault.stat', (_e, p: string) => vaultFs.stat(p))

/** Real OS trash, not unlink: four fileManager.trashFile call sites depend on it. */
ipcMain.handle('osint:vault.trash', async (_e, p: string) => {
	await shell.trashItem(vaultFs.absolutePathOf(p))
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

ipcMain.handle('osint:basemap.pick', (e) => { trackBasemapOwner(e); return basemap.pick() })
ipcMain.handle('osint:basemap.open', (e) => { trackBasemapOwner(e); return basemap.open() })
ipcMain.handle('osint:basemap.forget', () => basemap.forget())
ipcMain.handle('osint:basemap.read', (_e, handleId: string, offset: number, length: number) =>
	basemap.read(handleId, offset, length))
ipcMain.handle('osint:basemap.close', (_e, handleId: string) => basemap.close(handleId))

Logger.info('[osint] main-process handlers registered')
