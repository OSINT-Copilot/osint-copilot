import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findVaultForSender, OpenVault, openForSender, vaultForSender, type VaultSender } from './vault'
import { registerVaultHandlers, type VaultIpcEvent } from '../vault-ipc'

/**
 * Each window's vault operations must land in that window's vault. The browser extension
 * turns hostile page text into notes written through these channels, so a write routed
 * to the wrong root -- or through a symlink out of it -- is the failure these pin.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-vault-'))

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true })
})

let nextId = 1000

/** Stands in for a WebContents: an id, and a 'destroyed' the test fires by hand. */
function fakeSender() {
	const listeners: Array<() => void> = []
	let destroyed = false
	const sender: VaultSender & { destroy(): void, listenerCount(): number } = {
		id: nextId++,
		isDestroyed: () => destroyed,
		once(_event: 'destroyed', listener: () => void) { listeners.push(listener) },
		destroy() {
			destroyed = true
			for (const l of listeners.splice(0)) l()
		},
		listenerCount: () => listeners.length,
	}
	return sender
}

function freshDir(name: string): string {
	const p = path.join(dir, name)
	fs.mkdirSync(p, { recursive: true })
	return p
}

describe('per-window vault roots', () => {
	it('writes from two windows land in their own vaults', async () => {
		const a = fakeSender()
		const b = fakeSender()
		const rootA = freshDir('a')
		const rootB = freshDir('b')

		await openForSender(a, rootA, { watch: false })
		await openForSender(b, rootB, { watch: false })

		// A writes after B opened: with a single shared root this went into B's vault.
		await vaultForSender(a.id).write('Person/alice.md', 'from a')
		await vaultForSender(b.id).write('Person/bob.md', 'from b')

		expect(fs.readFileSync(path.join(rootA, 'Person/alice.md'), 'utf-8')).toBe('from a')
		expect(fs.readFileSync(path.join(rootB, 'Person/bob.md'), 'utf-8')).toBe('from b')
		expect(fs.existsSync(path.join(rootB, 'Person/alice.md'))).toBe(false)
		expect(fs.existsSync(path.join(rootA, 'Person/bob.md'))).toBe(false)
	})

	it('a window that never opened a vault gets "No vault is open", not another window\'s', async () => {
		const opener = fakeSender()
		await openForSender(opener, freshDir('opened'), { watch: false })

		const stranger = fakeSender()
		expect(() => vaultForSender(stranger.id)).toThrow('No vault is open')
		expect(findVaultForSender(stranger.id)).toBeNull()
	})

	it('drops the entry when the window is destroyed', async () => {
		const sender = fakeSender()
		await openForSender(sender, freshDir('destroyed'), { watch: false })
		expect(findVaultForSender(sender.id)).not.toBeNull()

		sender.destroy()

		expect(findVaultForSender(sender.id)).toBeNull()
		expect(() => vaultForSender(sender.id)).toThrow('No vault is open')
	})

	it('hooks destroyed once per window, however often it reopens', async () => {
		const sender = fakeSender()
		const first = freshDir('reopen-1')
		const second = freshDir('reopen-2')
		await openForSender(sender, first, { watch: false })
		await openForSender(sender, second, { watch: false })

		expect(sender.listenerCount()).toBe(1)
		await vaultForSender(sender.id).write('note.md', 'x')
		expect(fs.existsSync(path.join(second, 'note.md'))).toBe(true)
		expect(fs.existsSync(path.join(first, 'note.md'))).toBe(false)
	})

	it('does not register a window that closed while its vault was opening', async () => {
		const sender = fakeSender()
		sender.destroy()
		await expect(openForSender(sender, freshDir('late'), { watch: false })).rejects.toThrow()
		expect(findVaultForSender(sender.id)).toBeNull()
	})
})

