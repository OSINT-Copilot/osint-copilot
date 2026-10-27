/**
 * The `osint:inbox.*` and `osint:extension.*` channels.
 *
 * The inbox channels never take a workspace. Each resolves the sender's OWN window's
 * workspace from main's bookkeeping, so a window can only ever list, journal or settle
 * bundles in the investigation it has open. And one window per workspace holds the lease
 * that applies bundles: two windows on one case applying the same bundle at once would
 * each create the entity, which is exactly what the journal exists to prevent.
 *
 * The extension channels are the settings page's: switch, pairing string, paired
 * clients. Status carries client metadata only; no channel returns a key.
 *
 * Free of electron, like vault-ipc.ts: `handle` (guarded-ipc's, in the app) and the
 * window lookup are injected, so the registration is driven from a node test.
 */
import type { InboxWriter } from './inbox-writer';
import type { ExtensionController } from '../extension/controller';
import type {
    ExtensionPairing,
    ExtensionStatus,
    InboxAppliedBundle,
    InboxBundle,
    InboxClaimResult,
    InboxOutcome,
    InboxPlacement,
    InboxState,
} from '../../../osint/host/types';

/** The part of Electron's WebContents these handlers use. */
export interface InboxSender {
    readonly id: number;
    isDestroyed(): boolean;
    once(event: 'destroyed', listener: () => void): unknown;
}

export interface InboxIpcEvent {
    readonly sender: InboxSender;
}

export type InboxHandle = (
    channel: string,
    listener: (event: InboxIpcEvent, ...args: any[]) => any,
) => void;

/** The inbox operations the channels need; InboxWriter in the app. */
export type InboxStore = Pick<InboxWriter, 'investigationRootFor' | 'listPending' | 'recordStep' | 'finish' | 'markRemoved' | 'listApplied' | 'placeFiles'>;

export interface InboxIpcDeps {
    handle: InboxHandle;
    /** Resolves once the key store is open (after app ready). */
    inbox(): Promise<InboxStore>;
    /** The workspace path main assigned to the sender's window, or null. */
    workspacePathOf(sender: InboxSender): string | null;
}

/** Who holds each workspace's inbox. Keyed by real root. */
export class InboxLeases {
    private readonly holders = new Map<string, InboxSender>();
    private readonly hooked = new Set<number>();

    constructor(private readonly currentRootOf: (sender: InboxSender) => Promise<string | null>) {}

    /**
     * Grants the lease unless a live window that still has this workspace open holds it.
     * A holder that closed, or moved to another workspace, has lost it.
     */
    async claim(root: string, sender: InboxSender): Promise<InboxClaimResult> {
        const holder = this.holders.get(root);
        if (holder && holder !== sender && !holder.isDestroyed()) {
            const stillThere = (await this.currentRootOf(holder)) === root;
            // Someone else may have taken it while we looked; decide again on the new state.
            if (this.holders.get(root) !== holder) return this.claim(root, sender);
            if (stillThere) return { ok: false, reason: 'held' };
        }
        this.holders.set(root, sender);
        this.hookDestroyed(sender);
        return { ok: true };
    }

    release(root: string, sender: InboxSender): void {
        if (this.holders.get(root) === sender) this.holders.delete(root);
    }

    holds(root: string, sender: InboxSender): boolean {
        return this.holders.get(root) === sender && !sender.isDestroyed();
    }

    private hookDestroyed(sender: InboxSender): void {
        if (this.hooked.has(sender.id)) return;
        this.hooked.add(sender.id);
        sender.once('destroyed', () => {
            this.hooked.delete(sender.id);
            for (const [root, holder] of this.holders) {
                if (holder === sender) this.holders.delete(root);
            }
        });
    }
}

