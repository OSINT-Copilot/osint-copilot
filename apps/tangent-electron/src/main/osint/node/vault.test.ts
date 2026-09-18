import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findVaultForSender, OpenVault, openForSender, vaultForSender, type VaultSender } from './vault'

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
})
