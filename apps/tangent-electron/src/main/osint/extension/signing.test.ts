import { describe, it, expect } from 'vitest'
import vectors from './vectors/protocol-vectors.json'
import {
	b64url,
	deriveClientKey,
	endpointFor,
	fromB64url,
	helloProofString,
	hmac,
	keyDerivationString,
	pairingIdFor,
	pairingString,
	pairProofString,
	pairServerProofString,
	parsePairingString,
	requestStringToSign,
	responseStringToSign,
	sha256Hex,
	signRequest,
	signResponse,
	verifyMac,
	workspaceIdFor,
} from './signing'

/**
 * protocol-vectors.json was produced by a separate Python implementation of PROTOCOL.md,
 * and the extension runs the same file. Matching it byte for byte is what lets the two
 * ends be built apart.
 */
const input = vectors.inputs
const pairSecret = Buffer.from(input.pairSecretHex, 'hex')
const K = Buffer.from(vectors.keyDerivation.keyHex, 'hex')

describe('protocol vectors', () => {
	it('encodes the pairing secret as unpadded base64url', () => {
		expect(b64url(pairSecret)).toBe(input.pairSecret)
	})

	it('pairingId', () => {
		expect(pairingIdFor(pairSecret)).toBe(vectors.pairingId)
	})

	it('pairing string, both ways', () => {
		expect(pairingString(input.port, input.instanceId, pairSecret)).toBe(vectors.pairingString)
		const parsed = parsePairingString(vectors.pairingString)
		expect(parsed?.port).toBe(input.port)
		expect(parsed?.instanceId).toBe(input.instanceId)
		expect(parsed?.pairSecret.equals(pairSecret)).toBe(true)
	})

	it('pair proof', () => {
		expect(pairProofString(input.clientNonce)).toBe(vectors.pairProof.stringToSign)
		expect(b64url(hmac(pairSecret, vectors.pairProof.stringToSign))).toBe(vectors.pairProof.proof)
	})

	it('key derivation', () => {
		expect(keyDerivationString(input.clientNonce, input.serverNonce, input.clientId)).toBe(vectors.keyDerivation.stringToSign)
		const key = deriveClientKey(pairSecret, input.clientNonce, input.serverNonce, input.clientId)
		expect(key.toString('hex')).toBe(vectors.keyDerivation.keyHex)
		expect(b64url(key)).toBe(vectors.keyDerivation.key)
	})

	it('pair server proof', () => {
		const s = pairServerProofString(input.clientNonce, input.serverNonce, input.clientId)
		expect(s).toBe(vectors.pairServerProof.stringToSign)
		expect(b64url(hmac(pairSecret, s))).toBe(vectors.pairServerProof.proof)
	})

	it('endpoint', () => {
		expect(endpointFor(input.port)).toBe(input.endpoint)
	})

	it('hello proof', () => {
		const s = helloProofString(input.endpoint, input.clientNonce, input.serverNonce, input.instanceId)
		expect(s).toBe(vectors.helloProof.stringToSign)
		expect(b64url(hmac(K, s))).toBe(vectors.helloProof.proof)
	})

	it.each(vectors.requests.map(r => [`${r.method} ${r.pathWithQuery}`, r] as const))('request %s', (_name, r) => {
		const body = Buffer.from(r.body, 'utf8')
		// Content-Length counts bytes, not characters: the POST vector has multi-byte text.
		expect(String(body.length)).toBe(r.contentLength)
		expect(sha256Hex(body)).toBe(r.bodySha256)
		const parts = { ...r, bodySha256: sha256Hex(body) }
		expect(requestStringToSign(parts)).toBe(r.stringToSign)
		expect(signRequest(K, parts)).toBe(r.signature)
		expect(verifyMac(K, r.stringToSign, r.signature)).toBe(true)
	})

	it.each(vectors.responses.map(r => [String(r.status), r] as const))('response %s', (_name, r) => {
		expect(responseStringToSign(r.endpoint, r.status, r.requestNonce, r.bodySha256)).toBe(r.stringToSign)
		expect(signResponse(K, r.endpoint, r.status, r.requestNonce, Buffer.from(r.body, 'utf8'))).toBe(r.signature)
	})

	it('workspace id', () => {
		const key = Buffer.from(vectors.workspaceId.keyHex, 'hex')
		expect(workspaceIdFor(key, vectors.workspaceId.realpath)).toBe(vectors.workspaceId.id)
	})
})

describe('encoding and comparison', () => {
	it('decodes only canonical unpadded base64url', () => {
		expect(fromB64url('AQID')?.equals(Buffer.from([1, 2, 3]))).toBe(true)
		expect(fromB64url('AQI=')).toBeNull() // padding
		expect(fromB64url('a+b/')).toBeNull() // standard alphabet
		expect(fromB64url('AQJ')).toBeNull() // non-zero trailing bits: a second spelling of AQI
	})

	it('verifyMac rejects a truncated, altered or garbage MAC without throwing', () => {
		const sig = vectors.requests[0].signature
		const s = vectors.requests[0].stringToSign
		expect(verifyMac(K, s, sig.slice(0, -2))).toBe(false)
		expect(verifyMac(K, s, (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1))).toBe(false)
		expect(verifyMac(K, s, '')).toBe(false)
		expect(verifyMac(K, s, 'not base64url!')).toBe(false)
		expect(verifyMac(K, s + 'x', sig)).toBe(false)
	})

	it('a request, response or hello proof made for one port does not verify for another', () => {
		// What stops a port squatter relaying to the app's real port: the MACs name the port.
		const other = endpointFor(input.port + 1)
		const r = vectors.requests[0]
		const parts = { ...r, endpoint: other }
		expect(verifyMac(K, requestStringToSign(parts), r.signature)).toBe(false)
		const res = vectors.responses[0]
		expect(verifyMac(K, responseStringToSign(other, res.status, res.requestNonce, res.bodySha256), res.signature)).toBe(false)
		const hello = helloProofString(other, input.clientNonce, input.serverNonce, input.instanceId)
		expect(verifyMac(K, hello, vectors.helloProof.proof)).toBe(false)
	})

	it('rejects malformed pairing strings', () => {
		expect(parsePairingString('ocpair1.23760.short.secret')).toBeNull()
		expect(parsePairingString(vectors.pairingString.replace('ocpair1', 'ocpair2'))).toBeNull()
		expect(parsePairingString(vectors.pairingString.replace('23760', '70000'))).toBeNull()
	})
})
