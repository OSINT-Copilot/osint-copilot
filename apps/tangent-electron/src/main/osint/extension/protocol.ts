/**
 * Browser-extension wire protocol v1: the constants and shapes both ends agree on.
 *
 * PROTOCOL.md beside this file is the normative description for the extension's
 * authors; this module is its machine-readable half. Nothing here does I/O, so the
 * extension's build could import it as-is.
 */

export const PROTO = 1;

/** Bound on 127.0.0.1 only -- never 0.0.0.0, :: or 'localhost', which may resolve elsewhere. */
export const HOST = '127.0.0.1';
export const PREFERRED_PORT = 23760;
/** Tried in order after the persisted port. Five, so a stale instance cannot lock us out. */
export const PORTS: readonly number[] = [23760, 23761, 23762, 23763, 23764];

/** Lowercase, as node:http presents them. */
export const HEADER = {
    proto: 'x-oc-proto',
    client: 'x-oc-client',
    ts: 'x-oc-ts',
    nonce: 'x-oc-nonce',
    bodySha256: 'x-oc-body-sha256',
    sig: 'x-oc-sig',
} as const;

/** Cap on a JSON request body: /v1/bundles manifests. */
export const MAX_CONTROL_BODY = 256 * 1024;
/** /v1/pair and /v1/hello carry a handful of short fields. */
export const MAX_HANDSHAKE_BODY = 4 * 1024;

export const MAX_SKEW_MS = 60_000;
export const REPLAY_WINDOW_MS = 120_000;
export const PAIR_TTL_MS = 5 * 60_000;

export const RATE = {
    pairPerMinute: 10,
    helloPerMinutePerClient: 10,
    bundlesPerMinutePerClient: 20,
    requestsPerSecond: 60,
} as const;

/** Chrome extension ids are 32 letters a-p (the hex of a key hash, shifted). */
export const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/** 16 random bytes, base64url without padding. */
export const B64URL_16 = /^[A-Za-z0-9_-]{22}$/;
/** 32 random bytes, base64url without padding. */
export const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
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

export const ERROR_STATUS: Record<ErrorCode, number> = {
    bad_proto: 400,
    bad_json: 400,
    bad_content_type: 400,
    unauthenticated: 401,
    bad_signature: 401,
    clock_skew: 401,
    replay: 401,
    forbidden: 403,
    bad_origin: 403,
    pair_expired: 403,
    pair_denied: 403,
    unlicensed: 403,
    not_found: 404,
    unknown_workspace: 404,
    method_not_allowed: 405,
    too_large: 413,
    bad_host: 421,
    invalid: 422,
    hash_mismatch: 422,
    rate_limited: 429,
    internal: 500,
    budget_exceeded: 507,
};

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
    /** b64url(HMAC-SHA256(workspaceIdKey, realpath)).slice(0, 22). Never a path. */
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
    /** ISO 8601, the time main first received this bundleId. */
    receivedAt: string;
}

// --- manifest ------------------------------------------------------------------------

/** Every kind the protocol names; later phases add the rest to SUPPORTED_KINDS. */
export const ALL_KINDS = ['note', 'entity', 'capture', 'highlight', 'highlight.update', 'highlight.delete'] as const;
export type BundleKind = typeof ALL_KINDS[number];
export const SUPPORTED_KINDS = ['note', 'entity'] as const;
export type SupportedKind = typeof SUPPORTED_KINDS[number];

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

export interface ManifestPage {
    url: string;
    title: string;
}

interface ManifestBase {
    v: 1;
    /** UUID v4, lowercase. The idempotency key: resending it never creates a second item. */
    bundleId: string;
    workspaceId: string;
    page: ManifestPage;
    /** Advisory only; main stamps its own receivedAt. */
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
