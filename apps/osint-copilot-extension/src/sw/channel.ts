// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The authenticated channel to the desktop app: pairing, hello and signed requests
 * (PROTOCOL.md §5-7).
 *
 * Anything on this machine can listen on 127.0.0.1, so nothing here trusts a reply for
 * where it came from. A port is used only after hello proves, under K, that our paired
 * app instance holds that exact port; every signed response is verified under K and bound
 * to the port we dialled, and one that does not verify is a failure, never a fallback.
 *
 * Everything with side effects is injected (fetch, storage, clock, randomness) so the
 * whole handshake runs in Node tests against a fake server built from the same strings.
 */
import { fromB64url, toB64url } from '../shared/b64url';
import {
	B64URL_16,
	B64URL_32,
	EXT_VERSION,
	HEADER,
	PORTS,
	PROTO,
	baseUrl,
	endpointFor,
	parsePairingString,
	type ErrorBody,
	type HelloResponse,
	type PairRequest,
	type PairResponse,
} from '../shared/protocol';
import {
	EMPTY_SHA256,
	hmac,
	hmacB64url,
	helloProofString,
	keyDerivationString,
	pairProofString,
	pairServerProofString,
	pairingIdFor,
	requestStringToSign,
	responseStringToSign,
	sha256Hex,
	utf8,
	verifyMac,
} from '../shared/signing';
import { KEYS, type KV, type PairingRecord } from './storage';

export interface ChannelDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	storage: KV;
	now: () => number;
	randomBytes: (n: number) => Uint8Array;
	/** A probe that hangs must not stall discovery of the port the app really holds. */
	probeTimeoutMs?: number;
	requestTimeoutMs?: number;
}

export type ChannelErrorCode = 'not_paired' | 'unreachable' | 'unverified' | 'bad_response';

/** A failure with no trustworthy answer from the app: retry later, never act on it. */
export class ChannelError extends Error {
	constructor(readonly code: ChannelErrorCode, message?: string) {
		super(message ?? code);
	}
}

export type PairResult =
	| { ok: true; instanceId: string; port: number; connected: boolean }
	| { ok: false; error: string; detail?: string };

export type HelloResult =
	| { ok: true; appVersion: string }
	| { ok: false; reason: 'unreachable' | 'refused' | 'unverified'; status?: number };

/** A response whose signature verified: its status and body really are the app's. */
export interface SignedResponse {
	status: number;
	body: unknown;
}

const JSON_TYPE = 'application/json';

