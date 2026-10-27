import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'

import { checkLicenseKey } from './license-verify'
import {
	LICENSE_PUBLIC_KEY_B64,
	LICENSE_PREFIX,
	parseLicenseKey,
	type LicensePayload,
} from '../common/license'

/**
 * Licence keys are minted here exactly the way scripts/make-license.mjs mints them, from a
 * throwaway key pair. That keeps the real signing key out of the repo while still testing
 * the true path: sign a payload, hand the key to the verifier, and see what it says.
 *
 * If these ever disagree with the script, the script is the thing customers' keys came
 * from -- change the test to match it, not the other way round.
 */
function keyPair() {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519')
	return {
		privateKey,
		publicB64: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
	}
}

const base64url = (buffer: Buffer) =>
	buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function mint(payload: LicensePayload, privateKey: ReturnType<typeof keyPair>['privateKey']) {
	const encoded = base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
	const signature = base64url(sign(null, Buffer.from(encoded, 'utf8'), privateKey))
	return `${LICENSE_PREFIX}${encoded}.${signature}`
}

const PERPETUAL: LicensePayload = { v: 1, name: 'Jane Analyst', email: 'jane@example.org' }

describe('licence verification', () => {
	it('accepts a key signed by the matching private key', () => {
		const { privateKey, publicB64 } = keyPair()
		const status = checkLicenseKey(mint(PERPETUAL, privateKey), new Date(), publicB64)

		expect(status.valid).toBe(true)
		expect(status.payload?.name).toBe('Jane Analyst')
		expect(status.payload?.email).toBe('jane@example.org')
	})

	it('rejects a key signed by a different private key', () => {
		// The whole point of signing: a key minted by anyone else must not work.
		const mine = keyPair()
		const theirs = keyPair()
		const status = checkLicenseKey(mint(PERPETUAL, theirs.privateKey), new Date(), mine.publicB64)

		expect(status.valid).toBe(false)
		expect(status.reason).toBe('bad-signature')
	})

	it('rejects a key whose payload was edited after signing', () => {
		const { privateKey, publicB64 } = keyPair()
		const key = mint({ ...PERPETUAL, expires: '2020-01-01' }, privateKey)

		// Re-encode a payload that says something more generous, keeping the signature.
		const signature = key.slice(key.indexOf('.') + 1)
		const forgedPayload = base64url(
			Buffer.from(JSON.stringify({ ...PERPETUAL, expires: '2099-01-01' }), 'utf8'))
		const forged = `${LICENSE_PREFIX}${forgedPayload}.${signature}`

		expect(checkLicenseKey(forged, new Date(), publicB64).reason).toBe('bad-signature')
	})

	it('reports an expired key as expired rather than invalid', () => {
		const { privateKey, publicB64 } = keyPair()
		const key = mint({ ...PERPETUAL, expires: '2026-01-31' }, privateKey)
		const status = checkLicenseKey(key, new Date('2026-02-01T00:00:00Z'), publicB64)

		expect(status.valid).toBe(false)
		// The distinction matters: one needs renewing, the other needs replacing.
		expect(status.reason).toBe('expired')
		expect(status.message).toMatch(/expired/i)
	})

	it('honours a key through the whole of its expiry day', () => {
		const { privateKey, publicB64 } = keyPair()
		const key = mint({ ...PERPETUAL, expires: '2026-01-31' }, privateKey)

		// A licence that says it runs to the 31st should still work at tea time on the 31st.
		expect(checkLicenseKey(key, new Date('2026-01-31T18:00:00Z'), publicB64).valid).toBe(true)
	})

	it('treats a key with no expiry as perpetual', () => {
		const { privateKey, publicB64 } = keyPair()
		const key = mint(PERPETUAL, privateKey)

		expect(checkLicenseKey(key, new Date('2099-01-01T00:00:00Z'), publicB64).valid).toBe(true)
	})

	it('tolerates the line breaks a key picks up in an email', () => {
		const { privateKey, publicB64 } = keyPair()
		const key = mint(PERPETUAL, privateKey)
		const wrapped = key.replace(/(.{40})/g, '$1\n  ')

		expect(checkLicenseKey(wrapped, new Date(), publicB64).valid).toBe(true)
	})

	it('asks for a newer version when the key format is ahead of this build', () => {
		const { privateKey, publicB64 } = keyPair()
		const key = mint({ ...PERPETUAL, v: 99 }, privateKey)

		expect(checkLicenseKey(key, new Date(), publicB64).reason).toBe('unsupported-version')
	})

	it.each([
		['an empty string', ''],
		['only whitespace', '   \n  '],
	])('reports %s as missing rather than malformed', (_label, input) => {
		expect(checkLicenseKey(input).reason).toBe('missing')
	})

	it.each([
		['no prefix', 'hello'],
		['prefix but no separator', 'OSINT-abcdef'],
		['an empty payload', 'OSINT-.abc'],
		['an empty signature', 'OSINT-abc.'],
		['two separators', 'OSINT-abc.def.ghi'],
		['a payload that is not JSON', `${LICENSE_PREFIX}bm90LWpzb24.abc`],
	])('reports %s as malformed', (_label, input) => {
		expect(checkLicenseKey(input).reason).toBe('malformed')
	})
})

describe('the public key compiled into this build', () => {
	it('is a usable 32-byte Ed25519 key', () => {
		// A truncated or placeholder value here would lock every user out of the app, and
		// would only show up at runtime as "that key is not valid" for keys that are.
		expect(Buffer.from(LICENSE_PUBLIC_KEY_B64, 'base64')).toHaveLength(32)
	})

	it('rejects a well-formed key signed by anyone else', () => {
		const { privateKey } = keyPair()
		expect(checkLicenseKey(mint(PERPETUAL, privateKey)).reason).toBe('bad-signature')
	})
})

describe('parseLicenseKey', () => {
	it('signs the encoded payload, not the re-serialised JSON', () => {
		// The signed text must be the exact substring from the key. If this ever became
		// "JSON.stringify(payload)", every key with different key ordering would break.
		const { privateKey } = keyPair()
		const key = mint(PERPETUAL, privateKey)
		const parsed = parseLicenseKey(key)

		expect(parsed).not.toBeNull()
		expect(key).toContain(parsed!.signedText)
		expect(parsed!.payload.name).toBe('Jane Analyst')
	})
})
