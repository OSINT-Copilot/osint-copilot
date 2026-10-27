#!/usr/bin/env node
/**
 * Generates the Ed25519 key pair that licence keys are signed with.
 *
 * Run this ONCE. The public half is pasted into src/common/license.ts and ships inside the
 * app; the private half signs keys and must never leave your machine or enter the repo
 * (.gitignore already carries a rule for *.license-signing-key.pem).
 *
 * Running it again produces a new pair and INVALIDATES every key issued under the old one.
 *
 *   node scripts/license-keygen.mjs [--out <path>]
 */
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outPath = resolve(outIndex >= 0 ? args[outIndex + 1] : '.license-signing-key.pem')

if (existsSync(outPath) && !args.includes('--force')) {
	console.error(`Refusing to overwrite ${outPath}.`)
	console.error('Every licence key already issued was signed with it. Pass --force if you are certain.')
	process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
// The last 32 bytes of the DER SPKI encoding are the raw public key.
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)

writeFileSync(outPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

console.log(`Private signing key written to ${outPath} (mode 600). Do not commit it.`)
console.log('')
console.log('Paste this into src/common/license.ts as LICENSE_PUBLIC_KEY_B64:')
console.log('')
console.log(`  export const LICENSE_PUBLIC_KEY_B64 = '${raw.toString('base64')}'`)
console.log('')