describe('path confinement', () => {
	const outside = freshDir('outside')
	fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the vault')

	async function vaultWithLink(name: string) {
		const root = freshDir(name)
		fs.symlinkSync(outside, path.join(root, 'link'), 'dir')
		const { vault } = await OpenVault.open(root, { watch: false })
		return { root, vault }
	}

	it('refuses .. escapes', async () => {
		const { vault } = await OpenVault.open(freshDir('dotdot'), { watch: false })
		await expect(vault.read('../outside/secret.txt')).rejects.toThrow('Path escapes the vault root')
		await expect(vault.write('a/../../escaped.md', 'x')).rejects.toThrow('Path escapes the vault root')
		expect(fs.existsSync(path.join(dir, 'escaped.md'))).toBe(false)
	})

	it('refuses to read through a symlink that points outside the root', async () => {
		const { vault } = await vaultWithLink('symlink-read')
		await expect(vault.read('link/secret.txt')).rejects.toThrow('Path escapes the vault root')
	})

	it('refuses to write through a symlink that points outside the root, even to a new file', async () => {
		const { vault } = await vaultWithLink('symlink-write')
		await expect(vault.write('link/new/deep.md', 'x')).rejects.toThrow('Path escapes the vault root')
		expect(fs.existsSync(path.join(outside, 'new'))).toBe(false)
	})

	it('refuses a dangling symlink rather than following it out', async () => {
		const root = freshDir('dangling')
		const target = path.join(outside, 'not-yet.md')
		fs.symlinkSync(target, path.join(root, 'dangling.md'))
		const { vault } = await OpenVault.open(root, { watch: false })

		await expect(vault.write('dangling.md', 'x')).rejects.toThrow('Path escapes the vault root')
		expect(fs.existsSync(target)).toBe(false)
	})

	it('allows a symlink that stays inside the root', async () => {
		const root = freshDir('symlink-inside')
		fs.mkdirSync(path.join(root, 'real'))
		fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), 'dir')
		const { vault } = await OpenVault.open(root, { watch: false })

		await vault.write('alias/note.md', 'ok')
		expect(fs.readFileSync(path.join(root, 'real/note.md'), 'utf-8')).toBe('ok')
	})

	it('works when the vault root itself is reached through a symlink', async () => {
		const real = freshDir('real-root')
		const linked = path.join(dir, 'linked-root')
		fs.symlinkSync(real, linked, 'dir')
		const { vault } = await OpenVault.open(linked, { watch: false })

		const stat = await vault.write('Person/x.md', 'x')
		expect(stat.path).toBe('Person/x.md')
		expect(fs.existsSync(path.join(real, 'Person/x.md'))).toBe(true)
	})

	it('a refused rename leaves nothing behind', async () => {
		const { root, vault } = await vaultWithLink('rename-refused')
		// The source escapes; the destination folder must not be created regardless.
		await expect(vault.rename('../outside/secret.txt', 'moved/here/secret.txt')).rejects.toThrow('Path escapes the vault root')
		await expect(vault.rename('link/secret.txt', 'moved/here/secret.txt')).rejects.toThrow('Path escapes the vault root')
		expect(fs.existsSync(path.join(root, 'moved'))).toBe(false)
		expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true)
	})

	it('a refused rename destination leaves the source where it was', async () => {
		const { root, vault } = await vaultWithLink('rename-refused-dest')
		fs.writeFileSync(path.join(root, 'note.md'), 'x')
		await expect(vault.rename('note.md', 'link/stolen.md')).rejects.toThrow('Path escapes the vault root')
		expect(fs.existsSync(path.join(root, 'note.md'))).toBe(true)
		expect(fs.existsSync(path.join(outside, 'stolen.md'))).toBe(false)
	})

	it('the opening snapshot omits symlinks that escape the root and keeps ones inside it', async () => {
		const root = freshDir('snapshot-links')
		fs.mkdirSync(path.join(root, 'real'))
		fs.writeFileSync(path.join(root, 'real/inside.md'), 'in')
		fs.symlinkSync(path.join(root, 'real/inside.md'), path.join(root, 'inside-link.md'))
		fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'outside-link.txt'))
		fs.symlinkSync(outside, path.join(root, 'outside-dir'), 'dir')
		fs.symlinkSync(path.join(outside, 'gone.md'), path.join(root, 'dangling.md'))

		const { vault, snapshot } = await OpenVault.open(root, { watch: false })
		const paths = snapshot.map(s => s.path).sort()

		expect(paths).toEqual(['inside-link.md', 'real', 'real/inside.md'])
		// A listed link carries its target's stat, which every read agrees with.
		const link = snapshot.find(s => s.path === 'inside-link.md')!
		expect(link.type).toBe('file')
		expect(link.size).toBe(2)
		expect(await vault.read('inside-link.md')).toBe('in')
		await expect(vault.read('outside-link.txt')).rejects.toThrow('Path escapes the vault root')
	})

	it('removes a symlink itself, dangling or pointing out, without touching its target', async () => {
		const root = freshDir('remove-links')
		fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'out.txt'))
		fs.symlinkSync(outside, path.join(root, 'out-dir'), 'dir')
		fs.symlinkSync(path.join(outside, 'gone.md'), path.join(root, 'dangling.md'))
		const { vault } = await OpenVault.open(root, { watch: false })

		await vault.remove('out.txt')
		await vault.remove('out-dir')
		await vault.remove('dangling.md')

		expect(fs.readdirSync(root)).toEqual([])
		expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf-8')).toBe('outside the vault')
	})

	it('renames a symlink itself, and hands trash the link\'s own path', async () => {
		const root = freshDir('rename-links')
		fs.symlinkSync(path.join(outside, 'gone.md'), path.join(root, 'dangling.md'))
		fs.symlinkSync(outside, path.join(root, 'out-dir'), 'dir')
		const { vault } = await OpenVault.open(root, { watch: false })

		await vault.rename('dangling.md', 'Archive/dangling.md')
		expect(fs.lstatSync(path.join(root, 'Archive/dangling.md')).isSymbolicLink()).toBe(true)
		expect(fs.existsSync(path.join(root, 'dangling.md'))).toBe(false)

		expect(vault.absolutePathOf('out-dir')).toBe(path.join(root, 'out-dir'))
		// Only the final component is exempt: anything beneath an outward link is still refused.
		expect(() => vault.absolutePathOf('out-dir/secret.txt')).toThrow('Path escapes the vault root')
		await expect(vault.remove('out-dir/secret.txt')).rejects.toThrow('Path escapes the vault root')
		expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true)
	})

	it('reads and writes still refuse a symlink that remove accepts', async () => {
		const root = freshDir('link-read-write')
		fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'out.txt'))
		const { vault } = await OpenVault.open(root, { watch: false })

		await expect(vault.read('out.txt')).rejects.toThrow('Path escapes the vault root')
		await expect(vault.write('out.txt', 'overwritten')).rejects.toThrow('Path escapes the vault root')
		expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf-8')).toBe('outside the vault')
	})
})

