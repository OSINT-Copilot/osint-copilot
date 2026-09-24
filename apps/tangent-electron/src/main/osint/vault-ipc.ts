/**
 * The `osint:vault.*` channels: file I/O for the Obsidian Vault shim.
 *
 * This exists alongside OSINT Copilot's own `file` API rather than replacing it, because the
 * shim needs four things OSINT Copilot's API does not offer: a stat back from every write
 * (the shim's read cache and its self-write suppression are keyed on path+mtime+size),
 * binary read/write, real OS trash, and Obsidian's exact error strings
 * ("File already exists." / "Folder already exists."), which vault-bootstrap-fs.ts
 * matches on.
 *
 * It does NOT bring a second filesystem watcher: change events are derived from
 * OSINT Copilot's own TreeChange stream in the renderer.
 *
 * Confinement is doubled up. vault.ts refuses any path escaping the open root, by `..`
 * or through a symlink, and the root itself must be a workspace OSINT Copilot has open — the
 * renderer cannot point this at an arbitrary directory.
 *
 * Kept out of index.ts, and free of any electron import, so the registration itself can
 * be driven from a node test: `handle`, the workspace check and trash are injected.
 */
import * as vaultFs from './node/vault'

/** The part of an IpcMainInvokeEvent these handlers use. */
export interface VaultIpcEvent {
	readonly sender: vaultFs.VaultSender
}

export type VaultHandle = (
	channel: string,
	listener: (event: VaultIpcEvent, ...args: any[]) => any,
) => void

export interface VaultIpcDeps {
	/** guarded-ipc's `handle` in the app, so every channel keeps the sender check. */
	handle: VaultHandle
	/** Throws unless `dir` is a workspace OSINT Copilot has open. */
	assertIsOpenWorkspace(dir: string): void
	/** Electron's shell.trashItem in the app. */
	trashItem(absolutePath: string): Promise<void>
}

export function registerVaultHandlers({ handle, assertIsOpenWorkspace, trashItem }: VaultIpcDeps): void {
	/**
	 * Every vault channel resolves against the SENDER's vault. A window that never opened
	 * one gets "No vault is open" rather than another window's root: with a single shared
	 * root, two windows on two vaults each wrote into whichever had opened last.
	 */
	const vaultOf = (e: VaultIpcEvent) => vaultFs.vaultForSender(e.sender.id)

	handle('osint:vault.open', (e, dir: string) => {
		assertIsOpenWorkspace(dir)
		return vaultFs.openForSender(e.sender, dir)
	})

	handle('osint:vault.read', (e, p: string) => vaultOf(e).read(p))
	handle('osint:vault.readBinary', (e, p: string) => vaultOf(e).readBinary(p))
	handle('osint:vault.write', (e, p: string, d: string) => vaultOf(e).write(p, d))
	handle('osint:vault.writeBinary', (e, p: string, d: Uint8Array) => vaultOf(e).writeBinary(p, d))
	handle('osint:vault.create', (e, p: string, d: string) => vaultOf(e).create(p, d))
	handle('osint:vault.mkdir', (e, p: string) => vaultOf(e).mkdir(p))
	handle('osint:vault.remove', (e, p: string) => vaultOf(e).remove(p))
	handle('osint:vault.rename', (e, from: string, to: string) => vaultOf(e).rename(from, to))

	/** Real OS trash, not unlink: four fileManager.trashFile call sites depend on it. */
	handle('osint:vault.trash', async (e, p: string) => {
		await trashItem(vaultOf(e).absolutePathOf(p))
	})
}
