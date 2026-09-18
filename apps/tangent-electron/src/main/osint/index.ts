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
 * Confinement is doubled up. vault.ts refuses any path escaping the open root, by `..`
 * or through a symlink, and the root itself must be a workspace Tangent has open — the
 * renderer cannot point this at an arbitrary directory.
 */
function assertIsOpenWorkspace(dir: string): void {
	const roots = [...workspaceMap.keys()]
	if (!roots.includes(dir)) {
		throw new Error(`Refusing to open "${dir}" as a vault: it is not an open workspace.`)
	}
}

/**
 * Every vault channel resolves against the SENDER's vault. A window that never opened one
 * gets "No vault is open" rather than another window's root: with a single shared root,
 * two windows on two vaults each wrote into whichever had opened last.
 */
const vaultOf = (e: Electron.IpcMainInvokeEvent) => vaultFs.vaultForSender(e.sender.id)

handle('osint:vault.open', (e, dir: string) => {
	assertIsOpenWorkspace(dir)
	return vaultFs.openForSender(e.sender, dir, { watch: false })
})

handle('osint:vault.read', (e, p: string) => vaultOf(e).read(p))
handle('osint:vault.readBinary', (e, p: string) => vaultOf(e).readBinary(p))
handle('osint:vault.write', (e, p: string, d: string) => vaultOf(e).write(p, d))
handle('osint:vault.writeBinary', (e, p: string, d: Uint8Array) => vaultOf(e).writeBinary(p, d))
handle('osint:vault.create', (e, p: string, d: string) => vaultOf(e).create(p, d))
handle('osint:vault.mkdir', (e, p: string) => vaultOf(e).mkdir(p))
handle('osint:vault.remove', (e, p: string) => vaultOf(e).remove(p))
handle('osint:vault.rename', (e, from: string, to: string) => vaultOf(e).rename(from, to))
handle('osint:vault.stat', (e, p: string) => vaultOf(e).stat(p))

/** Real OS trash, not unlink: four fileManager.trashFile call sites depend on it. */
handle('osint:vault.trash', async (e, p: string) => {
	await shell.trashItem(vaultOf(e).absolutePathOf(p))
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