describe('vault IPC handlers', () => {
	/** The registered handlers, invoked the way ipcMain would: event first. */
	function register(openWorkspaces: string[]) {
		const handlers = new Map<string, (event: VaultIpcEvent, ...args: any[]) => any>()
		const trashed: string[] = []
		registerVaultHandlers({
			handle: (channel, listener) => {
				expect(handlers.has(channel)).toBe(false)
				handlers.set(channel, listener)
			},
			assertIsOpenWorkspace(d) {
				if (!openWorkspaces.includes(d)) throw new Error(`not an open workspace: ${d}`)
			},
			async trashItem(p) { trashed.push(p) },
		})
		// async, as ipcMain.handle is: a handler's synchronous throw reaches the renderer
		// as a rejection.
		const invoke = async (sender: VaultSender, channel: string, ...args: any[]) => {
			const handler = handlers.get(channel)
			if (!handler) throw new Error(`no handler for ${channel}`)
			return handler({ sender }, ...args)
		}
		return { handlers, invoke, trashed }
	}

	it('registers every vault channel', () => {
		const { handlers } = register([])
		expect([...handlers.keys()].sort()).toEqual([
			'osint:vault.create', 'osint:vault.mkdir', 'osint:vault.open', 'osint:vault.read',
			'osint:vault.readBinary', 'osint:vault.remove', 'osint:vault.rename', 'osint:vault.stat',
			'osint:vault.trash', 'osint:vault.write', 'osint:vault.writeBinary',
		])
	})

	it('routes each sender\'s writes to the vault that sender opened', async () => {
		const rootA = freshDir('ipc-a')
		const rootB = freshDir('ipc-b')
		const { invoke, trashed } = register([rootA, rootB])
		const a = fakeSender()
		const b = fakeSender()

		await invoke(a, 'osint:vault.open', rootA)
		await invoke(b, 'osint:vault.open', rootB)

		// A writes after B opened -- the ordering that sent everything to B with one shared root.
		await invoke(a, 'osint:vault.write', 'Person/alice.md', 'from a')
		await invoke(b, 'osint:vault.write', 'Person/bob.md', 'from b')
		await invoke(a, 'osint:vault.create', 'Source/a.md', 'a')
		await invoke(b, 'osint:vault.mkdir', 'Only-b')
		await invoke(a, 'osint:vault.rename', 'Source/a.md', 'Source/a2.md')

		expect(fs.readFileSync(path.join(rootA, 'Person/alice.md'), 'utf-8')).toBe('from a')
		expect(fs.readFileSync(path.join(rootB, 'Person/bob.md'), 'utf-8')).toBe('from b')
		expect(fs.existsSync(path.join(rootA, 'Source/a2.md'))).toBe(true)
		expect(fs.existsSync(path.join(rootB, 'Only-b'))).toBe(true)
		expect(fs.readdirSync(rootA).sort()).toEqual(['Person', 'Source'])
		expect(fs.readdirSync(rootB).sort()).toEqual(['Only-b', 'Person'])
		expect(fs.readdirSync(path.join(rootA, 'Person'))).toEqual(['alice.md'])
		expect(fs.readdirSync(path.join(rootB, 'Person'))).toEqual(['bob.md'])

		// Reads, stats and trash resolve against the sender's vault as well.
		expect(await invoke(b, 'osint:vault.read', 'Person/bob.md')).toBe('from b')
		await expect(invoke(b, 'osint:vault.read', 'Person/alice.md')).rejects.toThrow()
		expect(await invoke(b, 'osint:vault.stat', 'Person/alice.md')).toBeNull()
		await invoke(a, 'osint:vault.trash', 'Person/alice.md')
		expect(trashed).toEqual([path.join(rootA, 'Person/alice.md')])
	})

	it('refuses a directory that is not an open workspace, and a sender with no vault', async () => {
		const root = freshDir('ipc-not-open')
		const { invoke } = register([])
		const sender = fakeSender()

		await expect(invoke(sender, 'osint:vault.open', root)).rejects.toThrow('not an open workspace')
		await expect(invoke(sender, 'osint:vault.write', 'x.md', 'x')).rejects.toThrow('No vault is open')
		expect(fs.readdirSync(root)).toEqual([])
	})
})
