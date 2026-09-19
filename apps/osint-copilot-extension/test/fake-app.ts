// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * A stand-in for the desktop app's server, built with node:crypto straight from
 * PROTOCOL.md rather than from the extension's own signing code, so a mistake shared by
 * both would not cancel out. Only what the channel tests need: pair, hello and signed
 * GET/POST with signed replies.
 */
import { createHash, createHmac } from 'node:crypto';

export type Handler = (url: URL, init: RequestInit) => Promise<Response>;

const b64 = (buf: Buffer) => buf.toString('base64url');
const mac = (key: Buffer, s: string) => createHmac('sha256', key).update(s, 'utf8').digest();
const hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export interface FakeAppOptions {
	port: number;
	instanceId: string;
	/** Filled by pair(), or given to start already paired. */
	clientId?: string;
	key?: Buffer;
	pairSecret?: Buffer;
	serverNonce?: string;
	newClientId?: string;
	/** Answers signed routes; the reply is signed by the fake. `raw` is the body's bytes, for uploads. */
	route?: (method: string, path: string, body: string, raw: Buffer, headers: Record<string, string>) => { status: number; body: unknown };
}

function headersOf(init: RequestInit): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) out[k.toLowerCase()] = v;
	return out;
}

function bodyText(init: RequestInit): string {
	if (!init.body) return '';
	return Buffer.from(init.body as Uint8Array).toString('utf8');
}

export class FakeApp {
	readonly requests: { path: string; headers: Record<string, string>; body: string }[] = [];
	constructor(public opts: FakeAppOptions) {}

	get endpoint(): string {
		return `127.0.0.1:${this.opts.port}`;
	}

	handler: Handler = async (url, init) => {
		const headers = headersOf(init);
		const body = bodyText(init);
		this.requests.push({ path: url.pathname, headers, body });
		if (headers['x-oc-proto'] !== '1') return json(400, { error: 'bad_proto' });
		if (url.pathname === '/v1/pair') return this.pair(JSON.parse(body));
		if (url.pathname === '/v1/hello') return this.hello(JSON.parse(body));
		return this.signed(init.method ?? 'GET', url.pathname + url.search, headers, init.body as Uint8Array | undefined);
	};

	private pair(req: { pairingId: string; clientNonce: string; extVersion: string; proof: string }): Response {
		const secret = this.opts.pairSecret!;
		if (req.pairingId !== hex(secret).slice(0, 32)) return json(403, { error: 'pair_expired' });
		if (req.proof !== b64(mac(secret, `OCPAIR1\n${req.clientNonce}`))) return json(401, { error: 'bad_signature' });
		const clientId = this.opts.newClientId!;
		const serverNonce = this.opts.serverNonce!;
		this.opts.clientId = clientId;
		this.opts.key = mac(secret, `oc-k1\n${req.clientNonce}\n${serverNonce}\n${clientId}`);
		return json(200, {
			clientId,
			serverNonce,
			instanceId: this.opts.instanceId,
			serverProof: b64(mac(secret, `OCPAIR1S\n${req.clientNonce}\n${serverNonce}\n${clientId}`)),
		});
	}

	/** Exposed so a squatter can relay to it. */
	hello(req: { clientId: string; clientNonce: string }): Response {
		if (req.clientId !== this.opts.clientId || !this.opts.key) return json(401, { error: 'unauthenticated' });
		const serverNonce = b64(Buffer.alloc(16, 7));
		const s = `OCHELLO1\n${this.endpoint}\n${req.clientNonce}\n${serverNonce}\n${this.opts.instanceId}`;
		return json(200, {
			instanceId: this.opts.instanceId,
			serverNonce,
			serverProof: b64(mac(this.opts.key, s)),
			proto: { min: 1, max: 1 },
			appVersion: '0.13.1',
		});
	}

	private signed(method: string, pathWithQuery: string, h: Record<string, string>, raw?: Uint8Array): Response {
		const key = this.opts.key;
		if (!key || h['x-oc-client'] !== this.opts.clientId) return json(401, { error: 'unauthenticated' });
		const bytes = raw ? Buffer.from(raw) : Buffer.alloc(0);
		const contentLength = raw ? String(bytes.length) : '0';
		const s = ['OC1', this.endpoint, method, pathWithQuery, h['x-oc-ts'], h['x-oc-nonce'], h['x-oc-client'], contentLength, h['x-oc-body-sha256']].join('\n');
		if (h['x-oc-sig'] !== b64(mac(key, s))) return json(401, { error: 'bad_signature' });
		if (hex(bytes) !== h['x-oc-body-sha256']) return this.sign(h['x-oc-nonce'], 422, { error: 'hash_mismatch' });
		const out = this.opts.route?.(method, pathWithQuery, bytes.toString('utf8'), bytes, h) ?? { status: 404, body: { error: 'not_found' } };
		return this.sign(h['x-oc-nonce'], out.status, out.body);
	}

	sign(nonce: string, status: number, body: unknown): Response {
		const text = JSON.stringify(body);
		const sig = b64(mac(this.opts.key!, `OC1R\n${this.endpoint}\n${status}\n${nonce}\n${hex(text)}`));
		return json(status, body, { 'X-OC-Sig': sig });
	}
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** Routes fetch by port; a port with no handler refuses the connection, as a closed port does. */
export function fakeNetwork(handlers: Map<number, Handler>) {
	const calls: string[] = [];
	const fetch = async (input: string, init: RequestInit): Promise<Response> => {
		const url = new URL(input);
		calls.push(`${url.port} ${init.method ?? 'GET'} ${url.pathname}`);
		const handler = handlers.get(Number(url.port));
		if (!handler) throw new TypeError('fetch failed: connection refused');
		return handler(url, init);
	};
	return { fetch, calls };
}

/** Deterministic randomness: each call returns the next `n` bytes of a counter. */
export function counterBytes(start = 0) {
	let next = start;
	return (n: number) => Uint8Array.from({ length: n }, () => next++ & 0xff);
}
