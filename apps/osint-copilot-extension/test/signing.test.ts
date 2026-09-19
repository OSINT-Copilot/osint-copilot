// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { describe, expect, it } from 'vitest';
import { fromB64url, toB64url, toHex } from '../src/shared/b64url';
import { endpointFor, parsePairingString } from '../src/shared/protocol';
import {
	EMPTY_SHA256,
	helloProofString,
	hmac,
	hmacB64url,
	keyDerivationString,
	pairProofString,
	pairServerProofString,
	pairingIdFor,
	requestStringToSign,
	responseStringToSign,
	sha256Hex,
	utf8,
	verifyMac,
} from '../src/shared/signing';
import { fromHex, protocolVectors as v } from './vectors';

const secret = fromHex(v.inputs.pairSecretHex)!;

describe('protocol vectors', () => {
	it('encodes the inputs as the vectors do', async () => {
		expect(toB64url(secret)).toBe(v.inputs.pairSecret);
		expect(endpointFor(v.inputs.port)).toBe(v.inputs.endpoint);
		expect(await sha256Hex('')).toBe(EMPTY_SHA256);
	});

	it('parses the pairing string', () => {
		expect(parsePairingString(v.pairingString)).toEqual({
			port: v.inputs.port,
			instanceId: v.inputs.instanceId,
			pairSecret: v.inputs.pairSecret,
		});
	});

	it('pairingId', async () => {
		expect(await pairingIdFor(secret)).toBe(v.pairingId);
	});

	it('pair proof', async () => {
		const s = pairProofString(v.inputs.clientNonce);
		expect(s).toBe(v.pairProof.stringToSign);
		expect(await hmacB64url(secret, s)).toBe(v.pairProof.proof);
	});

	it('key derivation', async () => {
		const s = keyDerivationString(v.inputs.clientNonce, v.inputs.serverNonce, v.inputs.clientId);
		expect(s).toBe(v.keyDerivation.stringToSign);
		const key = await hmac(secret, s);
		expect(toHex(key)).toBe(v.keyDerivation.keyHex);
		expect(toB64url(key)).toBe(v.keyDerivation.key);
	});

	it('pair server proof', async () => {
		const s = pairServerProofString(v.inputs.clientNonce, v.inputs.serverNonce, v.inputs.clientId);
		expect(s).toBe(v.pairServerProof.stringToSign);
		expect(await verifyMac(secret, s, v.pairServerProof.proof)).toBe(true);
	});

	it('hello proof, bound to the endpoint', async () => {
		const key = fromHex(v.keyDerivation.keyHex)!;
		const s = helloProofString(v.inputs.endpoint, v.inputs.clientNonce, v.inputs.serverNonce, v.inputs.instanceId);
		expect(s).toBe(v.helloProof.stringToSign);
		expect(await hmacB64url(key, s)).toBe(v.helloProof.proof);
		const otherPort = helloProofString(endpointFor(v.inputs.port + 1), v.inputs.clientNonce, v.inputs.serverNonce, v.inputs.instanceId);
		expect(await verifyMac(key, otherPort, v.helloProof.proof)).toBe(false);
	});

	it.each((v.requests as any[]).map((r): [string, any] => [r.method, r]))('%s request signature', async (_m, r: any) => {
		const key = fromHex(v.keyDerivation.keyHex)!;
		const body = utf8(r.body);
		expect(String(body.length)).toBe(r.contentLength);
		expect(await sha256Hex(body)).toBe(r.bodySha256);
		const s = requestStringToSign({
			endpoint: r.endpoint,
			method: r.method,
			pathWithQuery: r.pathWithQuery,
			ts: r.ts,
			nonce: r.nonce,
			clientId: r.clientId,
			contentLength: r.contentLength,
			bodySha256: r.bodySha256,
		});
		expect(s).toBe(r.stringToSign);
		expect(await hmacB64url(key, s)).toBe(r.signature);
	});

	it.each((v.responses as any[]).map((r): [number, any] => [r.status, r]))('%s response signature', async (_s, r: any) => {
		const key = fromHex(v.keyDerivation.keyHex)!;
		expect(await sha256Hex(r.body)).toBe(r.bodySha256);
		const s = responseStringToSign(r.endpoint, r.status, r.requestNonce, r.bodySha256);
		expect(s).toBe(r.stringToSign);
		expect(await verifyMac(key, s, r.signature)).toBe(true);
		expect(await verifyMac(key, responseStringToSign(r.endpoint, r.status === 200 ? 201 : 200, r.requestNonce, r.bodySha256), r.signature)).toBe(false);
	});
});

describe('base64url', () => {
	it('round-trips every length', () => {
		for (let n = 0; n < 40; n++) {
			const bytes = Uint8Array.from({ length: n }, (_x, i) => (i * 37 + n) & 0xff);
			const text = toB64url(bytes);
			expect(text).toBe(Buffer.from(bytes).toString('base64url'));
			expect(fromB64url(text)).toEqual(bytes);
		}
	});

	it('refuses padding, the standard alphabet and non-canonical trailing bits', () => {
		expect(fromB64url('AA==')).toBeNull();
		expect(fromB64url('a+b/')).toBeNull();
		expect(fromB64url('AB')).toBeNull(); // 'B' leaves a non-zero spare bit
		expect(fromB64url('A')).toBeNull();
		expect(fromB64url('AA')).toEqual(new Uint8Array([0]));
	});
});

describe('pairing strings', () => {
	const good = v.pairingString as string;
	it('forgives surrounding whitespace from copy and paste', () => {
		expect(parsePairingString(`  ${good}\n`)?.port).toBe(23760);
	});

	it.each([
		['empty', ''],
		['wrong prefix', good.replace('ocpair1', 'ocpair2')],
		['no port', good.replace('.23760.', '..')],
		['port 0', good.replace('.23760.', '.0.')],
		['port too large', good.replace('.23760.', '.65536.')],
		['port with a leading zero', good.replace('.23760.', '.023760.')],
		['short instanceId', good.replace(v.inputs.instanceId, v.inputs.instanceId.slice(1))],
		['short secret', good.slice(0, -1)],
		['long secret', `${good}A`],
		['non-canonical secret', `${good.slice(0, -1)}9`],
		['padded secret', `${good.slice(0, -1)}=`],
		['standard alphabet', good.replace(v.inputs.pairSecret, `+${v.inputs.pairSecret.slice(1)}`)],
		['extra field', `${good}.x`],
		['embedded space', good.replace('.', '. ')],
	])('rejects %s', (_name, text) => {
		expect(parsePairingString(text)).toBeNull();
	});
});
