// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { describe, expect, it } from 'vitest';
import { toB64url } from '../src/shared/b64url';
import { Channel, ChannelError } from '../src/sw/channel';
import { KEYS, type PairingRecord } from '../src/sw/storage';
import { FakeApp, counterBytes, fakeNetwork, json, type Handler } from './fake-app';
import { memoryKV } from './memory-kv';
import { fromHex, protocolVectors as v } from './vectors';

const KEY = Buffer.from(v.keyDerivation.keyHex, 'hex');
const INSTANCE = v.inputs.instanceId as string;
const CLIENT = v.inputs.clientId as string;

function pairedRecord(port: number, pairingPort = port): PairingRecord {
	return { clientId: CLIENT, key: v.keyDerivation.key, instanceId: INSTANCE, port, pairingPort, pairedAt: 1 };
}

function app(port: number, extra: Partial<ConstructorParameters<typeof FakeApp>[0]> = {}) {
	return new FakeApp({ port, instanceId: INSTANCE, clientId: CLIENT, key: KEY, ...extra });
}

function channelFor(handlers: Map<number, Handler>, record?: PairingRecord) {
	const storage = memoryKV(record ? { [KEYS.pairing]: record } : {});
	const net = fakeNetwork(handlers);
	const channel = new Channel({ fetch: net.fetch, storage, now: () => 1760000000000, randomBytes: counterBytes(0xa0) });
	return { channel, storage, net };
}

describe('pair', () => {
	function pairingApp() {
		return new FakeApp({
			port: 23760,
			instanceId: INSTANCE,
			pairSecret: Buffer.from(fromHex(v.inputs.pairSecretHex)!),
			serverNonce: v.inputs.serverNonce,
			newClientId: CLIENT,
		});
	}

	it('sends the vector pairingId and proof, derives the vector K, and keeps no pairSecret', async () => {
		const fake = pairingApp();
		const { channel, storage } = channelFor(new Map([[23760, fake.handler]]));
		const result = await channel.pair(v.pairingString, '0.1.0');
		expect(result).toEqual({ ok: true, instanceId: INSTANCE, port: 23760, connected: true });

		const sent = JSON.parse(fake.requests[0].body);
		expect(sent).toEqual({ pairingId: v.pairingId, clientNonce: v.inputs.clientNonce, extVersion: '0.1.0', proof: v.pairProof.proof });
		expect(fake.requests[0].headers['content-type']).toBe('application/json');

		const record = await storage.get<PairingRecord>(KEYS.pairing);
		expect(record).toMatchObject({ clientId: CLIENT, key: v.keyDerivation.key, instanceId: INSTANCE, port: 23760, pairingPort: 23760 });
		expect(JSON.stringify([...storage.data])).not.toContain(v.inputs.pairSecret);
		// hello ran after pairing, and verified.
		expect(fake.requests[1].path).toBe('/v1/hello');
		expect(channel.connectedPort).toBe(23760);
	});

	it('refuses a malformed pairing string without sending anything', async () => {
		const { channel, net } = channelFor(new Map());
		expect(await channel.pair('ocpair1.23760.short.secret', '0.1.0')).toEqual({ ok: false, error: 'malformed_pairing' });
		expect(net.calls).toEqual([]);
	});

	it('says plainly when nothing is listening on the pairing string\'s port', async () => {
		const { channel, storage } = channelFor(new Map());
		expect(await channel.pair(v.pairingString, '0.1.0')).toEqual({ ok: false, error: 'pair_unreachable', detail: 'port 23760' });
		expect(await storage.get(KEYS.pairing)).toBeUndefined();
	});

	it('refuses a reply from a different instance than the pairing string named', async () => {
		const fake = pairingApp();
		fake.opts.instanceId = toB64url(new Uint8Array(16).fill(9));
		const { channel, storage } = channelFor(new Map([[23760, fake.handler]]));
		expect(await channel.pair(v.pairingString, '0.1.0')).toEqual({ ok: false, error: 'wrong_instance' });
		expect(await storage.get(KEYS.pairing)).toBeUndefined();
	});

	it('refuses a reply whose serverProof does not verify', async () => {
		const forged: Handler = async () => json(200, {
			clientId: CLIENT, serverNonce: v.inputs.serverNonce, instanceId: INSTANCE, serverProof: v.pairProof.proof,
		});
		const { channel, storage } = channelFor(new Map([[23760, forged]]));
		expect(await channel.pair(v.pairingString, '0.1.0')).toEqual({ ok: false, error: 'bad_proof' });
		expect(await storage.get(KEYS.pairing)).toBeUndefined();
	});

	it('passes the app\'s refusal through for the panel to explain', async () => {
		const expired: Handler = async () => json(403, { error: 'pair_expired' });
		const { channel } = channelFor(new Map([[23760, expired]]));
		expect(await channel.pair(v.pairingString, '0.1.0')).toEqual({ ok: false, error: 'pair_expired', detail: undefined });
	});
});

