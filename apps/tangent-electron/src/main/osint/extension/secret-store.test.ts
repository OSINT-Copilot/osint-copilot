import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { ExtensionSecretStore, SECRETS_FILE, SecretStoreError, type Encryptor } from './secret-store'
import { b64url } from './signing'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-ext-secrets-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let n = 0
function freshDir(): string {
	const dir = path.join(root, String(n++))
	fs.mkdirSync(dir)
	return dir
}

/** Stands in for safeStorage: reversible, and never leaves the plaintext visible. */
function fakeSafeStorage(available = true): Encryptor & { available: boolean } {
	const mask = (b: Buffer) => Buffer.from(b.map(x => x ^ 0x5a))
	return {
		available,
		isEncryptionAvailable() { return this.available },
		encryptString: s => Buffer.concat([Buffer.from('enc:'), mask(Buffer.from(s, 'utf8'))]),
		decryptString: b => {
			if (!b.subarray(0, 4).equals(Buffer.from('enc:'))) throw new Error('not ours')
			return mask(b.subarray(4)).toString('utf8')
		},
	}
}

const mode = (file: string) => fs.statSync(file).mode & 0o777

describe('ExtensionSecretStore', () => {
	it('creates the keys once and reads the same keys back', async () => {
		const dir = freshDir()
		const safe = fakeSafeStorage()
		const a = await ExtensionSecretStore.open(dir, safe)
		const K = randomBytes(32)
		await a.setClientKey('client-1', K)

		const b = await ExtensionSecretStore.open(dir, safe)
		expect(b.workspaceIdKey().equals(a.workspaceIdKey())).toBe(true)
		expect(b.manifestKey().equals(a.manifestKey())).toBe(true)
		expect(b.clientKey('client-1')?.equals(K)).toBe(true)
		expect(b.clientKey('nobody')).toBeNull()
		expect(b.plaintext).toBe(false)
	})

	it('encrypts: no key appears in the file, and the file is 0600', async () => {
		const dir = freshDir()
		const store = await ExtensionSecretStore.open(dir, fakeSafeStorage())
		const K = randomBytes(32)
		await store.setClientKey('client-1', K)

		const file = path.join(dir, SECRETS_FILE)
		const text = fs.readFileSync(file, 'utf-8')
		for (const key of [K, store.workspaceIdKey(), store.manifestKey()]) {
			expect(text).not.toContain(b64url(key))
			expect(text).not.toContain(key.toString('base64'))
		}
		expect(JSON.parse(text).encrypted).toBe(true)
		if (process.platform !== 'win32') expect(mode(file)).toBe(0o600)
	})

	it('falls back to a 0600 plain file, flagged, when safeStorage is unavailable', async () => {
		for (const safe of [null, fakeSafeStorage(false)]) {
			const dir = freshDir()
			const store = await ExtensionSecretStore.open(dir, safe)
			await store.setClientKey('client-1', randomBytes(32))
			expect(store.plaintext).toBe(true)
			const file = path.join(dir, SECRETS_FILE)
			expect(JSON.parse(fs.readFileSync(file, 'utf-8')).encrypted).toBe(false)
			if (process.platform !== 'win32') expect(mode(file)).toBe(0o600)
		}
	})

	it('encrypts a plain file as soon as safeStorage is available again', async () => {
		const dir = freshDir()
		const safe = fakeSafeStorage(false)
		const plain = await ExtensionSecretStore.open(dir, safe)
		const K = randomBytes(32)
		await plain.setClientKey('client-1', K)

		safe.available = true
		const upgraded = await ExtensionSecretStore.open(dir, safe)
		expect(upgraded.plaintext).toBe(false)
		expect(upgraded.clientKey('client-1')?.equals(K)).toBe(true)
		expect(fs.readFileSync(path.join(dir, SECRETS_FILE), 'utf-8')).not.toContain(b64url(K))
	})

	it('refuses, rather than regenerating over, a file it cannot read', async () => {
		const dir = freshDir()
		const safe = fakeSafeStorage()
		await ExtensionSecretStore.open(dir, safe)
		const file = path.join(dir, SECRETS_FILE)
		const before = fs.readFileSync(file, 'utf-8')

		// Encrypted, but the keyring has gone away.
		await expect(ExtensionSecretStore.open(dir, fakeSafeStorage(false))).rejects.toBeInstanceOf(SecretStoreError)
		expect(fs.readFileSync(file, 'utf-8')).toBe(before)

		fs.writeFileSync(file, '{not json')
		await expect(ExtensionSecretStore.open(dir, safe)).rejects.toBeInstanceOf(SecretStoreError)
		expect(fs.readFileSync(file, 'utf-8')).toBe('{not json')
	})

	it('deletes client keys', async () => {
		const dir = freshDir()
		const store = await ExtensionSecretStore.open(dir, fakeSafeStorage())
		await store.setClientKey('a', randomBytes(32))
		await store.setClientKey('b', randomBytes(32))
		await store.deleteClientKeys(['a'])
		const reread = await ExtensionSecretStore.open(dir, fakeSafeStorage())
		expect(reread.clientKey('a')).toBeNull()
		expect(reread.clientIds()).toEqual(['b'])
	})
})
