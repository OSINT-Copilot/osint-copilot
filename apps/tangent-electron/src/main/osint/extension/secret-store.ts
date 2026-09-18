/**
 * The extension channel's keys -- main process only.
 *
 * Deliberately separate from secrets.ts. That module's keychain is reachable by name from
 * the renderer (osint:secrets.* lists, deletes and overwrites entries, and resolveSecret
 * injects any entry into an outbound request), and the renderer is the untrusted side. A
 * per-client key there could be read out to any allowlisted host, or overwritten with a
 * known value to impersonate the extension. This store has no IPC and no name-based
 * lookup; only the server and pairing code in main hold a reference to it.
 *
 * Held here: each paired client's K, the workspace-id key (so workspace ids are stable
 * across restarts without being guessable) and the manifest key the inbox signs bundles
 * with. The file is userData/osint-extension.secrets, never anything in a vault.
 *
 * Encryption is injected in the shape of Electron's safeStorage so this file stays free
 * of electron and testable in node. Where safeStorage is unavailable (some Linux sessions
 * without a keyring) the store falls back to plain JSON in a 0600 file and reports
 * `plaintext`, which the settings UI shows as a warning.
 */
import * as fsp from 'fs/promises';
import * as nodePath from 'path';
import { randomBytes } from 'crypto';
import { b64url, fromB64url } from './signing';

export interface Encryptor {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(buffer: Buffer): string;
}

export const SECRETS_FILE = 'osint-extension.secrets';

interface SecretsData {
    workspaceIdKey: string;
    manifestKey: string;
    /** clientId -> K, all base64url. */
    clients: Record<string, string>;
}

/** What is on disk: an envelope that says whether `data` is ciphertext. */
interface Envelope {
    v: 1;
    encrypted: boolean;
    /** base64 ciphertext of the SecretsData JSON when encrypted; the object itself when not. */
    data: string | SecretsData;
}

export class SecretStoreError extends Error {}

function isSecretsData(value: unknown): value is SecretsData {
    const v = value as SecretsData;
    return typeof v === 'object' && v !== null
        && typeof v.workspaceIdKey === 'string'
        && typeof v.manifestKey === 'string'
        && typeof v.clients === 'object' && v.clients !== null;
}

export class ExtensionSecretStore {
    private data: SecretsData | null = null;
    private writing: Promise<void> = Promise.resolve();
    private plain = false;

    private constructor(private readonly file: string, private readonly encryptor: Encryptor | null) {}

    /**
     * Reads the store, creating fresh keys when there is no file. Throws SecretStoreError
     * when a file exists but cannot be read -- an encrypted file with safeStorage now
     * unavailable, or a corrupt one. It never regenerates over an existing file: that would
     * silently unpair every extension, change every workspace id and orphan signed bundles.
     */
    static async open(userDataDir: string, encryptor: Encryptor | null): Promise<ExtensionSecretStore> {
        const store = new ExtensionSecretStore(nodePath.join(userDataDir, SECRETS_FILE), encryptor);
        await store.load();
        return store;
    }

    /** True when the keys sit on disk unencrypted (0600) because safeStorage is unavailable. */
    get plaintext(): boolean {
        return this.plain;
    }

    private canEncrypt(): boolean {
        try {
            return !!this.encryptor?.isEncryptionAvailable();
        } catch {
            return false;
        }
    }

    private async load(): Promise<void> {
        let raw: string;
        try {
            raw = await fsp.readFile(this.file, 'utf-8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            this.data = {
                workspaceIdKey: b64url(randomBytes(32)),
                manifestKey: b64url(randomBytes(32)),
                clients: {},
            };
            await this.save();
            return;
        }

        let envelope: Envelope;
        try {
            envelope = JSON.parse(raw) as Envelope;
        } catch {
            throw new SecretStoreError(`${SECRETS_FILE} is not valid JSON`);
        }
        if (envelope?.v !== 1) throw new SecretStoreError(`${SECRETS_FILE} has an unknown format`);

        let data: unknown;
        if (envelope.encrypted) {
            if (!this.canEncrypt() || typeof envelope.data !== 'string') {
                throw new SecretStoreError(`${SECRETS_FILE} is encrypted and the OS keychain is unavailable`);
            }
            try {
                data = JSON.parse(this.encryptor!.decryptString(Buffer.from(envelope.data, 'base64')));
            } catch {
                throw new SecretStoreError(`${SECRETS_FILE} could not be decrypted`);
            }
        } else {
            data = envelope.data;
        }
        if (!isSecretsData(data)) throw new SecretStoreError(`${SECRETS_FILE} is missing keys`);
        this.data = data;

        // A plain file written while the keyring was down is encrypted as soon as it is back.
        if (!envelope.encrypted && this.canEncrypt()) await this.save();
        else this.plain = !envelope.encrypted;
    }

    private save(): Promise<void> {
        const next = this.writing.then(() => this.write());
        // One failed write must not wedge every later one.
        this.writing = next.catch(() => undefined);
        return next;
    }

    private async write(): Promise<void> {
        const data = this.data!;
        const encrypted = this.canEncrypt();
        const envelope: Envelope = encrypted
            ? { v: 1, encrypted: true, data: this.encryptor!.encryptString(JSON.stringify(data)).toString('base64') }
            : { v: 1, encrypted: false, data };
        this.plain = !encrypted;

        await fsp.mkdir(nodePath.dirname(this.file), { recursive: true });
        // Written to a fresh temp file (so `mode` applies: it is honoured only on create)
        // and renamed over, so a crash never leaves a half-written key file behind.
        const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
            await fsp.writeFile(tmp, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
            await fsp.rename(tmp, this.file);
        } catch (err) {
            await fsp.rm(tmp, { force: true });
            throw err;
        }
    }

    private key(text: string): Buffer {
        const bytes = fromB64url(text);
        if (!bytes || bytes.length !== 32) throw new SecretStoreError('stored key is malformed');
        return bytes;
    }

    workspaceIdKey(): Buffer {
        return this.key(this.data!.workspaceIdKey);
    }

    manifestKey(): Buffer {
        return this.key(this.data!.manifestKey);
    }

    clientKey(clientId: string): Buffer | null {
        const k = Object.prototype.hasOwnProperty.call(this.data!.clients, clientId) ? this.data!.clients[clientId] : undefined;
        return k ? this.key(k) : null;
    }

    clientIds(): string[] {
        return Object.keys(this.data!.clients);
    }

    async setClientKey(clientId: string, key: Buffer): Promise<void> {
        this.data!.clients[clientId] = b64url(key);
        await this.save();
    }

    async deleteClientKeys(clientIds: string[]): Promise<void> {
        let changed = false;
        for (const id of clientIds) {
            if (Object.prototype.hasOwnProperty.call(this.data!.clients, id)) {
                delete this.data!.clients[id];
                changed = true;
            }
        }
        if (changed) await this.save();
    }
}
