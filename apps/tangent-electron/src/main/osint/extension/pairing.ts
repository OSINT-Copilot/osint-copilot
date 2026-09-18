/**
 * Pairing the browser extension with this app, and the record of who is paired.
 *
 * The app shows a one-time pairing string; the extension proves it holds the secret
 * without sending it; the user confirms in a native dialog naming the extension; both
 * sides then derive a per-client key K and forget the pairing secret. See PROTOCOL.md.
 *
 * Public metadata (port, instanceId, the enabled switch, which clients are paired and
 * when they were last seen) lives in userData/osint-extension.json. Keys never do: K
 * lives only in the ExtensionSecretStore, so this file can be shown to the renderer
 * without handing it the means to impersonate the extension.
 *
 * No electron import: the confirm dialog is injected.
 */
import * as fsp from 'fs/promises';
import * as nodePath from 'path';
import { randomBytes as nodeRandomBytes } from 'crypto';
import {
    B64URL_16,
    EXT_VERSION,
    EXTENSION_ORIGIN,
    PAIR_TTL_MS,
    type ErrorCode,
    type PairRequest,
    type PairResponse,
} from './protocol';
import {
    b64url,
    deriveClientKey,
    hmac,
    pairingIdFor,
    pairingString,
    pairProofString,
    pairServerProofString,
    safeEqualText,
    verifyMac,
} from './signing';
import type { ExtensionSecretStore } from './secret-store';

export const METADATA_FILE = 'osint-extension.json';

export interface ClientRecord {
    clientId: string;
    origin: string;
    extVersion: string;
    createdAt: string;
    lastSeenAt: string | null;
}

interface Metadata {
    port: number | null;
    instanceId: string;
    enabled: boolean;
    clients: ClientRecord[];
}

/** Shows the native "Allow <origin> to add to your investigations?" dialog. */
export type ConfirmPairing = (request: { origin: string; extVersion: string }) => Promise<boolean>;

export interface PairingDeps {
    userDataDir: string;
    secrets: ExtensionSecretStore;
    confirm: ConfirmPairing;
    now?: () => number;
    randomBytes?: (size: number) => Buffer;
}

export interface ActivePairing {
    pairingString: string;
    expiresAt: number;
}

interface Pending {
    secret: Buffer;
    id: string;
    expiresAt: number;
}

export class PairingStoreError extends Error {}

export type PairOutcome =
    | { ok: true; response: PairResponse }
    | { ok: false; error: ErrorCode; detail?: string };

export class PairingManager {
    private pending: Pending | null = null;
    /** Bumped by begin/cancel, so a dialog still open when the user cancels cannot pair. */
    private generation = 0;
    private writing: Promise<void> = Promise.resolve();
    private readonly now: () => number;
    private readonly random: (size: number) => Buffer;

    private constructor(
        private readonly file: string,
        private readonly deps: PairingDeps,
        private meta: Metadata,
    ) {
        this.now = deps.now ?? Date.now;
        this.random = deps.randomBytes ?? nodeRandomBytes;
    }

    /**
     * Reads the metadata, starting fresh only when there is no file. A file that exists
     * but cannot be read or parsed throws PairingStoreError instead: starting fresh would
     * delete every client key as orphaned and mint a new instanceId, so one transient
     * EACCES or EIO would permanently unpair every extension. Same rule as the secret store.
     */
    static async open(deps: PairingDeps): Promise<PairingManager> {
        const file = nodePath.join(deps.userDataDir, METADATA_FILE);
        const random = deps.randomBytes ?? nodeRandomBytes;
        let meta: Metadata | null = null;
        let text: string | null = null;
        try {
            text = await fsp.readFile(file, 'utf-8');
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') throw new PairingStoreError(`${METADATA_FILE} could not be read (${code ?? String(err)})`);
        }
        if (text !== null) {
            let raw: any;
            try {
                raw = JSON.parse(text);
            } catch {
                throw new PairingStoreError(`${METADATA_FILE} is not valid JSON`);
            }
            if (!raw || typeof raw.instanceId !== 'string' || !B64URL_16.test(raw.instanceId)) {
                throw new PairingStoreError(`${METADATA_FILE} has an unknown format`);
            }
            meta = {
                port: Number.isInteger(raw.port) ? raw.port : null,
                instanceId: raw.instanceId,
                enabled: raw.enabled === true,
                clients: Array.isArray(raw.clients) ? raw.clients.filter(isClientRecord) : [],
            };
        }
        const created = !meta;
        meta ??= { port: null, instanceId: b64url(random(16)), enabled: false, clients: [] };
        const manager = new PairingManager(file, deps, meta);
        // Keys whose record is gone (a revoke interrupted between the two files) must not
        // linger as a way back in.
        const orphaned = deps.secrets.clientIds().filter(id => !meta!.clients.some(c => c.clientId === id));
        await deps.secrets.deleteClientKeys(orphaned);
        if (created) await manager.save();
        return manager;
    }

    get instanceId(): string {
        return this.meta.instanceId;
    }

    get port(): number | null {
        return this.meta.port;
    }

    /**
     * The user's switch for the channel, persisted. Nothing here or in ExtensionServer
     * enforces it: whoever owns the server starts and stops it to match.
     */
    get enabled(): boolean {
        return this.meta.enabled;
    }

    async setPort(port: number): Promise<void> {
        if (this.meta.port === port) return;
        this.meta.port = port;
        await this.save();
    }

    async setEnabled(enabled: boolean): Promise<void> {
        if (this.meta.enabled === enabled) return;
        this.meta.enabled = enabled;
        if (!enabled) this.cancel();
        await this.save();
    }

    // --- pairing ---------------------------------------------------------------------

