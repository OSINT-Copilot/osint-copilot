/**
 * The browser extension's inbox: where main puts what the extension sends, and the only
 * code that touches `<workspace>/.osint-inbox/`.
 *
 *   .osint-inbox/
 *     .staging/<bundleId>/   being written; swept after an hour
 *     pending/<bundleId>/    manifest.json (main's MAC on it), state.json (the journal)
 *     done/ rejected/ removed/
 *
 * The server hands a validated manifest to acceptBundle(), which writes it into staging
 * and renames the folder into pending/ in one step, so the renderer never sees half a
 * bundle. The renderer then applies pending bundles through inbox/ipc.ts, which re-checks
 * every MAC here before handing a bundle over.
 *
 * Plain fs throughout, never vaultFs: vault.ts refuses this folder precisely so the
 * renderer cannot write in it, and main must not borrow the renderer's path either. A
 * workspace is only ever named by its keyed id; a raw path from the extension matches
 * nothing. And never Workspace.containsPath, which is a bare startsWith: '/cases/a' would
 * "contain" '/cases/ab'.
 *
 * No electron import. What it needs from Tangent (the known workspaces, which windows
 * have one open) comes through InboxHost; see tangent-host.ts.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as nodePath from 'path';
import { randomBytes } from 'crypto';
import { B64URL_16 } from '../extension/protocol';
import type { StatusResponse, WorkspaceInfo, Manifest } from '../extension/protocol';
import { safeEqualText, workspaceIdFor } from '../extension/signing';
import { validateManifest } from '../extension/validate';
import type { BundleContext, BundleOutcome, InboxBackend } from '../extension/server';
import { INBOX_FOLDER } from '../node/vault';
import { canonicalJson, sealManifest, verifySealedManifest, type ServerStamp } from './manifest-mac';
import type {
    InboxAppliedBundle,
    InboxBundle,
    InboxOutcome,
    InboxServerStamp,
    InboxState,
    InboxStepRecord,
} from '../../../osint/host/types';

export { INBOX_FOLDER };
export const STAGING = '.staging';
export const PENDING = 'pending';
export const DONE = 'done';
export const REJECTED = 'rejected';
export const REMOVED = 'removed';
const SETTLED = [DONE, REJECTED, REMOVED] as const;
/** The journal step markRemoved writes: when the item was removed. */
export const REMOVED_STEP = 'removed';
/** How many applied bundles listApplied returns, newest by receive time. */
export const APPLIED_LIST_LIMIT = 500;

/** Sent to every window with the workspace open whenever its pending set changes. */
export const INBOX_CHANGED_CHANNEL = 'osint:inbox.changed';

/** Per workspace. When full the server refuses; it never deletes anything to make room. */
export const INBOX_BUDGET_BYTES = 2 * 1024 ** 3;
/** Staging older than this belongs to a write that died; a live one takes milliseconds. */
export const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
/** How long a running inbox size is trusted before the tree is walked again. */
const SIZE_RESCAN_MS = 10 * 60 * 1000;

const MANIFEST_FILE = 'manifest.json';
const STATE_FILE = 'state.json';
const REASON_FILE = 'reason.json';
/** A stored manifest is a validated one plus a stamp; four times the body cap is ample. */
const MAX_STORED_MANIFEST = 1024 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const RENAME_ATTEMPTS = 5;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STEP_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/**
 * Where the platform has them: a bundle folder may hold a planted symlink (NOFOLLOW), or a
 * FIFO, whose open would otherwise block main until something wrote to it (NONBLOCK).
 */
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** What the inbox needs from Tangent's window and workspace bookkeeping. */
export interface InboxHost {
    /** Every workspace the app knows (the keys of workspaceMap), as registered. */
    knownRoots(): string[];
    /** The workspace paths of every open window. */
    openRoots(): string[];
    /** The bundled documentation workspace, which is never an investigation. */
    documentationPath(): string | null;
    /** Sends `channel` to every window whose workspace really is `realRoot`. */
    notify(realRoot: string, channel: string): void;
}

export interface InboxWriterDeps {
    host: InboxHost;
    /** The main-only store's keys (the ExtensionSecretStore in the app). */
    keys: { workspaceIdKey(): Buffer; manifestKey(): Buffer };
    /** Whether the licence carries the osint entitlement right now. */
    licensed(): Promise<boolean>;
    budgetBytes?: number;
    now?: () => number;
    /** fsp.rename. A seam for simulating a crash between staging and commit. */
    rename?: (from: string, to: string) => Promise<void>;
}

