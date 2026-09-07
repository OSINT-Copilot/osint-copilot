#!/usr/bin/env node
/**
 * Mints a licence key.
 *
 *   node scripts/make-license.mjs --name "Jane Analyst" \
 *        [--email jane@example.org] [--expires 2027-09-07] [--seats 1] \
 *        [--key .license-signing-key.pem]
 *
 * Omit --expires for a perpetual licence. The key it prints is what you send the customer;
 * it is verified offline against the public key compiled into the app, so nothing needs to
 * be recorded here for the key to work.
 */
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function arg(name, fallback = undefined) {
	const index = process.argv.indexOf(`--${name}`)
	if (index < 0) return fallback
	const value = process.argv[index + 1]
	if (value === undefined || value.startsWith('--')) {
		console.error(`--${name} needs a value`)
		process.exit(1)
	}
	return value
}

const name = arg('name')
if (!name) {
	console.error('--name is required (who the licence is issued to)')
	process.exit(1)
}

const expires = arg('expires', null)
if (expires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
	console.error('--expires must be a date as YYYY-MM-DD')
	process.exit(1)
}

const seats = arg('seats', null)
const keyPath = resolve(arg('key', '.license-signing-key.pem'))

let privateKey
try {
	privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'))
}
catch (e) {
	console.error(`Could not read the signing key at ${keyPath}: ${e.message}`)
	console.error('Run `node scripts/license-keygen.mjs` first.')
	process.exit(1)
}

const base64url = (buffer) =>
	buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// Key order is fixed and the JSON is compact, so the same inputs always give the same key.
const payload = {
	v: 1,
	name,
	...(arg('email') ? { email: arg('email') } : {}),
	issued: new Date().toISOString().slice(0, 10),
	...(expires ? { expires } : {}),
	...(seats ? { seats: Number(seats) } : {}),
}

// The signature covers the ENCODED payload string, not the JSON, so re-serialising can
// never change what was signed. main/license.ts verifies exactly this text.
const encodedPayload = base64url(Buffer.from(JSON.stringify(payload), 'utf8'))
const signature = base64url(sign(null, Buffer.from(encodedPayload, 'utf8'), privateKey))

console.log('')
console.log(`  Issued to : ${payload.name}`)
if (payload.email) console.log(`  Email     : ${payload.email}`)
console.log(`  Issued    : ${payload.issued}`)
console.log(`  Expires   : ${payload.expires ?? 'never'}`)
if (payload.seats) console.log(`  Seats     : ${payload.seats}`)
console.log('')
console.log(`OSINT-${encodedPayload}.${signature}`)
console.log('')