describe('hello', () => {
	it('verifies our app on the port it holds', async () => {
		const real = app(23760);
		const { channel } = channelFor(new Map([[23760, real.handler]]), pairedRecord(23760));
		expect(await channel.hello(23760)).toEqual({ ok: true, appVersion: '0.13.1' });
	});

	it('rejects a proof relayed from another port', async () => {
		const real = app(23761);
		// The squatter holds our remembered port and forwards hello to the real app.
		const relay: Handler = async (_url, init) => real.hello(JSON.parse(Buffer.from(init.body as Uint8Array).toString()));
		const { channel } = channelFor(new Map([[23760, relay], [23761, real.handler]]), pairedRecord(23760));
		expect(await channel.hello(23760)).toEqual({ ok: false, reason: 'unverified' });
		expect(await channel.hello(23761)).toEqual({ ok: true, appVersion: '0.13.1' });
	});

	it('rejects a valid-looking proof from a different instance', async () => {
		const other = app(23760, { instanceId: toB64url(new Uint8Array(16).fill(3)) });
		const { channel } = channelFor(new Map([[23760, other.handler]]), pairedRecord(23760));
		expect(await channel.hello(23760)).toEqual({ ok: false, reason: 'unverified' });
	});

	it('rejects a proof made with another key', async () => {
		const impostor = app(23760, { key: Buffer.alloc(32, 1) });
		const { channel } = channelFor(new Map([[23760, impostor.handler]]), pairedRecord(23760));
		expect(await channel.hello(23760)).toEqual({ ok: false, reason: 'unverified' });
	});
});

describe('port discovery', () => {
	it('skips a squatter and a closed port, finds the real app, and remembers its port', async () => {
		const real = app(23763, {
			route: (method, path) => method === 'GET' && path === '/v1/workspaces'
				? { status: 200, body: { workspaces: [] } } : { status: 404, body: { error: 'not_found' } },
		});
		const squatter: Handler = async () => json(200, {
			instanceId: INSTANCE, serverNonce: 'AAAAAAAAAAAAAAAAAAAAAA', serverProof: 'x'.repeat(43), proto: { min: 1, max: 1 }, appVersion: '9',
		});
		const relay: Handler = async (_u, init) => real.hello(JSON.parse(Buffer.from(init.body as Uint8Array).toString()));
		const { channel, storage, net } = channelFor(
			new Map([[23760, squatter], [23761, relay], [23763, real.handler]]),
			pairedRecord(23760, 23761),
		);
		const res = await channel.request('GET', '/v1/workspaces');
		expect(res).toEqual({ status: 200, body: { workspaces: [] } });
		expect(channel.connectedPort).toBe(23763);
		expect((await storage.get<PairingRecord>(KEYS.pairing))!.port).toBe(23763);
		// Stored port, pairing port, then the rest in order; the signed request only to the verified one.
		expect(net.calls).toEqual([
			'23760 POST /v1/hello',
			'23761 POST /v1/hello',
			'23762 POST /v1/hello',
			'23763 POST /v1/hello',
			'23763 GET /v1/workspaces',
		]);
	});

	it('sends nothing signed when no port verifies: there is no fallback', async () => {
		const squatter: Handler = async () => json(200, { workspaces: [] });
		const { channel, net } = channelFor(new Map([[23760, squatter]]), pairedRecord(23760));
		await expect(channel.request('POST', '/v1/bundles', { x: 1 })).rejects.toBeInstanceOf(ChannelError);
		expect(net.calls.filter(c => !c.endsWith('/v1/hello'))).toEqual([]);
		// Something answered on our port without proving itself; the panel says so.
		expect(channel.lastProblem).toBe('unverified');
	});

	it('says an impostor answered when one did', async () => {
		const impostor = app(23760, { key: Buffer.alloc(32, 1) });
		const { channel } = channelFor(new Map([[23760, impostor.handler]]), pairedRecord(23760));
		await expect(channel.connect()).rejects.toMatchObject({ code: 'unverified' });
		expect(channel.lastProblem).toBe('unverified');
	});
});