interface Investigation {
    /** Realpath. */
    root: string;
    id: string;
    name: string;
}

export class InboxError extends Error {}

/**
 * A read that failed for a reason that may pass: a handle limit, a lock held by antivirus
 * or a sync client, a permission that a sync client restores. Such a bundle is skipped and
 * tried again next time, never quarantined, because rejected/ is for good.
 */
class TransientReadError extends InboxError {}

/** Open errors that say something about the file itself rather than about the moment. */
const STRUCTURAL_OPEN_ERRORS = new Set(['ELOOP', 'EISDIR', 'ENOTDIR', 'ENXIO', 'EMLINK']);

type Checked =
    | { ok: true; bundle: InboxBundle }
    | { ok: false; reason: string }
    /** Could not be read just now; left where it is. */
    | { ok: 'skip' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function isServerStamp(value: unknown): value is InboxServerStamp {
    const v = value as InboxServerStamp;
    return isPlainObject(v) && Object.keys(v).length === 4
        && typeof v.receivedAt === 'string' && typeof v.clientId === 'string'
        && typeof v.origin === 'string' && typeof v.extVersion === 'string';
}

function isState(value: unknown): value is InboxState {
    const v = value as InboxState;
    return isPlainObject(v) && v.v === 1 && Array.isArray(v.steps)
        && v.steps.every(s => isPlainObject(s) && typeof s.step === 'string' && typeof s.at === 'string');
}

async function realpathOrNull(p: string): Promise<string | null> {
    try {
        return await fsp.realpath(p);
    } catch {
        return null;
    }
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
    try {
        return await fsp.lstat(p);
    } catch {
        return null;
    }
}

/** A real directory, not a symlink to one. */
async function isRealDir(p: string): Promise<boolean> {
    const stats = await lstatOrNull(p);
    return !!stats && stats.isDirectory();
}

/** Total bytes of regular files beneath `dir`, not following symlinks. */
async function treeSize(dir: string): Promise<number> {
    let total = 0;
    let entries: fs.Dirent[];
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const p = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) total += await treeSize(p);
        else {
            const stats = await lstatOrNull(p);
            if (stats) total += stats.size;
        }
    }
    return total;
}

