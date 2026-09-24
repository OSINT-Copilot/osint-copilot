/**
 * The browser extension's inbox: where main puts what the extension sends, and the only
 * code that touches `<workspace>/.osint-inbox/`.
 *
 *   .osint-inbox/
 *     .staging/<bundleId>/   being written; swept after an hour
 *     pending/<bundleId>/    manifest.json (main's MAC on it), state.json (the journal)
 *     done/ rejected/ removed/
 *
 * A capture is staged across several requests: created (upload.json, sealed, reserving
 * its declared bytes against the budget), then each file streamed in, then committed
 * (manifest.json written last, naming each file's server-computed sha256 under the MAC)
 * and renamed into pending/ whole. main then derives page.markdown, fullpage.png and
 * derived.json into the pending folder (capture/deriver.ts), and only then lists it.
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
 * No electron import. What it needs from OSINT Copilot (the known workspaces, which windows
 * have one open) comes through InboxHost; see tangent-host.ts.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as nodePath from 'path';
import { randomBytes } from 'crypto';
import { B64URL_16, CAPTURE_FILE_NAMES } from '../extension/protocol';
import type {
    CaptureFileName,
    CaptureFiles,
    CaptureManifest,
    Manifest,
    StatusResponse,
    WorkspaceInfo,
} from '../extension/protocol';
import { safeEqualText, sha256Hex, workspaceIdFor } from '../extension/signing';
import { validateManifest } from '../extension/validate';
import type {
    BundleContext,
    BundleOutcome,
    CommitOutcome,
    FileOutcome,
    FileUpload,
    InboxBackend,
} from '../extension/server';
import { INBOX_FOLDER } from '../node/vault';
import type { DeriveResults, DeriveStore, DeriveTarget } from '../capture/deriver';
import { hashFile, receiveToFile, syncDir } from './capture-files';
import { evidenceStem } from '../capture/slug';
import {
    DigestMismatchError,
    EVIDENCE_FOLDER,
    PLACED_EXTENSIONS,
    PlacementError,
    copyVerified,
    evidenceDir,
    placeOne,
    sweepPlacementTemps,
    unplace,
    type PlaceContext,
} from './place-files';
import {
    canonicalJson,
    sealDerived,
    sealManifest,
    verifySealedDerived,
    verifySealedManifest,
    type ServerStamp,
} from './manifest-mac';
import type {
    InboxAppliedBundle,
    InboxBundle,
    InboxCaptureDerived,
    InboxOutcome,
    InboxPlacedFile,
    InboxPlacedRole,
    InboxPlacement,
    InboxServerStamp,
    InboxState,
    InboxStepRecord,
} from '../../../osint/host/types';

export { INBOX_FOLDER };
const STAGING = '.staging';
export const PENDING = 'pending';
const DONE = 'done';
const REJECTED = 'rejected';
const REMOVED = 'removed';
const SETTLED = [DONE, REJECTED, REMOVED] as const;
/** The journal step markRemoved writes: when the item was removed. */
export const REMOVED_STEP = 'removed';
/**
 * The journal step placeFiles writes, before creating each file: the Evidence names this
 * bundle made, with their digests. Main's own, so a placement resumed after a crash knows
 * which files it made rather than taking them for someone else's.
 */
export const PLACEMENT_STEP = 'placement';
/** How many applied bundles listApplied returns, newest by receive time. */
const APPLIED_LIST_LIMIT = 500;

/** Sent to every window with the workspace open whenever its pending set changes. */
export const INBOX_CHANGED_CHANNEL = 'osint:inbox.changed';

/** Per workspace. When full the server refuses; it never deletes anything to make room. */
const INBOX_BUDGET_BYTES = 2 * 1024 ** 3;
/** Staging older than this belongs to a write that died; a live one takes milliseconds. */
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
/** How long a running inbox size is trusted before the tree is walked again. */
const SIZE_RESCAN_MS = 10 * 60 * 1000;

const MANIFEST_FILE = 'manifest.json';
const STATE_FILE = 'state.json';
const REASON_FILE = 'reason.json';
/** A capture's create-time record: the sealed manifest and stamp, before any file. */
const UPLOAD_FILE = 'upload.json';
const DERIVED_FILE = 'derived.json';
/** Never .md inside the inbox: the renderer's indexer must not pick page text up from here. */
const MARKDOWN_FILE = 'page.markdown';
const FULLPAGE_FILE = 'fullpage.png';
const MAX_DERIVED_BYTES = 64 * 1024;
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

