/**
 * The host contract -- the complete boundary between renderer code and the OS.
 *
 * Implemented by:
 *   impl.tangent.ts     Renderer. Forwards to window.api.osint, which preload exposes
 *                       over IPC. The tsconfig `host-impl` path maps to it, and webpack
 *                       follows tsconfig paths.
 *   main/osint/impl.ts  Node, in-process parts only (platform, cli, extract). Used by
 *                       the Electron main process, and by vitest through its own
 *                       `host-impl` alias.
 */
import type { CaptureFiles, Manifest } from '../../main/osint/extension/protocol';

export interface PlatformInfo {
    /** NodeJS.Platform: 'darwin' | 'linux' | 'win32' | ... */
    readonly os: string;
    readonly homedir: string;
    readonly pathSep: string;
    readonly isFlatpak: boolean;
}

export interface ExecOptions {
    cwd?: string;
    stdin?: string;
    timeoutMs?: number;
    maxBuffer?: number;
    /** Allowlisted names only; main merges real process.env itself. */
    envOverrides?: Record<string, string>;
}

export interface ExecResult {
    stdout: string;
    stderr: string;
    /**
     * Node's ExecFileException.code verbatim: an errno string ('ENOENT') when the
     * spawn itself failed, or a numeric exit status when the process ran and failed.
     * Callers classify on 'ENOENT' to distinguish "CLI not installed" from "CLI
     * errored", so this must not be normalised to a number.
     */
    code: string | number | null;
    signal: string | null;
    killed: boolean;
    /** Present iff execFile reported an error. */
    errorMessage?: string;
}

/**
 * Where a secret lives. The renderer passes this reference; it never holds the
 * secret itself. Resolution and injection happen in main.
 */
export interface SecretRef {
    source: 'env' | 'vault-file';
    /** Env var name, or vault-relative credential path. */
    name: string;
}

export interface RequestAuth {
    placement: 'bearer' | 'header' | 'query';
    ref: SecretRef;
    /** For placement 'header'; defaults to X-API-Key. */
    headerName?: string;
    /** For placement 'query'; defaults to api_key. */
    queryParam?: string;
}

export interface HttpRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    contentType?: string;
    /** false => non-2xx resolves normally (wayback, enrichers rely on this). */
    throw?: boolean;
    /**
     * Resolved and injected in main, so the secret never crosses into the renderer.
     * This is what closes the "renderer holds enricher credentials" gap.
     */
    auth?: RequestAuth;
    /**
     * Host allowlist, re-enforced in main.
     *
     * The renderer checks this too, but once the renderer is the untrusted side that
     * check is a convenience, not a boundary -- and enricher URL templates are
     * LLM- and user-authored. Main additionally refuses private, loopback,
     * link-local and cloud-metadata addresses after DNS resolution.
     */
    allowedDomains?: string[];
}

export interface HttpResponse {
    status: number;
    /** Keys are lowercased: api-service reads headers['content-type']. */
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
    text: string;
}

export interface StatDto {
    path: string;
    type: 'file' | 'folder';
    ctime: number;
    mtime: number;
    size: number;
}

export type WatchEventKind = 'create' | 'modify' | 'delete' | 'rename';

export interface WatchEvent {
    kind: WatchEventKind;
    /** Always NFC-normalised in main before it is sent, so index keys always match. */
    path: string;
    oldPath?: string;
    stat?: StatDto;
}