export function registerInboxHandlers({ handle, inbox, workspacePathOf }: InboxIpcDeps): InboxLeases {
    /** The sender's own investigation root. Never an argument: see the file comment. */
    const rootOf = async (sender: InboxSender): Promise<string | null> => {
        const p = workspacePathOf(sender);
        return p ? (await inbox()).investigationRootFor(p) : null;
    };
    const leases = new InboxLeases(rootOf);

    const requireRoot = async (e: InboxIpcEvent): Promise<string> => {
        const root = await rootOf(e.sender);
        if (!root) throw new Error('This window has no investigation open.');
        return root;
    };
    const requireHolder = async (e: InboxIpcEvent): Promise<string> => {
        const root = await requireRoot(e);
        if (!leases.holds(root, e.sender)) throw new Error('Another window is applying this investigation\'s inbox.');
        return root;
    };

    handle('osint:inbox.claim', async (e): Promise<InboxClaimResult> =>
        leases.claim(await requireRoot(e), e.sender));

    handle('osint:inbox.release', async (e): Promise<void> => {
        leases.release(await requireRoot(e), e.sender);
    });

    handle('osint:inbox.list', async (e): Promise<InboxBundle[]> => {
        const root = await requireHolder(e);
        return (await inbox()).listPending(root);
    });

    handle('osint:inbox.step', async (e, bundleId: string, step: string, data: unknown): Promise<InboxState> => {
        const root = await requireHolder(e);
        return (await inbox()).recordStep(root, bundleId, step, data);
    });

    handle('osint:inbox.finish', async (e, bundleId: string, outcome: InboxOutcome): Promise<void> => {
        const root = await requireHolder(e);
        await (await inbox()).finish(root, bundleId, outcome);
    });

    // Lease-bound like step and finish: placing is part of applying. The destination is
    // the sender's own investigation, and every name in it is main's.
    handle('osint:inbox.placeFiles', async (e, bundleId: string): Promise<InboxPlacement> => {
        if (typeof bundleId !== 'string') throw new Error('placeFiles takes a bundle id');
        const root = await requireHolder(e);
        return (await inbox()).placeFiles(root, bundleId);
    });

    // Not lease-bound, unlike the four above. Remove is the user acting on an item they
    // are looking at, in whichever window shows it; the bundle is already applied, so no
    // two windows can race to apply it, and main serialises the move per workspace. Only
    // done/ to removed/: a pending bundle cannot be dropped through here.
    handle('osint:inbox.markRemoved', async (e, bundleId: string): Promise<void> => {
        if (typeof bundleId !== 'string') throw new Error('markRemoved takes a bundle id');
        const root = await requireRoot(e);
        await (await inbox()).markRemoved(root, bundleId);
    });

    // The activity log, read by whichever window shows it; not lease-bound for the same
    // reason as markRemoved. It lives with the journals here, so every window on the
    // investigation reads one current list rather than its own stale copy.
    handle('osint:inbox.listApplied', async (e): Promise<InboxAppliedBundle[]> =>
        (await inbox()).listApplied(await requireRoot(e)));

    return leases;
}

/** The settings controls; ExtensionController in the app. */
export type ExtensionControl = Pick<ExtensionController, 'status' | 'setEnabled' | 'pairBegin' | 'pairCancel' | 'revoke'>;

export interface ExtensionIpcDeps {
    handle: InboxHandle;
    /** Rejects when the channel could not be set up (e.g. an unreadable key file). */
    control(): Promise<ExtensionControl>;
}

export function registerExtensionHandlers({ handle, control }: ExtensionIpcDeps): void {
    handle('osint:extension.status', async (): Promise<ExtensionStatus> => {
        try {
            return await (await control()).status();
        } catch (err) {
            // Still an answer the settings page can render, naming what went wrong.
            return {
                enabled: false, running: false, port: null, licensed: false,
                secretsEncrypted: false, clients: [],
                problem: err instanceof Error ? err.message : String(err),
            };
        }
    });

    handle('osint:extension.setEnabled', async (_e, enabled: boolean): Promise<ExtensionStatus> => {
        if (typeof enabled !== 'boolean') throw new Error('setEnabled takes a boolean');
        return (await control()).setEnabled(enabled);
    });

    handle('osint:extension.pairBegin', async (): Promise<ExtensionPairing> => (await control()).pairBegin());

    handle('osint:extension.pairCancel', async (): Promise<void> => {
        (await control()).pairCancel();
    });

    handle('osint:extension.revoke', async (_e, clientId: string): Promise<boolean> => {
        if (typeof clientId !== 'string') throw new Error('revoke takes a client id');
        return (await control()).revoke(clientId);
    });
}
