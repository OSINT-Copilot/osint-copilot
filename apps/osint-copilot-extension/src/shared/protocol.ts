// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Wire protocol v1, the extension's half.
 *
 * apps/tangent-electron/src/main/osint/extension/PROTOCOL.md is normative. These are the
 * constants and shapes it fixes, restated here because the extension is its own package
 * and must not import the app's main-process code. The shared vectors
 * (protocol-vectors.json, entity-vectors.json) pin both halves to the same bytes.
 */

import { fromB64url } from './b64url';

export const PROTO = 1;

export const HOST = '127.0.0.1';
/** The app binds the first free one of these; the pairing string says which (§2). */
export const PORTS: readonly number[] = [23760, 23761, 23762, 23763, 23764];

export const HEADER = {
	proto: 'X-OC-Proto',
	client: 'X-OC-Client',
	ts: 'X-OC-Ts',
	nonce: 'X-OC-Nonce',
	bodySha256: 'X-OC-Body-Sha256',
	sig: 'X-OC-Sig',
} as const;

export const MAX_CONTROL_BODY = 256 * 1024;

export const B64URL_16 = /^[A-Za-z0-9_-]{22}$/;
export const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
export const WORKSPACE_ID = /^[A-Za-z0-9_-]{22}$/;
export const EXT_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

export type ErrorCode =
	| 'bad_proto'
	| 'bad_json'
	| 'bad_content_type'
	| 'unauthenticated'
	| 'bad_signature'
	| 'clock_skew'
	| 'replay'
	| 'forbidden'
	| 'bad_origin'
	| 'pair_expired'
	| 'pair_denied'
	| 'unlicensed'
	| 'not_found'
	| 'method_not_allowed'
	| 'unknown_workspace'
	| 'too_large'
	| 'bad_host'
	| 'invalid'
	| 'hash_mismatch'
	| 'rate_limited'
	| 'budget_exceeded'
	| 'internal';

export interface ErrorBody {
	error: ErrorCode;
	detail?: string;
}

// --- handshake -----------------------------------------------------------------------

export interface PairRequest {
	pairingId: string;
	clientNonce: string;
	extVersion: string;
	proof: string;
}

export interface PairResponse {
	clientId: string;
	serverNonce: string;
	instanceId: string;
	serverProof: string;
}

export interface HelloRequest {
	clientId: string;
	clientNonce: string;
}

export interface HelloResponse {
	instanceId: string;
	serverNonce: string;
	serverProof: string;
	proto: { min: number; max: number };
	appVersion: string;
}

// --- signed endpoints ----------------------------------------------------------------

export interface StatusResponse {
	licensed: boolean;
	receiving: boolean;
	pendingCount: number;
}

export interface WorkspaceInfo {
	id: string;
	name: string;
	open: boolean;
}

export interface WorkspacesResponse {
	workspaces: WorkspaceInfo[];
}

export interface BundleResponse {
	status: 'accepted' | 'duplicate';
	bundleId: string;
	receivedAt: string;
}

// --- manifest (§8) -------------------------------------------------------------------

export const ENTITY_KINDS = ['email', 'phone', 'username', 'domain', 'url', 'ip', 'wallet'] as const;
export type EntityKind = typeof ENTITY_KINDS[number];
export const WALLET_CHAINS = ['btc', 'eth', 'other'] as const;
export type WalletChain = typeof WALLET_CHAINS[number];

export const LIMITS = {
	pageUrl: 2048,
	pageTitle: 1024,
	noteText: 20_000,
	entityValue: 512,
	entityContext: 500,
	platform: 40,
	clientTime: 64,
} as const;

export const PLATFORM = /^[a-z0-9.-]{1,40}$/;

export interface ManifestPage {
	url: string;
	title: string;
}

interface ManifestBase {
	v: 1;
	bundleId: string;
	workspaceId: string;
	page: ManifestPage;
	clientTime: string;
}

export interface NoteManifest extends ManifestBase {
	kind: 'note';
	note: { text: string };
}

export interface EntityPayload {
	kind: EntityKind;
	value: string;
	chain?: WalletChain;
	platform?: string;
	context?: string;
}

export interface EntityManifest extends ManifestBase {
	kind: 'entity';
	entity: EntityPayload;
}

export type Manifest = NoteManifest | EntityManifest;

// --- the pairing string (§5.1) -------------------------------------------------------

export interface ParsedPairingString {
	port: number;
	instanceId: string;
	/** base64url, 32 bytes once decoded. */
	pairSecret: string;
}

/**
 * `ocpair1.<port>.<instanceId>.<pairSecret>`. Whitespace around it is forgiven, because it
 * arrives by copy and paste; anything else malformed is refused before a byte is sent.
 */
export function parsePairingString(text: string): ParsedPairingString | null {
	if (typeof text !== 'string') return null;
	const m = /^ocpair1\.([1-9]\d{0,4})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(text.trim());
	if (!m) return null;
	const port = Number(m[1]);
	if (port < 1 || port > 65535) return null;
	// Decoding strictly refuses non-canonical trailing bits, which would give the same bytes
	// under a different text.
	const id = fromB64url(m[2]);
	const secret = fromB64url(m[3]);
	if (!id || id.length !== 16 || !secret || secret.length !== 32) return null;
	return { port, instanceId: m[2], pairSecret: m[3] };
}

export function endpointFor(port: number): string {
	return `${HOST}:${port}`;
}

export function baseUrl(port: number): string {
	return `http://${HOST}:${port}/v1`;
}
