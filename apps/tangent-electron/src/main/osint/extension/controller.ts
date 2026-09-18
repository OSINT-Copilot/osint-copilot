/**
 * Owns the extension channel's moving parts -- key store, pairing, inbox, server -- and
 * decides whether the port is open.
 *
 * The rule (reconcile): the server listens only while the licence carries the osint
 * entitlement AND the user has switched the channel on. Anything else closes the port,
 * so an unlicensed or switched-off app answers nothing at all rather than refusing
 * politely. index.ts calls reconcile() at start-up, whenever the licence changes, when
 * the switch flips, and on a timer, because a subscription can lapse with no event.
 *
 * No electron import: the encryptor (safeStorage), the confirm dialog and the licence
 * check are injected, so this runs under node in tests.
 */
import { ExtensionSecretStore, type Encryptor } from './secret-store';
import { PairingManager, type ConfirmPairing } from './pairing';
import { ExtensionServer, type StartOptions } from './server';
import { InboxWriter, type InboxHost } from '../inbox/inbox-writer';
import type { ExtensionPairing, ExtensionStatus } from '../../../osint/host/types';

export interface ControllerDeps {
    userDataDir: string;
    /** Electron's safeStorage in the app; null in tests (plain 0600 file). */
    encryptor: Encryptor | null;
    confirm: ConfirmPairing;
    /** Whether the licence carries the osint entitlement. Asked afresh each time. */
    licensed(): Promise<boolean>;
    host: InboxHost;
    appVersion: string;
    /** Where the server binds. Tests pass [0]. */
    ports?: StartOptions['ports'];
    now?: () => number;
    log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

export class ExtensionController {
    /** Reconciles run one after another, so two cannot race a start against a stop. */
    private chain: Promise<void> = Promise.resolve();
    private stopped = false;
    private lastStartError: string | null = null;

    private constructor(
        private readonly deps: ControllerDeps,
        readonly secrets: ExtensionSecretStore,
        readonly pairing: PairingManager,
        readonly inbox: InboxWriter,
        readonly server: ExtensionServer,
    ) {}

    static async open(deps: ControllerDeps): Promise<ExtensionController> {
        const secrets = await ExtensionSecretStore.open(deps.userDataDir, deps.encryptor);
        const pairing = await PairingManager.open({
            userDataDir: deps.userDataDir,
            secrets,
            confirm: deps.confirm,
            now: deps.now,
        });
        const inbox = new InboxWriter({
            host: deps.host,
            keys: secrets,
            licensed: () => deps.licensed(),
            now: deps.now,
        });
        const server = new ExtensionServer({ pairing, backend: inbox, appVersion: deps.appVersion, now: deps.now });
        return new ExtensionController(deps, secrets, pairing, inbox, server);
    }

    private async licensed(): Promise<boolean> {
        try {
            return await this.deps.licensed();
        } catch {
            return false;
        }
    }

    /** Opens or closes the port to match the licence and the switch. Never throws. */
    reconcile(): Promise<void> {
        const run = this.chain.then(() => this.reconcileNow());
        this.chain = run.catch(err => {
            this.deps.log?.warn('[osint] extension channel reconcile failed:', err);
        });
        return this.chain;
    }

    private async reconcileNow(): Promise<void> {
        const want = !this.stopped && this.pairing.enabled && await this.licensed();
        if (want && this.server.port === null) {
            try {
                const port = await this.server.start({ ports: this.deps.ports });
                this.lastStartError = null;
                this.deps.log?.info(`[osint] extension channel listening on 127.0.0.1:${port}`);
            } catch (err) {
                this.lastStartError = err instanceof Error ? err.message : String(err);
                throw err;
            }
            // Writes that died with a previous run leave staging behind; clear them now.
            await this.inbox.sweepAll();
        } else if (!want && this.server.port !== null) {
            // A pairing string on screen must not outlive the port it names.
            this.pairing.cancel();
            await this.server.stop();
            this.deps.log?.info('[osint] extension channel closed');
        }
    }

    async status(): Promise<ExtensionStatus> {
        const status: ExtensionStatus = {
            enabled: this.pairing.enabled,
            running: this.server.port !== null,
            port: this.server.port,
            licensed: await this.licensed(),
            secretsEncrypted: !this.secrets.plaintext,
            clients: this.pairing.listClients(),
        };
        if (this.lastStartError && this.pairing.enabled && status.licensed && !status.running) {
            status.problem = this.lastStartError;
        }
        return status;
    }

    async setEnabled(enabled: boolean): Promise<ExtensionStatus> {
        await this.pairing.setEnabled(enabled);
        await this.reconcile();
        return this.status();
    }

    /** A fresh one-time pairing string. Only while the server listens: it names the port. */
    async pairBegin(): Promise<ExtensionPairing> {
        await this.chain;
        const port = this.server.port;
        if (port === null) throw new Error('Turn on the browser extension channel before pairing.');
        return this.pairing.begin(port);
    }

    pairCancel(): void {
        this.pairing.cancel();
    }

    async revoke(clientId: string): Promise<boolean> {
        const removed = await this.pairing.revokeClient(clientId);
        this.server.forgetClient(clientId);
        return removed;
    }

    /** For quit: closes the port and keeps it closed. */
    async stop(): Promise<void> {
        this.stopped = true;
        await this.reconcile();
    }
}