export function webDeps(storage: KV): ChannelDeps {
	return {
		fetch: (url, init) => fetch(url, init),
		storage,
		now: () => Date.now(),
		randomBytes: n => crypto.getRandomValues(new Uint8Array(n)),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
}

export function errorCodeOf(body: unknown): string | undefined {
	return isRecord(body) && typeof body.error === 'string' ? body.error : undefined;
}

export class Channel {
	/** The port hello verified in this service-worker lifetime; null means "check again". */
	private verifiedPort: number | null = null;
	private connecting: Promise<number> | null = null;
	appVersion: string | null = null;
	/** Why the last connect failed, for the side panel. */
	lastProblem: string | null = null;

	constructor(private readonly deps: ChannelDeps) {}

	pairing(): Promise<PairingRecord | undefined> {
		return this.deps.storage.get<PairingRecord>(KEYS.pairing);
	}

	get connectedPort(): number | null {
		return this.verifiedPort;
	}

	private nonce(): string {
		return toB64url(this.deps.randomBytes(16));
	}

	private async post(port: number, path: string, body: unknown, timeoutMs: number): Promise<Response> {
		return this.deps.fetch(`${baseUrl(port)}${path}`, {
			method: 'POST',
			headers: { [HEADER.proto]: String(PROTO), 'Content-Type': JSON_TYPE },
			body: utf8(JSON.stringify(body)),
			credentials: 'omit',
			cache: 'no-store',
			redirect: 'error',
			signal: AbortSignal.timeout(timeoutMs),
		});
	}

	// --- pairing (§5) ----------------------------------------------------------------

	async pair(pairingString: string, extVersion: string): Promise<PairResult> {
		const parsed = parsePairingString(pairingString);
		if (!parsed) return { ok: false, error: 'malformed_pairing' };
		if (!EXT_VERSION.test(extVersion)) return { ok: false, error: 'bad_response', detail: 'extension version' };
		const secret = fromB64url(parsed.pairSecret)!;
		try {
			const clientNonce = this.nonce();
			const request: PairRequest = {
				pairingId: await pairingIdFor(new Uint8Array(secret)),
				clientNonce,
				extVersion,
				proof: await hmacB64url(secret, pairProofString(clientNonce)),
			};

			let res: Response;
			try {
				// Long timeout: the app holds the reply open while the user answers its confirm dialog.
				res = await this.post(parsed.port, '/pair', request, 2 * 60_000);
			} catch {
				return { ok: false, error: 'pair_unreachable', detail: `port ${parsed.port}` };
			}
			let body: unknown;
			try {
				body = parseJson(new Uint8Array(await res.arrayBuffer()));
			} catch {
				return { ok: false, error: 'pair_unreachable', detail: `port ${parsed.port}` };
			}
			if (res.status !== 200) {
				// Unauthenticated, so only ever shown, never acted on beyond "pairing failed".
				const code = errorCodeOf(body) ?? 'bad_response';
				const detail = isRecord(body) && typeof body.detail === 'string' ? body.detail : undefined;
				return { ok: false, error: code, detail };
			}
			if (!isPairResponse(body)) return { ok: false, error: 'bad_response' };
			if (body.instanceId !== parsed.instanceId) return { ok: false, error: 'wrong_instance' };
			const proofOk = await verifyMac(secret, pairServerProofString(clientNonce, body.serverNonce, body.clientId), body.serverProof);
			if (!proofOk) return { ok: false, error: 'bad_proof' };

			const key = await hmac(secret, keyDerivationString(clientNonce, body.serverNonce, body.clientId));
			const record: PairingRecord = {
				clientId: body.clientId,
				key: toB64url(key),
				instanceId: body.instanceId,
				port: parsed.port,
				pairingPort: parsed.port,
				pairedAt: this.deps.now(),
			};
			await this.deps.storage.set({ [KEYS.pairing]: record });
			this.verifiedPort = null;
			let connected = true;
			try {
				await this.connect();
			} catch {
				connected = false;
			}
			return { ok: true, instanceId: body.instanceId, port: this.verifiedPort ?? parsed.port, connected };
		} finally {
			// pairSecret was on screen and in the clipboard; it has no use once K exists.
			secret.fill(0);
		}
	}

	async unpair(): Promise<void> {
		await this.deps.storage.remove([KEYS.pairing, KEYS.workspaces, KEYS.selectedWorkspace]);
		this.verifiedPort = null;
		this.appVersion = null;
	}

	// --- hello (§7.2) ------------------------------------------------------------------

	/**
	 * Proves the process on `port` holds our K and is our paired instance, bound to this
	 * very port: a squatter relaying hello to the app on another port gets a proof naming
	 * that other port, which fails here.
	 */
	async hello(port: number, record?: PairingRecord): Promise<HelloResult> {
		const pairing = record ?? (await this.pairing());
		if (!pairing) return { ok: false, reason: 'refused' };
		const key = fromB64url(pairing.key);
		if (!key || key.length !== 32) return { ok: false, reason: 'refused' };
		const clientNonce = this.nonce();
		let res: Response;
		try {
			res = await this.post(port, '/hello', { clientId: pairing.clientId, clientNonce }, this.deps.probeTimeoutMs ?? 3000);
		} catch {
			return { ok: false, reason: 'unreachable' };
		}
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await res.arrayBuffer());
		} catch {
			return { ok: false, reason: 'unreachable' };
		}
		if (res.status !== 200) return { ok: false, reason: 'refused', status: res.status };
		const body = parseJson(bytes);
		if (!isHelloResponse(body)) return { ok: false, reason: 'unverified' };
		if (body.instanceId !== pairing.instanceId) return { ok: false, reason: 'unverified' };
		if (!(body.proto.min <= PROTO && PROTO <= body.proto.max)) return { ok: false, reason: 'refused' };
		const proof = helloProofString(endpointFor(port), clientNonce, body.serverNonce, body.instanceId);
		if (!(await verifyMac(key, proof, body.serverProof))) return { ok: false, reason: 'unverified' };
		return { ok: true, appVersion: body.appVersion };
	}

	/**
	 * Finds the port our app holds: the last verified one, then the pairing string's, then
	 * the protocol's five. A port counts only when hello verifies on it. There is no
	 * fallback: if nothing verifies, nothing is sent.
	 */
	connect(): Promise<number> {
		if (this.verifiedPort !== null) return Promise.resolve(this.verifiedPort);
		// One discovery at a time; concurrent callers share its outcome.
		this.connecting ??= this.discover().finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	private async discover(): Promise<number> {
		const pairing = await this.pairing();
		if (!pairing) throw new ChannelError('not_paired');
		const candidates = [...new Set([pairing.port, pairing.pairingPort, ...PORTS])];
		let sawRefusal = false;
		let sawImpostor = false;
		let sawRateLimit = false;
		for (const port of candidates) {
			const result = await this.hello(port, pairing);
			if (result.ok) {
				this.verifiedPort = port;
				this.appVersion = result.appVersion;
				this.lastProblem = null;
				if (pairing.port !== port) await this.deps.storage.set({ [KEYS.pairing]: { ...pairing, port } });
				return port;
			}
			if (result.reason === 'refused' && result.status === 401) sawRefusal = true;
			if (result.reason === 'refused' && result.status === 429) sawRateLimit = true;
			if (result.reason === 'unverified') sawImpostor = true;
		}
		// Unsigned refusals prove nothing about who sent them, so they are hints for the user only.
		const code = sawImpostor ? 'unverified' : sawRefusal ? 'unauthenticated' : sawRateLimit ? 'rate_limited' : 'unreachable';
		this.lastProblem = code;
		throw new ChannelError(sawImpostor ? 'unverified' : 'unreachable', code);
	}

	/** Forget the verified port, so the next request proves the app's identity again. */
	reset(): void {
		this.verifiedPort = null;
	}

	// --- signed requests (§6) ----------------------------------------------------------

	/**
	 * Sends a signed request and returns the response only if its signature verifies under
	 * K for this port and this request's nonce. Throws ChannelError otherwise; the caller
	 * must treat that as "no answer", which for a bundle means retry with the same bundleId.
	 */
	async request(method: 'GET' | 'POST', pathWithQuery: string, body?: unknown): Promise<SignedResponse> {
		const pairing = await this.pairing();
		if (!pairing) throw new ChannelError('not_paired');
		const key = fromB64url(pairing.key);
		if (!key || key.length !== 32) throw new ChannelError('not_paired');
		const port = await this.connect();
		const endpoint = endpointFor(port);

		const bytes = method === 'POST' ? utf8(JSON.stringify(body ?? {})) : null;
		const ts = String(this.deps.now());
		const nonce = this.nonce();
		const bodySha256 = bytes ? await sha256Hex(bytes) : EMPTY_SHA256;
		const contentLength = bytes ? String(bytes.length) : '0';
		const sig = await hmacB64url(key, requestStringToSign({
			endpoint,
			method,
			pathWithQuery,
			ts,
			nonce,
			clientId: pairing.clientId,
			contentLength,
			bodySha256,
		}));
		const headers: Record<string, string> = {
			[HEADER.proto]: String(PROTO),
			[HEADER.client]: pairing.clientId,
			[HEADER.ts]: ts,
			[HEADER.nonce]: nonce,
			[HEADER.bodySha256]: bodySha256,
			[HEADER.sig]: sig,
		};
		if (bytes) headers['Content-Type'] = JSON_TYPE;

		let res: Response;
		let responseBytes: Uint8Array<ArrayBuffer>;
		try {
			// A Uint8Array body goes out with a Content-Length, which is what we signed.
			res = await this.deps.fetch(`http://${endpoint}${pathWithQuery}`, {
				method,
				headers,
				body: bytes ?? undefined,
				credentials: 'omit',
				cache: 'no-store',
				redirect: 'error',
				signal: AbortSignal.timeout(this.deps.requestTimeoutMs ?? 30_000),
			});
			responseBytes = new Uint8Array(await res.arrayBuffer());
		} catch {
			this.verifiedPort = null;
			throw new ChannelError('unreachable');
		}

		const given = res.headers.get(HEADER.sig);
		const expected = responseStringToSign(endpoint, res.status, nonce, await sha256Hex(responseBytes));
		if (!given || !(await verifyMac(key, expected, given))) {
			// Could be a squatter, or the app refusing us unsigned (revoked, restarted with
			// a new port). Either way it is not an answer; prove the app again next time.
			this.verifiedPort = null;
			throw new ChannelError('unverified');
		}
		const parsed = parseJson(responseBytes);
		if (parsed === undefined) throw new ChannelError('bad_response');
		return { status: res.status, body: parsed };
	}
}

function isPairResponse(body: unknown): body is PairResponse {
	return isRecord(body)
		&& typeof body.clientId === 'string' && B64URL_16.test(body.clientId)
		&& typeof body.serverNonce === 'string' && B64URL_16.test(body.serverNonce)
		&& typeof body.instanceId === 'string' && B64URL_16.test(body.instanceId)
		&& typeof body.serverProof === 'string' && B64URL_32.test(body.serverProof);
}

function isHelloResponse(body: unknown): body is HelloResponse {
	return isRecord(body)
		&& typeof body.instanceId === 'string'
		&& typeof body.serverNonce === 'string' && B64URL_16.test(body.serverNonce)
		&& typeof body.serverProof === 'string'
		&& isRecord(body.proto) && typeof body.proto.min === 'number' && typeof body.proto.max === 'number'
		&& typeof body.appVersion === 'string';
}

export type { ErrorBody };