    /** Starts a pairing, replacing any in progress: only the string on screen works. */
    begin(port: number): ActivePairing {
        const secret = this.random(32);
        const expiresAt = this.now() + PAIR_TTL_MS;
        this.pending = { secret, id: pairingIdFor(secret), expiresAt };
        this.generation++;
        return { pairingString: pairingString(port, this.meta.instanceId, secret), expiresAt };
    }

    cancel(): void {
        this.pending = null;
        this.generation++;
    }

    /** Whether /v1/pair is worth looking at; checked before its body is read. */
    hasActivePairing(): boolean {
        if (this.pending && this.now() > this.pending.expiresAt) this.pending = null;
        return this.pending !== null;
    }

    /**
     * Handles a /v1/pair body from `origin`. The pairing is consumed once the proof checks
     * out -- before the dialog, whatever the answer -- so a request cannot be replayed into
     * a second dialog, and a denied extension must be given a fresh string.
     */
    async complete(request: PairRequest, origin: string): Promise<PairOutcome> {
        if (!EXTENSION_ORIGIN.test(origin)) return { ok: false, error: 'bad_origin' };
        if (!this.hasActivePairing()) return { ok: false, error: 'pair_expired' };
        const pending = this.pending!;
        if (typeof request.pairingId !== 'string' || !safeEqualText(request.pairingId, pending.id)) {
            return { ok: false, error: 'pair_expired' };
        }
        if (typeof request.clientNonce !== 'string' || !B64URL_16.test(request.clientNonce)) {
            return { ok: false, error: 'invalid', detail: 'clientNonce: must be 16 bytes of base64url' };
        }
        if (typeof request.extVersion !== 'string' || !EXT_VERSION.test(request.extVersion)) {
            return { ok: false, error: 'invalid', detail: 'extVersion: must be 1-32 characters of 0-9 A-Z a-z . + -' };
        }
        if (!verifyMac(pending.secret, pairProofString(request.clientNonce), request.proof)) {
            return { ok: false, error: 'bad_signature' };
        }

        this.pending = null;
        const generation = ++this.generation;
        const allowed = await this.deps.confirm({ origin, extVersion: request.extVersion });
        if (!allowed) return { ok: false, error: 'pair_denied' };
        if (generation !== this.generation) return { ok: false, error: 'pair_expired' };

        const clientId = b64url(this.random(16));
        const serverNonce = b64url(this.random(16));
        const key = deriveClientKey(pending.secret, request.clientNonce, serverNonce, clientId);

        // One client per extension origin: re-pairing replaces, so a reinstall does not
        // leave the old key valid.
        const replaced = this.meta.clients.filter(c => c.origin === origin).map(c => c.clientId);
        await this.deps.secrets.setClientKey(clientId, key);
        this.meta.clients = this.meta.clients.filter(c => c.origin !== origin);
        this.meta.clients.push({
            clientId,
            origin,
            extVersion: request.extVersion,
            createdAt: new Date(this.now()).toISOString(),
            lastSeenAt: null,
        });
        await this.save();
        await this.deps.secrets.deleteClientKeys(replaced);

        const serverProof = b64url(hmac(
            pending.secret,
            pairServerProofString(request.clientNonce, serverNonce, clientId),
        ));
        return { ok: true, response: { clientId, serverNonce, instanceId: this.meta.instanceId, serverProof } };
    }

    // --- clients ---------------------------------------------------------------------

    listClients(): ClientRecord[] {
        return this.meta.clients.map(c => ({ ...c }));
    }

    /** The record and key a request must match, or null for an unknown or revoked client. */
    client(clientId: string): { record: ClientRecord; key: Buffer } | null {
        const record = this.meta.clients.find(c => c.clientId === clientId);
        const key = record ? this.deps.secrets.clientKey(clientId) : null;
        return record && key ? { record, key } : null;
    }

    async revokeClient(clientId: string): Promise<boolean> {
        const before = this.meta.clients.length;
        this.meta.clients = this.meta.clients.filter(c => c.clientId !== clientId);
        const removed = this.meta.clients.length !== before;
        // Record first: without it the key is unusable even if the key delete fails.
        if (removed) await this.save();
        await this.deps.secrets.deleteClientKeys([clientId]);
        return removed;
    }

    /** Records activity; at most one write a minute per client, since every request calls it. */
    async touch(clientId: string): Promise<void> {
        const record = this.meta.clients.find(c => c.clientId === clientId);
        if (!record) return;
        if (record.lastSeenAt && this.now() - Date.parse(record.lastSeenAt) < 60_000) return;
        record.lastSeenAt = new Date(this.now()).toISOString();
        await this.save();
    }

    private save(): Promise<void> {
        const snapshot = JSON.stringify(this.meta, null, 2);
        const next = this.writing.then(async () => {
            await fsp.mkdir(nodePath.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.${nodeRandomBytes(4).toString('hex')}.tmp`;
            try {
                await fsp.writeFile(tmp, snapshot, { mode: 0o600, flag: 'wx' });
                await fsp.rename(tmp, this.file);
            } catch (err) {
                await fsp.rm(tmp, { force: true });
                throw err;
            }
        });
        this.writing = next.catch(() => undefined);
        return next;
    }
}

function isClientRecord(value: unknown): value is ClientRecord {
    const c = value as ClientRecord;
    return typeof c === 'object' && c !== null
        && typeof c.clientId === 'string' && B64URL_16.test(c.clientId)
        && typeof c.origin === 'string' && EXTENSION_ORIGIN.test(c.origin)
        && typeof c.extVersion === 'string'
        && typeof c.createdAt === 'string'
        && (c.lastSeenAt === null || typeof c.lastSeenAt === 'string');
}