export interface VaultHost {
    /** Opens a folder as the vault and returns its complete tree in one call. */
    open(dir: string): Promise<StatDto[]>;
    /** Absolute path of the open vault -- used as CLI cwd. */
    basePath(): string;
    read(path: string): Promise<string>;
    readBinary(path: string): Promise<Uint8Array>;
    /** Overwrites. Returns the authoritative post-write stat so the index cannot drift. */
    write(path: string, data: string): Promise<StatDto>;
    writeBinary(path: string, data: Uint8Array): Promise<StatDto>;
    /** Throws Error("File already exists.") when path exists -- vault-bootstrap-fs matches on it. */
    create(path: string, data: string): Promise<StatDto>;
    /**
     * Creates intermediate folders, but throws Error("Folder already exists.") when the
     * TARGET exists. Both halves are load-bearing; see the Phase 0 finding.
     */
    mkdir(path: string): Promise<StatDto>;
    remove(path: string): Promise<void>;
    /** Moves to the OS trash rather than unlinking (fileManager.trashFile). */
    trash(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    /** Batched events for out-of-band edits; echoes of this host's own writes are dropped. */
    onChange(callback: (events: WatchEvent[]) => void): () => void;
    /** Custom-protocol URL for displaying a vault file (images on graph nodes). */
    resourceUrl(path: string): string;
}

/** A PMTiles archive main holds open on the renderer's behalf. */
export interface BasemapArchive {
    /** Opaque capability. The only thing the renderer may name on a read. */
    handleId: string;
    /** Absolute and symlink-resolved. For display only; never sent back. */
    path: string;
    size: number;
    /** `${mtimeMs}-${size}` at open. Changes if the file is replaced. */
    etag: string;
}

export interface BasemapRange {
    /** Exactly sized and unpooled in main, so `new Uint8Array(data)` is the range. */
    data: ArrayBuffer;
    etag: string;
}

/** Why a configured archive could not be opened. Mapped to UI copy in the renderer. */
export type BasemapProblem =
    | 'not-configured'
    | 'missing'
    | 'not-a-file'
    | 'unreadable'
    | 'not-pmtiles'
    | 'unsupported-version';

export type BasemapOpenResult =
    | { ok: true; archive: BasemapArchive }
    | { ok: false; problem: BasemapProblem; path: string };

// ------------------------------------------------------------ browser-extension inbox

/**
 * A manifest as the extension sent it, after main validated and cleaned it. The wire
 * types live with the protocol in main; they do no I/O, so both sides share them.
 */
export type InboxManifest = Manifest;

/** What main stamped on a bundle when it arrived. Never supplied by the extension. */
export interface InboxServerStamp {
    /** ISO 8601, main's clock. */
    receivedAt: string;
    clientId: string;
    /** The extension's `chrome-extension://…` origin, as recorded at pairing. */
    origin: string;
    extVersion: string;
    /** A capture only: each stored file's size and sha256, computed by main at commit. */
    files?: CaptureFiles;
}

/** A file main derived from a capture, in the bundle's own folder. */
export interface InboxDerivedFile {
    /** A fixed name: 'page.markdown' or 'fullpage.png'. */
    file: string;
    sha256: string;
}

/**
 * `<bundle>/derived.json`: what main made from a capture's archive, off the main thread,
 * after the capture committed. MAC-verified by main before it is handed over.
 */
export interface InboxCaptureDerived {
    v: 1;
    bundleId: string;
    /** 'failed' when no markdown could be made; the archive itself is still good. */
    status: 'done' | 'failed';
    /**
     * sha256 of the page.mhtml these were derived from, re-hashed and matched against the
     * sealed digest just before deriving: a placement can tell the results belong to the
     * archive that is there.
     */
    archiveSha256: string;
    /** Inert markdown of the archived document: no embeds, no HTML. */
    markdown?: InboxDerivedFile;
    /** The whole page rendered from the archive, or why it could not be. */
    fullpage?: InboxDerivedFile | { error: string };
    /** The address recorded in the archive (Snapshot-Content-Location), or null. */
    contentLocation: string | null;
    /** True when the archive's address is not the page the extension named, or is unknown. */
    urlMismatch: boolean;
    /** The archived document's <title>, cleaned; may be empty. */
    title: string;
    errors: string[];
    /** ISO 8601, main's clock. */
    derivedAt: string;
}

/** One journal step the renderer recorded while applying a bundle. */
export interface InboxStepRecord {
    step: string;
    /** ISO 8601, main's clock at the last write of this step. */
    at: string;
    data: unknown;
}

/** `<bundle>/state.json`. Main owns the file; the renderer only appends through `step`. */
export interface InboxState {
    v: 1;
    steps: InboxStepRecord[];
}

/** A pending bundle whose MAC main has just re-verified. */
export interface InboxBundle {
    bundleId: string;
    manifest: InboxManifest;
    server: InboxServerStamp;
    state: InboxState | null;
    /** A capture only: listed once derivation has finished, never before. */
    derived?: InboxCaptureDerived;
}

/**
 * An applied bundle, still in done/ or moved to removed/ by Remove, with its journal: the
 * activity log is read from these.
 */
export interface InboxAppliedBundle extends InboxBundle {
    where: 'done' | 'removed';
}

export type InboxOutcome = 'done' | 'rejected';

/** What each placed file of a capture is. */
export type InboxPlacedRole = 'archive' | 'fullpage' | 'viewport' | 'pdf' | 'markdown';

/** One file of a capture, copied by main into `OSINTCopilot/Evidence/`. */
export interface InboxPlacedFile {
    role: InboxPlacedRole;
    /** Vault-relative, `OSINTCopilot/Evidence/<slug>-<sha8>[-n].<ext>`. Named by main only. */
    path: string;
    /** Of the placed bytes, as main hashed them. */
    sha256: string;
    /**
     * True when this capture's placement made the file. False when a file with the same
     * name and the same bytes was already there (an earlier capture of the identical
     * page), which belongs to whoever made it: Remove leaves it.
     */
    created: boolean;
}

/** placeFiles' answer: the capture's files in the investigation, archive first. */
export interface InboxPlacement {
    bundleId: string;
    files: InboxPlacedFile[];
}

/** One window applies a workspace's inbox at a time; the others are told no. */
export type InboxClaimResult = { ok: true } | { ok: false; reason: 'held' };

/** A paired extension, as the settings page shows it. Its key never leaves main. */
export interface ExtensionClientInfo {
    clientId: string;
    origin: string;
    extVersion: string;
    createdAt: string;
    lastSeenAt: string | null;
}

export interface ExtensionStatus {
    /** The user's switch, persisted. */
    enabled: boolean;
    /** Whether the loopback server is listening right now. */
    running: boolean;
    port: number | null;
    /** The licence carries the osint entitlement. */
    licensed: boolean;
    /** False when the OS keychain is unavailable and the keys sit in a 0600 plain file. */
    secretsEncrypted: boolean;
    clients: ExtensionClientInfo[];
    /** Set when the channel could not be set up at all, e.g. an unreadable key file. */
    problem?: string;
}

/** The one-time string the user pastes into the extension. */
export interface ExtensionPairing {
    pairingString: string;
    /** Unix ms. */
    expiresAt: number;
}

/**
 * The browser extension's inbox for the window's own investigation. No call names a
 * workspace: main answers for the calling window's, so a window can only ever apply,
 * journal or settle bundles in the investigation it has open.
 */
export interface InboxHost {
    /** One window per investigation applies its inbox; the others are told 'held'. */
    claim(): Promise<InboxClaimResult>;
    release(): Promise<void>;
    /** Pending bundles, each with its MAC re-verified by main. Lease holder only. */
    list(): Promise<InboxBundle[]>;
    /** Records (or merges into) one journal step. Re-recording a step is harmless. */
    step(bundleId: string, step: string, data: unknown): Promise<InboxState>;
    finish(bundleId: string, outcome: InboxOutcome): Promise<void>;
    /** The Remove action on an applied item: moves its bundle from done/ to removed/. */
    markRemoved(bundleId: string): Promise<void>;
    /**
     * Applied bundles (done and removed), newest 500, oldest first. Like markRemoved, any
     * window on the investigation may ask, not only the lease holder.
     */
    listApplied(): Promise<InboxAppliedBundle[]>;
    /**
     * Copies a pending, derived capture's files into `OSINTCopilot/Evidence/`, after main
     * re-verifies the manifest's and derived.json's MACs and every file's digest. The
     * bundle keeps its own copies. Idempotent: calling it again returns the same files,
     * with `created` still true for the ones this capture made. Lease holder only.
     */
    placeFiles(bundleId: string): Promise<InboxPlacement>;
    /** Fires when a bundle arrives or is settled. Returns an unsubscribe. */
    onChanged(callback: () => void): () => void;
}

/** The settings page's controls for the extension channel. No call returns a key. */
export interface ExtensionHost {
    status(): Promise<ExtensionStatus>;
    setEnabled(enabled: boolean): Promise<ExtensionStatus>;
    pairBegin(): Promise<ExtensionPairing>;
    pairCancel(): Promise<void>;
    revoke(clientId: string): Promise<boolean>;
}

export interface Host {
    /**
     * Synchronous because process.platform (7 sites) and os.homedir() never change
     * during a run. Delivering them as a snapshot is what keeps the candidate-path
     * builders synchronous and stops the sandbox conversion rippling through
     * resolve-binary-path's call graph.
     */
    readonly platform: PlatformInfo;

    cli: {
        resolve(configured: string | undefined, fallbackBareName: string, extraCandidates?: string[], probeTimeoutMs?: number): Promise<string>;
        /**
         * `execId` is supplied by the caller rather than returned, so an AbortSignal
         * handler can call kill() for a process whose exec promise has not settled.
         */
        exec(execId: string, binary: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
        kill(execId: string): void;
    };

    net: {
        request(request: HttpRequest): Promise<HttpResponse>;
    };

    extract: {
        pdfText(data: ArrayBuffer): Promise<string>;
        docxText(data: ArrayBuffer): Promise<string>;
    };

    vault: VaultHost;
    /**
     * Offline basemap archives. `open()` takes no path: main holds the only copy of it,
     * chosen through a dialog main itself opened, so a byte-range read cannot be aimed
     * at a file of the renderer's choosing.
     */
    basemap: {
        /** Native picker. Resolves null if the user cancelled. */
        pick(): Promise<BasemapOpenResult | null>;
        open(): Promise<BasemapOpenResult>;
        forget(): Promise<void>;
        read(handleId: string, offset: number, length: number): Promise<BasemapRange>;
    };

    inbox: InboxHost;
    extension: ExtensionHost;
}