/** What the inbox needs from OSINT Copilot's window and workspace bookkeeping. */
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
    /**
     * Asks for a pending capture to be derived (CaptureDeriver.enqueue in the app). Called
     * at commit, and for any pending capture found without derived.json.
     */
    derive?: (root: string, bundleId: string) => void;
    /** How long a file upload may send nothing before it is abandoned (UPLOAD_IDLE_MS). */
    uploadIdleMs?: number;
}

interface Investigation {
    /** Realpath. */
    root: string;
    id: string;
    name: string;
}

class InboxError extends Error {}

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
    if (!isPlainObject(v)) return false;
    const keys = Object.keys(v).length;
    return (keys === 4 || (keys === 5 && isPlainObject(v.files)))
        && typeof v.receivedAt === 'string' && typeof v.clientId === 'string'
        && typeof v.origin === 'string' && typeof v.extVersion === 'string';
}

function declaredTotal(files: CaptureFiles): number {
    return CAPTURE_FILE_NAMES.reduce((sum, name) => sum + (files[name]?.size ?? 0), 0);
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

/** Total bytes of regular files beneath `dir`, not following symlinks, less the folder `skip`. */
async function treeSize(dir: string, skip?: string): Promise<number> {
    let total = 0;
    let entries: fs.Dirent[];
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const p = nodePath.join(dir, entry.name);
        if (entry.name === skip) continue;
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

/** One sealed upload.json, read back. */
interface Upload {
    manifest: CaptureManifest;
    server: ServerStamp;
    bytes: number;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class InboxWriter implements InboxBackend, DeriveStore {
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
    /** `<bundleId>/<file name>` for every file being streamed in right now. */
    private readonly receiving = new Set<string>();

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

    async listWorkspaces(): Promise<WorkspaceInfo[]> {
        const open = await this.openRealRoots();
        return (await this.investigations()).map(({ id, name, root }) => ({ id, name, open: open.has(root) }));
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
        return { licensed, pendingCount };
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
        if (value.kind === 'capture') return this.createCapture(root, value, ctx);

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
     * Whether `adding` more bytes fits. Committed bytes are a running total that drifts:
     * journals grow, derived files appear, sweeps and the user's own deletions shrink the
     * tree. It is rescanned when it is old, and always before a refusal, so the drift can
     * only make the budget a little soft, never refuse a send there is room for.
     *
     * Staging is counted afresh each time, and a capture being uploaded counts at the size
     * it declared, not at what has arrived so far: its bytes were promised when it was
     * created, and two captures cannot both be promised the last free gigabyte.
     */
    private async withinBudget(root: string, inbox: string, adding: number): Promise<boolean> {
        const reserved = await this.stagingReserved(inbox);
        const cached = this.sizes.get(root);
        if (cached && this.now() - cached.scannedAt < SIZE_RESCAN_MS && cached.bytes + reserved + adding <= this.budget) return true;
        const fresh = { bytes: await treeSize(inbox, STAGING), scannedAt: this.now() };
        this.sizes.set(root, fresh);
        return fresh.bytes + reserved + adding <= this.budget;
    }

    /** Bytes held in staging: each capture upload at its declared size, anything else as found. */
    private async stagingReserved(inbox: string): Promise<number> {
        const staging = nodePath.join(inbox, STAGING);
        let names: string[];
        try {
            names = await fsp.readdir(staging);
        } catch {
            return 0;
        }
        let total = 0;
        for (const name of names) {
            const dir = nodePath.join(staging, name);
            const upload = UUID_V4.test(name) ? await this.readUpload(dir, name).catch(() => null) : null;
            const found = await treeSize(dir);
            total += upload ? Math.max(found, upload.bytes + declaredTotal(upload.manifest.capture.files)) : found;
        }
        return total;
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


    // --- captures: create, files, commit ----------------------------------------------

    private stamp(ctx: BundleContext): ServerStamp {
        return { receivedAt: ctx.receivedAt, clientId: ctx.clientId, origin: ctx.origin, extVersion: ctx.extVersion };
    }

    /**
     * POST /v1/bundles for a capture. Stages upload.json, which reserves the declared
     * bytes, and answers with the files still to send. Sent again for a capture still in
     * staging (the extension resuming after a restart or a lost reply), it answers the
     * same way with what is still missing; once committed, duplicate.
     */
    private createCapture(root: string, manifest: CaptureManifest, ctx: BundleContext): Promise<BundleOutcome> {
        return this.serialized(root, async (): Promise<BundleOutcome> => {
            const inbox = await this.ensureLayout(root);
            await this.sweepOnce(root);
            const bundleId = manifest.bundleId;

            const existing = await this.findExisting(inbox, bundleId);
            if (existing) return { status: 'duplicate', bundleId, receivedAt: existing.receivedAt ?? ctx.receivedAt };

            const dir = nodePath.join(inbox, STAGING, bundleId);
            const upload = await this.readUpload(dir, bundleId).catch((err) => {
                // Unreadable just now (a handle limit, an antivirus lock) is not "not ours":
                // the rm below would discard files already received. 500; the resend resumes.
                if (err instanceof TransientReadError) throw err;
                return null;
            });
            if (upload) {
                // Resuming: the same client, the same page and the same files. clientTime
                // may differ between tries and means nothing.
                const same = (m: CaptureManifest) => canonicalJson({ w: m.workspaceId, p: m.page, c: m.capture });
                if (upload.server.clientId !== ctx.clientId || same(upload.manifest) !== same(manifest)) {
                    return { error: 'invalid', detail: 'bundleId: already used for a different capture' };
                }
                return { status: 'created', bundleId, missing: await this.missingFiles(dir, upload.manifest) };
            }

            const bytes = Buffer.from(JSON.stringify(sealManifest(this.deps.keys.manifestKey(), manifest, this.stamp(ctx)), null, 2), 'utf8');
            if (!(await this.withinBudget(root, inbox, bytes.length + declaredTotal(manifest.capture.files)))) {
                return { error: 'budget_exceeded' };
            }
            // Whatever is there is not a capture this server staged (no sealed upload.json).
            await fsp.rm(dir, { recursive: true, force: true });
            await fsp.mkdir(dir);
            try {
                await writeExclusive(nodePath.join(dir, UPLOAD_FILE), bytes);
                await syncDir(dir);
            } catch (err) {
                await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
                throw err;
            }
            return { status: 'created', bundleId, missing: CAPTURE_FILE_NAMES.filter(n => manifest.capture.files[n]) };
        });
    }

    /** A staged capture's upload.json, if main sealed it and it still validates. */
    private async readUpload(dir: string, bundleId: string): Promise<Upload | null> {
        const bytes = await readSmallFile(nodePath.join(dir, UPLOAD_FILE), MAX_STORED_MANIFEST);
        if (!bytes) return null;
        let parsed: unknown;
        try {
            parsed = JSON.parse(bytes.toString('utf8'));
        } catch {
            return null;
        }
        if (!verifySealedManifest(this.deps.keys.manifestKey(), parsed)) return null;
        const { server, mac: _mac, ...rest } = parsed as Record<string, unknown>;
        const checked = validateManifest(rest);
        if (checked.ok === false || checked.value.kind !== 'capture' || checked.value.bundleId !== bundleId) return null;
        if (!isServerStamp(server) || server.files !== undefined) return null;
        return { manifest: checked.value, server, bytes: bytes.length };
    }

    /** Declared files not yet in place, in the fixed order. */
    private async missingFiles(dir: string, manifest: CaptureManifest): Promise<CaptureFileName[]> {
        const missing: CaptureFileName[] = [];
        for (const name of CAPTURE_FILE_NAMES) {
            const decl = manifest.capture.files[name];
            if (!decl) continue;
            const stats = await lstatOrNull(nodePath.join(dir, name));
            if (!stats || !stats.isFile() || stats.size !== decl.size) missing.push(name);
        }
        return missing;
    }

    /**
     * Where a bundle id is, in any investigation: still staging, or already committed.
     * Only ids reach here (the server's route admits nothing else), and each is looked up
     * by exact name under a real inbox folder.
     */
    private async locate(bundleId: string): Promise<{ root: string; staged: boolean } | null> {
        for (const { root } of await this.investigations()) {
            const inbox = nodePath.join(root, INBOX_FOLDER);
            if (!(await isRealDir(inbox))) continue;
            if (await isRealDir(nodePath.join(inbox, STAGING, bundleId))) return { root, staged: true };
            for (const state of [PENDING, ...SETTLED]) {
                if (await lstatOrNull(nodePath.join(inbox, state, bundleId))) return { root, staged: false };
            }
        }
        return null;
    }

    /**
     * POST /v1/bundles/<id>/files/<name>. Everything that can be refused is refused before
     * a byte is read: the capture must be staged by this client, the name declared, and
     * the length and digest the ones declared. The body is then streamed to disk outside
     * the workspace's queue, so a large file does not hold up every other inbox call.
     */
    async receiveFile(upload: FileUpload, ctx: BundleContext): Promise<FileOutcome> {
        const { bundleId, name } = upload;
        if (!UUID_V4.test(bundleId) || !(CAPTURE_FILE_NAMES as readonly string[]).includes(name)) {
            return { error: 'invalid', detail: 'not a capture file' };
        }
        if (!(await this.deps.licensed())) return { error: 'unlicensed' };
        const found = await this.locate(bundleId);
        if (!found) return { error: 'unknown_bundle' };
        if (!found.staged) return { error: 'conflict', detail: 'the capture is already committed' };

        const lock = `${bundleId}/${name}`;
        type Ready = { dir: string; size: number; sha256: string };
        const prepared = await this.serialized(found.root, async (): Promise<FileOutcome | Ready> => {
            const inbox = await this.ensureLayout(found.root);
            const dir = nodePath.join(inbox, STAGING, bundleId);
            const staged = (await isRealDir(dir)) ? await this.readUpload(dir, bundleId).catch(() => null) : null;
            // Another client's capture is as unknown as one that does not exist.
            if (!staged || staged.server.clientId !== ctx.clientId) return { error: 'unknown_bundle' };
            const decl = staged.manifest.capture.files[name];
            if (!decl) return { error: 'invalid', detail: `${name}: not declared in the manifest` };
            if (upload.size !== decl.size) return { error: 'invalid', detail: `${name}: Content-Length is not the declared size` };
            if (upload.sha256 !== decl.sha256) return { error: 'invalid', detail: `${name}: X-OC-Body-Sha256 is not the declared sha256` };
            if (this.receiving.has(lock)) return { error: 'conflict', detail: `${name} is being received on another connection` };
            const present = await lstatOrNull(nodePath.join(dir, name));
            // In place under its real name means it was checked on the way in; commit
            // hashes it again.
            if (present && present.isFile() && present.size === decl.size) return { received: true };
            if (present) await fsp.rm(nodePath.join(dir, name), { recursive: true, force: true });
            this.receiving.add(lock);
            return { dir, size: decl.size, sha256: decl.sha256 };
        });
        if (!('dir' in prepared)) return prepared;

        try {
            // A stalled body throws after its .part is gone; the finally frees the name.
            const result = await receiveToFile(prepared.dir, name, upload.body, prepared, this.deps.uploadIdleMs);
            return 'error' in result ? { error: result.error, detail: result.detail } : { received: true };
        } finally {
            this.receiving.delete(lock);
        }
    }

    /**
     * POST /v1/bundles/<id>/commit. Every declared file must be in place and hash to its
     * declared digest (hashed again here: the staging folder is on disk, and disks are
     * shared). manifest.json is written last, naming each file's size and sha256 under the
     * MAC, and the folder is renamed into pending/ whole.
     */
    async commitBundle(bundleId: string, ctx: BundleContext): Promise<CommitOutcome> {
        if (!UUID_V4.test(bundleId)) return { error: 'unknown_bundle' };
        if (!(await this.deps.licensed())) return { error: 'unlicensed' };
        const found = await this.locate(bundleId);
        if (!found) return { error: 'unknown_bundle' };

        const outcome = await this.serialized(found.root, async (): Promise<CommitOutcome> => {
            const inbox = await this.ensureLayout(found.root);
            const dir = nodePath.join(inbox, STAGING, bundleId);
            if (!(await isRealDir(dir))) {
                // A retry of a commit whose reply was lost.
                const existing = await this.findExisting(inbox, bundleId);
                return existing
                    ? { status: 'duplicate', bundleId, receivedAt: existing.receivedAt ?? ctx.receivedAt }
                    : { error: 'unknown_bundle' };
            }
            const staged = await this.readUpload(dir, bundleId).catch(() => null);
            if (!staged || staged.server.clientId !== ctx.clientId) return { error: 'unknown_bundle' };
            if ([...this.receiving].some(k => k.startsWith(`${bundleId}/`))) {
                return { error: 'conflict', detail: 'a file is still being received' };
            }

            const declared = staged.manifest.capture.files;
            const files: Partial<CaptureFiles> = {};
            const missing: CaptureFileName[] = [];
            for (const name of CAPTURE_FILE_NAMES) {
                const decl = declared[name];
                if (!decl) continue;
                const p = nodePath.join(dir, name);
                const got = await hashFile(p).catch(() => null);
                if (got && got.size === decl.size && got.sha256 === decl.sha256) {
                    files[name] = got;
                    continue;
                }
                // Changed since it was received: gone, so the extension sends it again.
                if (got) await fsp.rm(p, { force: true });
                missing.push(name);
            }
            if (missing.length) return { error: 'incomplete', detail: missing };

            // Only what the bundle is made of goes to pending/: a .part or a manifest.json
            // left by a commit that died on the way is removed first.
            const keep = new Set<string>([UPLOAD_FILE, ...CAPTURE_FILE_NAMES.filter(n => declared[n])]);
            for (const entry of await fsp.readdir(dir)) {
                if (!keep.has(entry)) await fsp.rm(nodePath.join(dir, entry), { recursive: true, force: true });
            }
            const server: ServerStamp = { ...staged.server, files: files as CaptureFiles };
            const bytes = Buffer.from(JSON.stringify(sealManifest(this.deps.keys.manifestKey(), staged.manifest, server), null, 2), 'utf8');
            await writeExclusive(nodePath.join(dir, MANIFEST_FILE), bytes);
            await syncDir(dir);
            await this.renameWithRetry(dir, nodePath.join(inbox, PENDING, bundleId));
            await syncDir(nodePath.join(inbox, PENDING));
            const size = this.sizes.get(found.root);
            if (size) size.bytes += bytes.length + staged.bytes + declaredTotal(declared);
            return { status: 'accepted', bundleId, receivedAt: staged.server.receivedAt };
        });
        if ('status' in outcome && outcome.status === 'accepted') {
            this.requestDerive(found.root, bundleId);
            this.notifyInboxChanged(found.root);
        }
        return outcome;
    }

    // --- captures: derived results ------------------------------------------------------

    private requestDerive(root: string, bundleId: string): void {
        try {
            this.deps.derive?.(root, bundleId);
        } catch {
            // The next listing asks again.
        }
    }

    /** derived.json, if main sealed it for this bundle. Without its MAC. */
    private async readDerived(dir: string, bundleId: string): Promise<InboxCaptureDerived | null> {
        try {
            const bytes = await readSmallFile(nodePath.join(dir, DERIVED_FILE), MAX_DERIVED_BYTES);
            if (!bytes) return null;
            const parsed: unknown = JSON.parse(bytes.toString('utf8'));
            if (!verifySealedDerived(this.deps.keys.manifestKey(), parsed, bundleId)) return null;
            const { mac: _mac, ...derived } = parsed;
            return derived;
        } catch {
            return null;
        }
    }

    /** DeriveStore: the archive of a pending capture that has no derived.json yet. */
    async deriveTarget(root: string, bundleId: string): Promise<DeriveTarget | null> {
        if (!UUID_V4.test(bundleId)) return null;
        return this.serialized(root, async () => {
            const dir = nodePath.join(root, INBOX_FOLDER, PENDING, bundleId);
            if (!(await isRealDir(dir))) return null;
            const checked = await this.checkBundle(dir, bundleId, { requireFiles: true }).catch(() => null);
            if (!checked || checked.ok !== true || checked.bundle.manifest.kind !== 'capture') return null;
            if (await this.readDerived(dir, bundleId)) return null;
            // checkBundle compares sizes only. A same-size archive swapped in after commit
            // must not be derived into markdown and a PNG sealed as this capture's.
            const archivePath = nodePath.join(dir, 'page.mhtml');
            const sealed = checked.bundle.server.files?.['page.mhtml'];
            const got = await hashFile(archivePath).catch(() => null);
            if (!got) return null;
            if (!sealed || got.size !== sealed.size || got.sha256 !== sealed.sha256) {
                await this.quarantine(nodePath.join(root, INBOX_FOLDER), bundleId, 'page.mhtml changed after commit');
                return null;
            }
            return { archivePath, pageUrl: checked.bundle.manifest.page.url, archiveSha256: got.sha256 };
        });
    }

    /**
     * DeriveStore: writes what was derived into the pending folder, derived.json last, so
     * a listing that sees derived.json sees the files it names. Each file replaces any
     * earlier attempt's by rename; one this attempt did not make is removed.
     */
    async writeDerived(root: string, bundleId: string, results: DeriveResults): Promise<void> {
        if (!UUID_V4.test(bundleId)) return;
        const written = await this.serialized(root, async () => {
            const dir = nodePath.join(root, INBOX_FOLDER, PENDING, bundleId);
            // Moved on (rejected, or removed by hand) while it was being derived.
            if (!(await isRealDir(dir))) return false;
            const derived: InboxCaptureDerived = {
                v: 1,
                bundleId,
                status: results.markdown !== undefined ? 'done' : 'failed',
                archiveSha256: results.archiveSha256,
                contentLocation: results.contentLocation,
                urlMismatch: results.urlMismatch,
                title: results.title,
                errors: results.errors,
                derivedAt: new Date(this.now()).toISOString(),
            };
            if (results.markdown !== undefined) {
                const bytes = Buffer.from(results.markdown, 'utf8');
                await this.writeReplacing(dir, MARKDOWN_FILE, bytes);
                derived.markdown = { file: MARKDOWN_FILE, sha256: sha256Hex(bytes) };
            } else {
                await fsp.rm(nodePath.join(dir, MARKDOWN_FILE), { force: true, recursive: true });
            }
            if (results.fullpage) {
                await this.writeReplacing(dir, FULLPAGE_FILE, results.fullpage);
                derived.fullpage = { file: FULLPAGE_FILE, sha256: sha256Hex(results.fullpage) };
            } else {
                await fsp.rm(nodePath.join(dir, FULLPAGE_FILE), { force: true, recursive: true });
                derived.fullpage = { error: results.fullpageError ?? 'not rendered' };
            }
            const sealed = sealDerived(this.deps.keys.manifestKey(), derived);
            await this.writeReplacing(dir, DERIVED_FILE, Buffer.from(JSON.stringify(sealed, null, 2), 'utf8'));
            await syncDir(dir);
            return true;
        });
        if (written) this.notifyInboxChanged(root);
    }

    /** Asks for every pending capture in this investigation that has no derived.json. */
    private async rederiveMissing(root: string): Promise<void> {
        const pendingDir = nodePath.join(root, INBOX_FOLDER, PENDING);
        if (!(await isRealDir(pendingDir))) return;
        // listPending asks for each one it cannot list for want of derived.json.
        await this.listPending(root);
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
            // A capture committed just before the app stopped may never have been derived.
            await this.rederiveMissing(root).catch(() => undefined);
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
                    const dir = nodePath.join(pendingDir, name);
                    const checked = await this.checkBundle(dir, name, { requireFiles: true });
                    if (checked.ok === false) await this.quarantine(inbox, name, checked.reason);
                    if (checked.ok !== true) continue;
                    if (checked.bundle.manifest.kind === 'capture') {
                        // Not listed until main has derived it; the renderer places what
                        // derived.json names, so it must not see a capture before that.
                        const derived = await this.readDerived(dir, name);
                        if (!derived) {
                            this.requestDerive(root, name);
                            continue;
                        }
                        checked.bundle.derived = derived;
                    }
                    bundles.push(checked.bundle);
                } catch {
                    // Left in pending/, to be looked at again on the next list.
                }
            }
            return bundles.sort((a, b) => a.server.receivedAt.localeCompare(b.server.receivedAt) || a.bundleId.localeCompare(b.bundleId));
        });
    }

    /**
     * `requireFiles`: a pending capture must still hold every file its manifest names, at
     * the size main stored. An applied one is only listed, so it is not held to that.
     */
    private async checkBundle(dir: string, name: string, opts: { requireFiles?: boolean } = {}): Promise<Checked> {
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
        if (revalidated.value.kind === 'capture') {
            // What main computed at commit must be what was declared; both are under the MAC.
            if (!server.files || canonicalJson(server.files) !== canonicalJson(revalidated.value.capture.files)) {
                return { ok: false, reason: 'the stored files do not match the declared ones' };
            }
            if (opts.requireFiles) {
                for (const fileName of CAPTURE_FILE_NAMES) {
                    const decl = server.files[fileName];
                    if (!decl) continue;
                    const stats = await lstatOrNull(nodePath.join(dir, fileName));
                    if (!stats || !stats.isFile() || stats.size !== decl.size) {
                        return { ok: false, reason: `${fileName} is missing or changed` };
                    }
                }
            }
        } else if (server.files !== undefined) {
            return { ok: false, reason: 'a file list on a bundle that has no files' };
        }

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
        // Main's own record of the Evidence files a capture made: a renderer that could
        // write it could have placeFiles call a reused file its own, and Remove trash it.
        if (step === PLACEMENT_STEP) throw new InboxError('Not a step name');
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
        await this.writeReplacing(dir, STATE_FILE, bytes);
    }

    /**
     * A fresh file renamed over the old: never a half-written file, and the rename
     * replaces a planted symlink rather than writing through it.
     */
    private async writeReplacing(dir: string, name: string, bytes: Buffer): Promise<void> {
        const tmp = nodePath.join(dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
        try {
            await writeExclusive(tmp, bytes);
            await this.renameWithRetry(tmp, nodePath.join(dir, name));
        } catch (err) {
            await fsp.rm(tmp, { force: true }).catch(() => undefined);
            throw err;
        }
    }

    /**
     * Copies a pending capture's files into `OSINTCopilot/Evidence/` (see place-files.ts),
     * for the renderer that holds the lease. Everything is checked again first: the
     * manifest's MAC, derived.json's MAC and its binding to this archive, and each file's
     * bytes against its sealed digest, all of them before any is placed. A capture that
     * fails places nothing: it stays pending, or is set aside when what the extension sent
     * has changed since commit. Idempotent: run again, it finds its own files by name
     * and digest and reports the same answer.
     */
    async placeFiles(root: string, bundleId: string): Promise<InboxPlacement> {
        if (typeof bundleId !== 'string' || !UUID_V4.test(bundleId)) throw new InboxError('Not a bundle id');
        return this.serialized(root, async () => {
            const inbox = await this.ensureLayout(root);
            const { dir } = await this.bundleDir(inbox, bundleId, [PENDING]);
            const checked = await this.checkBundle(dir, bundleId, { requireFiles: true });
            if (checked.ok !== true) {
                throw new InboxError(checked.ok === false ? `Not placed: ${checked.reason}` : 'Not placed: the bundle cannot be read just now');
            }
            const { manifest, server } = checked.bundle;
            if (manifest.kind !== 'capture' || !server.files) throw new InboxError('Not placed: not a capture');
            const derived = await this.readDerived(dir, bundleId);
            if (!derived) throw new InboxError('Not placed: derived.json is missing or does not verify');
            const archive = server.files['page.mhtml'];
            if (derived.archiveSha256 !== archive.sha256) {
                throw new InboxError('Not placed: derived.json was made from another archive');
            }

            const wanted: Array<{ role: InboxPlacedRole; file: string; sha256: string }> = [
                { role: 'archive', file: 'page.mhtml', sha256: archive.sha256 },
            ];
            const fullpage = derived.fullpage;
            if (fullpage && 'file' in fullpage && fullpage.file === FULLPAGE_FILE) {
                wanted.push({ role: 'fullpage', file: FULLPAGE_FILE, sha256: fullpage.sha256 });
            }
            const viewport = server.files['viewport.png'];
            if (viewport) wanted.push({ role: 'viewport', file: 'viewport.png', sha256: viewport.sha256 });
            const pdf = server.files['page.pdf'];
            if (pdf) wanted.push({ role: 'pdf', file: 'page.pdf', sha256: pdf.sha256 });
            if (derived.markdown?.file === MARKDOWN_FILE) {
                wanted.push({ role: 'markdown', file: MARKDOWN_FILE, sha256: derived.markdown.sha256 });
            }

            let target: string;
            try {
                target = await evidenceDir(root, inbox);
            } catch (err) {
                throw err instanceof PlacementError ? new InboxError(`Not placed: ${err.message}`) : err;
            }
            await sweepPlacementTemps(dir);
            const state: InboxState = (await this.readState(dir)) ?? { v: 1, steps: [] };
            let record = state.steps.find(s => s.step === PLACEMENT_STEP);
            const owned: Record<string, string> = {};
            if (record && isPlainObject(record.data)) {
                for (const [name, sha] of Object.entries(record.data)) if (typeof sha === 'string') owned[name] = sha;
            }
            const stem = evidenceStem(manifest.page.title || derived.title, manifest.page.url, archive.sha256);
            const persist = async () => {
                if (!record) {
                    record = { step: PLACEMENT_STEP, at: '', data: null };
                    state.steps.push(record);
                }
                record.data = { ...owned };
                record.at = new Date(this.now()).toISOString();
                await this.writeState(dir, state);
            };
            const place: PlaceContext = {
                dir: target,
                stem,
                owned,
                claim: async (name, sha256) => {
                    owned[name] = sha256;
                    await persist();
                },
                unclaim: async (name) => {
                    if (!(name in owned)) return;
                    delete owned[name];
                    await persist();
                },
            };

            // Every file is checked against its sealed digest before any is placed: one
            // that fails part way would otherwise leave the ones before it in Evidence/,
            // owned by no activity item, where Remove could never take them back.
            const temps: string[] = [];
            try {
                for (const want of wanted) {
                    try {
                        temps.push(await copyVerified(nodePath.join(dir, want.file), dir, want.sha256));
                    } catch (err) {
                        if (err instanceof DigestMismatchError) {
                            if (want.role === 'archive' || want.role === 'viewport' || want.role === 'pdf') {
                                // What the extension sent has changed since commit: like an
                                // archive swapped before derivation, it is not this capture.
                                await this.quarantine(inbox, bundleId, `${want.file} changed after commit`);
                                this.notifyInboxChanged(root);
                            } else {
                                // Only what main made from it: made again from the archive.
                                await fsp.rm(nodePath.join(dir, DERIVED_FILE), { force: true });
                                this.requestDerive(root, bundleId);
                            }
                        }
                        throw err instanceof PlacementError ? new InboxError(`Not placed: ${err.message}`) : err;
                    }
                }
                const files: InboxPlacedFile[] = [];
                const linkedNow: string[] = [];
                try {
                    for (const [i, want] of wanted.entries()) {
                        const placed = await placeOne(place, { temp: temps[i], sha256: want.sha256, ext: PLACED_EXTENSIONS[want.role] });
                        if (placed.linkedNow) linkedNow.push(placed.name);
                        files.push({ role: want.role, path: `${EVIDENCE_FOLDER}/${placed.name}`, sha256: want.sha256, created: placed.created });
                    }
                } catch (err) {
                    // A disk that filled, a name that never came free: what this call
                    // placed goes again, so a capture is placed whole or not at all.
                    await unplace(place, linkedNow).catch(() => undefined);
                    throw err instanceof PlacementError ? new InboxError(`Not placed: ${err.message}`) : err;
                }
                return { bundleId, files };
            } finally {
                for (const temp of temps) await fsp.rm(temp, { force: true }).catch(() => undefined);
            }
        });
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
                        if (checked.ok !== true) continue;
                        if (checked.bundle.manifest.kind === 'capture') {
                            const derived = await this.readDerived(nodePath.join(dir, name), name);
                            if (derived) checked.bundle.derived = derived;
                        }
                        out.push({ ...checked.bundle, where });
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
     * Remove, on an applied item, is markRemoved.
     */
    async finish(root: string, bundleId: string, outcome: InboxOutcome): Promise<void> {
        if (outcome !== DONE && outcome !== REJECTED) throw new InboxError('Not an outcome');
        await this.serialized(root, async () => {
            const inbox = await this.ensureLayout(root);
            const from = await this.bundleDir(inbox, bundleId, [PENDING]);
            const to = nodePath.join(inbox, outcome, bundleId);
            if (await lstatOrNull(to)) throw new InboxError(`Bundle ${bundleId} is already ${outcome}`);
            await this.renameWithRetry(from.dir, to);
        });
        this.notifyInboxChanged(root);
    }

    /**
     * The Remove action on an applied item: done/ to removed/ only. A pending bundle is
     * never taken to removed/, which would mean dropping something that was never applied.
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
