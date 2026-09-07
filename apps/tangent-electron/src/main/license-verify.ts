import { createPublicKey, verify as verifySignature } from 'node:crypto'

import {
	LICENSE_FORMAT_VERSION,
	LICENSE_PUBLIC_KEY_B64,
	isExpired,
	licenseFailureMessage,
	normalizeLicenseKey,
	parseLicenseKey,
	type LicenseFailure,
	type LicenseStatus,
} from '../common/license'

/**
 * Signature checking for licence keys.
 *
 * Split from license.ts, which owns storage and IPC and therefore imports `electron`.
 * Nothing here does, so the actual decision -- is this key good? -- can be tested directly
 * rather than through a mocked app.
 */

/**
 * The DER SPKI header for an Ed25519 public key.
 *
 * The public key is carried as its raw 32 bytes; node's createPublicKey will only take it
 * wrapped this way. The 12 bytes are a fixed algorithm identifier, not a secret.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function publicKeyFrom(base64: string) {
	const raw = Buffer.from(base64, 'base64')
	if (raw.length !== 32) {
		throw new Error(`licence public key must be 32 bytes, got ${raw.length}`)
	}
	return createPublicKey({
		key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
		format: 'der',
		type: 'spki',
	})
}

export function fail(reason: LicenseFailure): LicenseStatus {
	return { valid: false, reason, message: licenseFailureMessage(reason) }
}

/**
 * Checks a key. Stores nothing, reads nothing.
 *
 * @param now injectable so expiry can be tested without waiting a year.
 * @param publicKeyB64 injectable so a test can verify against a throwaway key pair rather
 *        than needing the real private key, which is not in the repo.
 */
export function checkLicenseKey(
	key: string,
	now = new Date(),
	publicKeyB64 = LICENSE_PUBLIC_KEY_B64,
): LicenseStatus {
	const normalized = normalizeLicenseKey(key)
	if (!normalized) return fail('missing')

	const parsed = parseLicenseKey(normalized)
	if (!parsed) return fail('malformed')

	// Checked before the signature: a key from a newer format may well be correctly
	// signed, and "you need a newer version" is the useful thing to say about it.
	if (parsed.payload.v > LICENSE_FORMAT_VERSION) return fail('unsupported-version')

	let signatureIsGood = false
	try {
		signatureIsGood = verifySignature(
			// Ed25519 signs the message itself; there is no separate digest step.
			null,
			Buffer.from(parsed.signedText, 'utf8'),
			publicKeyFrom(publicKeyB64),
			Buffer.from(parsed.signature),
		)
	}
	catch {
		// A signature of the wrong length makes verify() throw rather than return false.
		return fail('bad-signature')
	}
	if (!signatureIsGood) return fail('bad-signature')

	// After the signature, so an expired key is reported as expired rather than as
	// invalid. The user needs to know which of the two they are looking at.
	if (isExpired(parsed.payload, now)) return fail('expired')

	return { valid: true, payload: parsed.payload }
}