/** Reads a small file without following a symlink at its name. Null if absent. */
async function readSmallFile(p: string, limit: number): Promise<Buffer | null> {
    let handle: fsp.FileHandle;
    try {
        handle = await fsp.open(p, READ_FLAGS);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return null;
        const message = `${nodePath.basename(p)} cannot be opened (${code ?? 'error'})`;
        throw code && STRUCTURAL_OPEN_ERRORS.has(code) ? new InboxError(message) : new TransientReadError(message);
    }
    try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new InboxError(`${nodePath.basename(p)} is not a file`);
        if (stats.size > limit) throw new InboxError(`${nodePath.basename(p)} is too large`);
        try {
            return await handle.readFile();
        } catch (err) {
            throw new TransientReadError(`${nodePath.basename(p)} cannot be read (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
        }
    } finally {
        await handle.close();
    }
}

/** Creates `p` exclusively, writes, fsyncs. Fails if anything (a symlink included) is there. */
async function writeExclusive(p: string, data: Buffer | string): Promise<void> {
    const handle = await fsp.open(p, 'wx', 0o600);
    try {
        await handle.writeFile(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/** Makes a rename durable where the platform allows opening a directory. */
async function syncDir(dir: string): Promise<void> {
    try {
        const handle = await fsp.open(dir, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // Windows cannot open a directory; NTFS journals the rename itself.
    }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class InboxWriter implements InboxBackend {
    private readonly now: () => number;
    private readonly renameFn: (from: string, to: string) => Promise<void>;
    private readonly budget: number;
    /** Per workspace root: everything that touches that inbox runs in order. */
    private readonly queues = new Map<string, Promise<unknown>>();
    /** Roots whose staging has been swept since the server last started. */
    private readonly swept = new Set<string>();
    /**
     * Per root: the inbox's size at the last full scan, plus what has been committed since.
     * Scanning the whole tree (done/ and rejected/ included) on every send would make each
     * send cost more as the inbox fills; see withinBudget.
     */
    private readonly sizes = new Map<string, { bytes: number; scannedAt: number }>();

    constructor(private readonly deps: InboxWriterDeps) {
        this.now = deps.now ?? Date.now;
        this.renameFn = deps.rename ?? fsp.rename;
        this.budget = deps.budgetBytes ?? INBOX_BUDGET_BYTES;
    }

    // --- which workspaces exist --------------------------------------------------------

    /**
     * Every known workspace but the documentation, keyed by realpath. Two registered
     * paths that are the same folder (one through a symlink) are one investigation.
     */
    private async investigations(): Promise<Investigation[]> {
        const docs = this.deps.host.documentationPath();
        const docsReal = docs ? await realpathOrNull(docs) : null;
        const key = this.deps.keys.workspaceIdKey();
        const seen = new Map<string, Investigation>();
        for (const registered of this.deps.host.knownRoots()) {
            if (!registered) continue;
            if (docs && nodePath.resolve(registered) === nodePath.resolve(docs)) continue;
            const root = await realpathOrNull(registered);
            if (!root || root === docsReal || seen.has(root)) continue;
            if (!(await fsp.stat(root).then(s => s.isDirectory(), () => false))) continue;
            seen.set(root, { root, id: workspaceIdFor(key, root), name: nodePath.basename(root) });
        }
        return [...seen.values()];
    }

    private async openRealRoots(): Promise<Set<string>> {
        const open = new Set<string>();
        for (const p of this.deps.host.openRoots()) {
            const real = p ? await realpathOrNull(p) : null;
            if (real) open.add(real);
        }
        return open;
    }

    async listInvestigations(): Promise<WorkspaceInfo[]> {
        const open = await this.openRealRoots();
        return (await this.investigations()).map(({ id, name, root }) => ({ id, name, open: open.has(root) }));
    }

    /** InboxBackend's name for listInvestigations. */
    listWorkspaces(): Promise<WorkspaceInfo[]> {
        return this.listInvestigations();
    }

    /**
     * The real root of the investigation with this id, or null. Only ids are accepted:
     * anything not shaped like one (a path, say) is refused before any lookup.
     */
    async resolveInboxTarget(id: string): Promise<string | null> {
        if (typeof id !== 'string' || !B64URL_16.test(id)) return null;
        for (const investigation of await this.investigations()) {
            if (safeEqualText(id, investigation.id)) return investigation.root;
        }
        return null;
    }

    /**
     * The real root for a window's workspace path, if it is an investigation. The path
     * comes from main's own window bookkeeping, never from the renderer.
     */
    async investigationRootFor(workspacePath: string): Promise<string | null> {
        const real = await realpathOrNull(workspacePath);
        if (!real) return null;
        return (await this.investigations()).some(i => i.root === real) ? real : null;
    }

    // --- the server's side -------------------------------------------------------------

    async status(): Promise<StatusResponse> {
        const licensed = await this.deps.licensed();
        let pendingCount = 0;
        for (const { root } of await this.investigations()) {
            const names = await fsp.readdir(nodePath.join(root, INBOX_FOLDER, PENDING)).catch(() => [] as string[]);
            pendingCount += names.length;
        }
        // The backend is only reachable while the server runs, and it runs only while
        // the channel is switched on; so receiving is the licence.
        return { licensed, receiving: licensed, pendingCount };
    }

    async acceptBundle(manifest: Manifest, ctx: BundleContext): Promise<BundleOutcome> {
        // The server validated already; this module is the one that writes, so it checks
        // for itself rather than trusting its caller.
        const checked = validateManifest(manifest);
        if (checked.ok === false) return { error: 'invalid', detail: checked.detail };
        const value = checked.value;
        if (!(await this.deps.licensed())) return { error: 'unlicensed' };
        const root = await this.resolveInboxTarget(value.workspaceId);
        if (!root) return { error: 'unknown_workspace' };

        const outcome = await this.serialized(root, async (): Promise<BundleOutcome> => {
            const inbox = await this.ensureLayout(root);
            await this.sweepOnce(root);

            // Before the budget: a retry of a bundle already stored must hear that it was,
            // even when the inbox has since filled up.
            const existing = await this.findExisting(inbox, value.bundleId);
            if (existing) return { status: 'duplicate', bundleId: value.bundleId, receivedAt: existing.receivedAt ?? ctx.receivedAt };

            const server: ServerStamp = {
                receivedAt: ctx.receivedAt,
                clientId: ctx.clientId,
                origin: ctx.origin,
                extVersion: ctx.extVersion,
            };
            const bytes = Buffer.from(JSON.stringify(sealManifest(this.deps.keys.manifestKey(), value, server), null, 2), 'utf8');
            if (!(await this.withinBudget(root, inbox, bytes.length))) return { error: 'budget_exceeded' };

            await this.commit(inbox, value.bundleId, bytes);
            const size = this.sizes.get(root);
            if (size) size.bytes += bytes.length;
            return { status: 'accepted', bundleId: value.bundleId, receivedAt: ctx.receivedAt };
        });
        if ('status' in outcome && outcome.status === 'accepted') this.notifyInboxChanged(root);
        return outcome;
    }

    /**
     * Whether `adding` more bytes fits. The running total drifts: journals grow, sweeps and
     * the user's own deletions shrink the tree. It is rescanned when it is old, and always
     * before a refusal, so the drift can only make the budget a little soft, never refuse
     * a send there is room for.
     */
    private async withinBudget(root: string, inbox: string, adding: number): Promise<boolean> {
        const cached = this.sizes.get(root);
        if (cached && this.now() - cached.scannedAt < SIZE_RESCAN_MS && cached.bytes + adding <= this.budget) return true;
        const fresh = { bytes: await treeSize(inbox), scannedAt: this.now() };
        this.sizes.set(root, fresh);
        return fresh.bytes + adding <= this.budget;
    }

    notifyInboxChanged(root: string): void {
        try {
            this.deps.host.notify(root, INBOX_CHANGED_CHANNEL);
        } catch {
            // A window closing mid-send is not the sender's problem.
        }
    }

    /** Writes staging/<id>/manifest.json, then moves the folder into pending/ whole. */
    private async commit(inbox: string, bundleId: string, bytes: Buffer): Promise<void> {
        const staging = nodePath.join(inbox, STAGING, bundleId);
        const pending = nodePath.join(inbox, PENDING, bundleId);
        // A leftover from a write that died; nothing else writes this id while we hold the queue.
        await fsp.rm(staging, { recursive: true, force: true });
        await fsp.mkdir(staging);
        try {
            await writeExclusive(nodePath.join(staging, MANIFEST_FILE), bytes);
            await syncDir(staging);
            await this.renameWithRetry(staging, pending);
        } catch (err) {
            await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
            throw err;
        }
        await syncDir(nodePath.join(inbox, PENDING));
    }

    /**
     * Windows refuses a rename while anything (an indexer, antivirus, a sync client) holds
     * a handle inside the folder, with EPERM or EBUSY. That clears in milliseconds.
     */
    private async renameWithRetry(from: string, to: string): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            try {
                await this.renameFn(from, to);
                return;
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (attempt >= RENAME_ATTEMPTS || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
                await sleep(20 * 2 ** attempt);
            }
        }
    }

    /** Where this bundleId already is, and when it first arrived if that can be trusted. */
    private async findExisting(inbox: string, bundleId: string): Promise<{ receivedAt: string | null } | null> {
        for (const state of [PENDING, ...SETTLED]) {
            const dir = nodePath.join(inbox, state, bundleId);
            if (!(await lstatOrNull(dir))) continue;
            let receivedAt: string | null = null;
            try {
                const bytes = await readSmallFile(nodePath.join(dir, MANIFEST_FILE), MAX_STORED_MANIFEST);
                const parsed: unknown = bytes ? JSON.parse(bytes.toString('utf8')) : null;
                if (verifySealedManifest(this.deps.keys.manifestKey(), parsed)) {
                    const server = (parsed as { server?: unknown }).server;
                    if (isServerStamp(server)) receivedAt = server.receivedAt;
                }
            } catch {
                // Unreadable or forged: still a duplicate, just without a trusted time.
            }
            return { receivedAt };
        }
        return null;
    }

    /**
     * Creates the layout and checks that it is really inside the workspace. A symlink
     * planted at .osint-inbox (or at one of its folders) would otherwise carry every
     * bundle to wherever it points.
     */
    private async ensureLayout(root: string): Promise<string> {
        const inbox = nodePath.join(root, INBOX_FOLDER);
        for (const sub of [STAGING, PENDING, ...SETTLED]) {
            await fsp.mkdir(nodePath.join(inbox, sub), { recursive: true });
        }
        for (const p of [inbox, ...[STAGING, PENDING, ...SETTLED].map(sub => nodePath.join(inbox, sub))]) {
            if (!(await isRealDir(p)) || (await realpathOrNull(p)) !== p) {
                throw new InboxError(`${nodePath.relative(root, p)} is not a folder inside the workspace`);
            }
        }
        return inbox;
    }

    // --- staging -----------------------------------------------------------------------

    /** Removes staging folders older than an hour: writes that died before their rename. */
    async sweepStaging(root: string): Promise<number> {
        const staging = nodePath.join(root, INBOX_FOLDER, STAGING);
        if (!(await isRealDir(staging))) return 0;
        let removed = 0;
        for (const name of await fsp.readdir(staging)) {
            const p = nodePath.join(staging, name);
            const stats = await lstatOrNull(p);
            if (!stats || this.now() - stats.mtimeMs <= STAGING_MAX_AGE_MS) continue;
            await fsp.rm(p, { recursive: true, force: true });
            removed++;
        }
        return removed;
    }

    /**
     * Sweeps every investigation; called on every server start. Always sweeps, not once
     * per writer: the writer outlives a stop and start of the server (the switch, a
     * licence that lapses and returns), and each start is owed a sweep.
     */
    async sweepAll(): Promise<void> {
        this.swept.clear();
        for (const { root } of await this.investigations()) {
            await this.serialized(root, () => this.sweepOnce(root)).catch(() => undefined);
        }
    }

    private async sweepOnce(root: string): Promise<void> {
        if (this.swept.has(root)) return;
        this.swept.add(root);
        await this.sweepStaging(root);
    }

    // --- the renderer's side (through inbox/ipc.ts) ------------------------------------

    /**
     * Pending bundles whose MAC and contents still check out. Anything else is moved to
     * rejected/ with a reason and left out: a bundle that did not come through the server
     * must not be applied with the extension's provenance.
     */
    async listPending(root: string): Promise<InboxBundle[]> {
        return this.serialized(root, async () => {
            const inbox = await this.ensureLayout(root);
            await this.sweepOnce(root);
            const pendingDir = nodePath.join(inbox, PENDING);
            const bundles: InboxBundle[] = [];
            for (const name of await fsp.readdir(pendingDir)) {
                // Each on its own: one folder that cannot be checked or moved must not
                // hide every good bundle behind it.
                try {
                    const checked = await this.checkBundle(nodePath.join(pendingDir, name), name);
                    if (checked.ok === true) bundles.push(checked.bundle);
                    else if (checked.ok === false) await this.quarantine(inbox, name, checked.reason);
                } catch {
                    // Left in pending/, to be looked at again on the next list.
                }
            }
            return bundles.sort((a, b) => a.server.receivedAt.localeCompare(b.server.receivedAt) || a.bundleId.localeCompare(b.bundleId));
        });
    }

    private async checkBundle(dir: string, name: string): Promise<Checked> {
        if (!UUID_V4.test(name)) return { ok: false, reason: 'folder name is not a bundle id' };
        let stats: fs.Stats;
        try {
            stats = await fsp.lstat(dir);
        } catch {
            return { ok: 'skip' };
        }
        if (!stats.isDirectory()) return { ok: false, reason: 'not a folder' };
        let parsed: unknown;
        try {
            const bytes = await readSmallFile(nodePath.join(dir, MANIFEST_FILE), MAX_STORED_MANIFEST);
            if (!bytes) return { ok: false, reason: 'manifest.json is missing' };
            parsed = JSON.parse(bytes.toString('utf8'));
        } catch (err) {
            if (err instanceof TransientReadError) return { ok: 'skip' };
            return { ok: false, reason: err instanceof InboxError ? err.message : 'manifest.json is not JSON' };
        }
        if (!verifySealedManifest(this.deps.keys.manifestKey(), parsed)) {
            return { ok: false, reason: 'the MAC does not verify' };
        }
        const { server, mac: _mac, ...manifest } = parsed as Record<string, unknown>;
        if (!isServerStamp(server)) return { ok: false, reason: 'the server stamp is malformed' };
        // A MAC proves main wrote it; revalidating proves this build still accepts it, and
        // that nothing an older build let through reaches the renderer uncleaned.
        const revalidated = validateManifest(manifest);
        if (revalidated.ok === false) return { ok: false, reason: `the manifest no longer validates: ${revalidated.detail}` };
        if (canonicalJson(revalidated.value) !== canonicalJson(manifest)) return { ok: false, reason: 'the manifest is not in clean form' };
        if (revalidated.value.bundleId !== name) return { ok: false, reason: 'the folder name and bundleId differ' };

        return {
            ok: true,
            bundle: { bundleId: name, manifest: revalidated.value, server, state: await this.readState(dir) },
        };
    }

    /** The journal, or null when there is none yet (or it is unreadable: steps are re-runnable). */
    private async readState(dir: string): Promise<InboxState | null> {
        try {
            const bytes = await readSmallFile(nodePath.join(dir, STATE_FILE), MAX_STATE_BYTES);
            if (!bytes) return null;
            const parsed: unknown = JSON.parse(bytes.toString('utf8'));
            return isState(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    private async quarantine(inbox: string, name: string, reason: string): Promise<void> {
        const rejected = nodePath.join(inbox, REJECTED);
        let target = UUID_V4.test(name) ? name : `invalid-${randomBytes(6).toString('hex')}`;
        if (await lstatOrNull(nodePath.join(rejected, target))) target = `${target}-${randomBytes(6).toString('hex')}`;
        const moved = nodePath.join(rejected, target);
        await this.renameWithRetry(nodePath.join(inbox, PENDING, name), moved);
        if (!(await isRealDir(moved))) return;
        // A forged folder may hold a symlink named reason.json; rm removes the link itself,
        // and the exclusive create then refuses anything that reappears.
        const reasonFile = nodePath.join(moved, REASON_FILE);
        await fsp.rm(reasonFile, { force: true, recursive: true });
        await writeExclusive(reasonFile, JSON.stringify({ reason, at: new Date(this.now()).toISOString() }, null, 2))
            .catch(() => undefined);
    }

    /** The folder of a bundle that is pending or done, the two states that are journalled. */
    private async bundleDir(inbox: string, bundleId: string, states: readonly string[]): Promise<{ dir: string; state: string }> {
        if (typeof bundleId !== 'string' || !UUID_V4.test(bundleId)) throw new InboxError('Not a bundle id');
        for (const state of states) {
            const dir = nodePath.join(inbox, state, bundleId);
            if (await isRealDir(dir)) return { dir, state };
        }
        throw new InboxError(`No ${states.join(' or ')} bundle ${bundleId}`);
    }

    /**
     * Records one journal step in the bundle's state.json. A step recorded again merges
     * into the first (object data) or replaces it, so re-running a step is idempotent.
     */
    async recordStep(root: string, bundleId: string, step: string, data: unknown): Promise<InboxState> {
        if (typeof step !== 'string' || !STEP_NAME.test(step)) throw new InboxError('Not a step name');
        let dataJson: string | undefined;
        try {
            dataJson = JSON.stringify(data ?? null);
        } catch {
            dataJson = undefined;
        }
        if (dataJson === undefined) throw new InboxError('Step data must be JSON');
        const clean: unknown = JSON.parse(dataJson);

        return this.serialized(root, async () => {
            const inbox = await this.ensureLayout(root);
            const { dir } = await this.bundleDir(inbox, bundleId, [PENDING, DONE]);
            const state: InboxState = (await this.readState(dir)) ?? { v: 1, steps: [] };
            const at = new Date(this.now()).toISOString();
            const existing = state.steps.find(s => s.step === step);
            if (existing) {
                existing.data = isPlainObject(existing.data) && isPlainObject(clean) ? { ...existing.data, ...clean } : clean;
                existing.at = at;
            } else {
                const record: InboxStepRecord = { step, at, data: clean };
                state.steps.push(record);
            }
            await this.writeState(dir, state);
            return state;
        });
    }

    private async writeState(dir: string, state: InboxState): Promise<void> {
        const bytes = Buffer.from(JSON.stringify(state, null, 2), 'utf8');
        if (bytes.length > MAX_STATE_BYTES) throw new InboxError('The journal would be too large');

        // A fresh file renamed over the old: never a half-written journal, and the
        // rename replaces a planted symlink rather than writing through it.
        const tmp = nodePath.join(dir, `.${STATE_FILE}.${randomBytes(4).toString('hex')}.tmp`);
        try {
            await writeExclusive(tmp, bytes);
            await this.renameWithRetry(tmp, nodePath.join(dir, STATE_FILE));
        } catch (err) {
            await fsp.rm(tmp, { force: true }).catch(() => undefined);
            throw err;
        }
    }

    /**
     * The applied bundles, done or removed, the newest APPLIED_LIST_LIMIT by receive time,
     * oldest first, each with its journal. This is the activity log the renderer shows:
     * it lives here, one journal per bundle, rather than in the investigation's settings
     * file, which every window rewrites whole from its own copy. Any window on the
     * investigation reads the same list, fresh.
     *
     * Each MAC is checked like a pending one, but a bundle that fails is only left out:
     * it was already applied, and moving it would hide nothing the vault does not hold.
     */
    async listApplied(root: string): Promise<InboxAppliedBundle[]> {
        return this.serialized(root, async () => {
            const inbox = await this.ensureLayout(root);
            const out: InboxAppliedBundle[] = [];
            for (const where of [DONE, REMOVED] as const) {
                const dir = nodePath.join(inbox, where);
                let names: string[];
                try {
                    names = await fsp.readdir(dir);
                } catch {
                    continue;
                }
                for (const name of names) {
                    try {
                        const checked = await this.checkBundle(nodePath.join(dir, name), name);
                        if (checked.ok === true) out.push({ ...checked.bundle, where });
                    } catch {
                        // Unreadable just now; the next listing looks again.
                    }
                }
            }
            out.sort((a, b) => a.server.receivedAt.localeCompare(b.server.receivedAt) || a.bundleId.localeCompare(b.bundleId));
            return out.slice(-APPLIED_LIST_LIMIT);
        });
    }

    /**
     * Moves a bundle out of pending/ once it is applied (done) or refused (rejected).
     * `removed` is the Remove action on an applied item, so it also moves one out of done/.
     */
    async finish(root: string, bundleId: string, outcome: InboxOutcome): Promise<void> {
        if (outcome !== DONE && outcome !== REJECTED && outcome !== REMOVED) throw new InboxError('Not an outcome');
        await this.serialized(root, async () => {
            const inbox = await this.ensureLayout(root);
            const from = await this.bundleDir(inbox, bundleId, outcome === REMOVED ? [PENDING, DONE] : [PENDING]);
            const to = nodePath.join(inbox, outcome, bundleId);
            if (await lstatOrNull(to)) throw new InboxError(`Bundle ${bundleId} is already ${outcome}`);
            await this.renameWithRetry(from.dir, to);
        });
        this.notifyInboxChanged(root);
    }

    /**
     * The Remove action on an applied item: done/ to removed/ only. finish() would also
     * take a pending bundle to removed/, which here would mean dropping something that was
     * never applied, so Remove cannot reach that.
     */
    async markRemoved(root: string, bundleId: string): Promise<void> {
        await this.serialized(root, async () => {
            const inbox = await this.ensureLayout(root);
            const from = await this.bundleDir(inbox, bundleId, [DONE]);
            const to = nodePath.join(inbox, REMOVED, bundleId);
            if (await lstatOrNull(to)) throw new InboxError(`Bundle ${bundleId} is already ${REMOVED}`);
            // When, for the activity log. Best effort: the move is what Remove means.
            try {
                const state: InboxState = (await this.readState(from.dir)) ?? { v: 1, steps: [] };
                state.steps = state.steps.filter(s => s.step !== REMOVED_STEP);
                state.steps.push({ step: REMOVED_STEP, at: new Date(this.now()).toISOString(), data: null });
                await this.writeState(from.dir, state);
            } catch {
                // The bundle still moves; the log then shows no removal time.
            }
            await this.renameWithRetry(from.dir, to);
        });
        this.notifyInboxChanged(root);
    }

    // --- ordering ----------------------------------------------------------------------

    private serialized<T>(root: string, task: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(root) ?? Promise.resolve();
        const next = previous.then(task, task);
        const settled = next.catch(() => undefined);
        this.queues.set(root, settled);
        void settled.then(() => {
            if (this.queues.get(root) === settled) this.queues.delete(root);
        });
        return next;
    }
}