describe('port discovery, rate limited', () => {
	it('says the app is slowing us down, not that it is not running', async () => {
		const limited: Handler = async () => json(429, { error: 'rate_limited' });
		const { channel } = channelFor(new Map([[23760, limited]]), pairedRecord(23760));
		await expect(channel.connect()).rejects.toBeInstanceOf(ChannelError);
		expect(channel.lastProblem).toBe('rate_limited');
	});
});

describe('signed requests', () => {
	function withReply(transform: (res: Response, nonce: string, fake: FakeApp) => Response | Promise<Response>) {
		const real = app(23760, { route: () => ({ status: 200, body: { status: 'accepted', bundleId: 'b', receivedAt: 't' } }) });
		const handler: Handler = async (url, init) => {
			const res = await real.handler(url, init);
			if (url.pathname === '/v1/hello') return res;
			const nonce = (init.headers as Record<string, string>)['X-OC-Nonce'];
			return transform(res, nonce, real);
		};
		return channelFor(new Map([[23760, handler]]), pairedRecord(23760));
	}

	it('signs the request as §6.2 says and returns a verified reply', async () => {
		const real = app(23760, { route: (_m, _p, body) => ({ status: 200, body: { echo: JSON.parse(body) } }) });
		const { channel } = channelFor(new Map([[23760, real.handler]]), pairedRecord(23760));
		const res = await channel.request('POST', '/v1/bundles', { note: 'Café — ok' });
		expect(res).toEqual({ status: 200, body: { echo: { note: 'Café — ok' } } });
		const sent = real.requests.at(-1)!;
		expect(sent.headers['x-oc-client']).toBe(CLIENT);
		expect(sent.headers['x-oc-ts']).toBe('1760000000000');
		expect(sent.headers['x-oc-nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/);
	});

	it('treats a reply with no signature as no reply', async () => {
		const { channel } = withReply(res => new Response(res.body, { status: res.status }));
		await expect(channel.request('GET', '/v1/status')).rejects.toMatchObject({ code: 'unverified' });
		// And proves the app again before the next request.
		expect(channel.connectedPort).toBeNull();
	});

	it('treats a reply with a bad signature as no reply', async () => {
		const { channel } = withReply(async res => new Response(await res.text(), { status: res.status, headers: { 'X-OC-Sig': 'A'.repeat(43) } }));
		await expect(channel.request('GET', '/v1/status')).rejects.toMatchObject({ code: 'unverified' });
	});

	it('rejects a genuine signature over a different status', async () => {
		const { channel } = withReply(async res => new Response(await res.text(), { status: 201, headers: { 'X-OC-Sig': res.headers.get('X-OC-Sig')! } }));
		await expect(channel.request('GET', '/v1/status')).rejects.toMatchObject({ code: 'unverified' });
	});

	it('rejects a genuine signature over a different body', async () => {
		const { channel } = withReply(res => new Response('{"status":"accepted"}', { status: res.status, headers: { 'X-OC-Sig': res.headers.get('X-OC-Sig')! } }));
		await expect(channel.request('GET', '/v1/status')).rejects.toMatchObject({ code: 'unverified' });
	});

	it('rejects a reply replayed from another request', async () => {
		let first: { text: string; sig: string } | null = null;
		const { channel } = withReply(async res => {
			const text = await res.text();
			const sig = res.headers.get('X-OC-Sig')!;
			first ??= { text, sig };
			return new Response(first.text, { status: 200, headers: { 'X-OC-Sig': first.sig } });
		});
		await channel.request('GET', '/v1/status');
		await expect(channel.request('GET', '/v1/status')).rejects.toMatchObject({ code: 'unverified' });
	});

	it('accepts a signed error, which is the app\'s real answer', async () => {
		const { channel } = withReply((_res, nonce, fake) => fake.sign(nonce, 404, { error: 'unknown_workspace' }));
		expect(await channel.request('POST', '/v1/bundles', {})).toEqual({ status: 404, body: { error: 'unknown_workspace' } });
	});
});
