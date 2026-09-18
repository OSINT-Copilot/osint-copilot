import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { OpenVault } from './vault'
import { resolveSecret } from './secrets'

/**
 * A vault-file credential is read from the vault the caller names, never from whichever
 * vault some window opened last: that would send one case's API key on another's requests.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-secrets-'))

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true })
})

async function vaultWithKey(name: string, key: string): Promise<OpenVault> {
	const root = path.join(dir, name)
	const credentials = path.join(root, 'OSINTCopilot/custom/credentials/leakcheck')
	fs.mkdirSync(credentials, { recursive: true })
	fs.writeFileSync(path.join(credentials, 'api-key.txt'), `${key}\n`)
	return (await OpenVault.open(root, { watch: false })).vault
}

const ref = { source: 'vault-file' as const, name: 'leakcheck/api-key.txt' }

describe('vault-file secrets', () => {
	it('reads from the vault it is given', async () => {
		const a = await vaultWithKey('a', 'key-a')
		const b = await vaultWithKey('b', 'key-b')

		expect(await resolveSecret(ref, a)).toBe('key-a')
		expect(await resolveSecret(ref, b)).toBe('key-b')
	})

	it('misses when the caller has no vault', async () => {
		await vaultWithKey('opened-elsewhere', 'someone-elses')
		expect(await resolveSecret(ref, null)).toBeNull()
	})
})
