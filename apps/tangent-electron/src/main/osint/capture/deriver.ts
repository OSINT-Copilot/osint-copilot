/**
 * After a capture commits, main derives what the renderer needs to place it: inert
 * markdown of the archived document, a full-page image rendered from the archive, and
 * derived.json saying what was made and what was found. One capture at a time.
 *
 * Parsing runs in a separate process (ParserRunner; utility-runner.ts in the app) with a
 * hard timeout, after which the process is killed and the failure recorded: 50 MB of
 * hostile MHTML must neither block main nor hang the queue. The render runs in main,
 * because it needs a BrowserWindow, and is bounded inside renderArchive.
 *
 * Failures are recorded in derived.json, never thrown: the archive is the evidence, and a
 * capture whose markdown or image could not be made is still a capture. The deriver
 * never touches the inbox itself; DeriveStore (InboxWriter) reads the bundle and writes
 * the results under its own lock.
 *
 * No electron import: the runner and the renderer are injected, so tests drive this with
 * an in-process parser and a fake renderer.
 */
import { runParseJob, type ParseJob, type ParseOutcome } from './derive';

export interface ParserProcess {
    result: Promise<ParseOutcome>;
    /** Stops the parse for good. Called at the timeout; harmless after it finished. */
    kill(): void;
}

export type ParserRunner = (job: ParseJob) => ParserProcess;

/** For tests and tools: parses on the caller's thread, and so cannot really be killed. */
export const inProcessRunner: ParserRunner = job => ({
    result: Promise.resolve().then(() => runParseJob(job)),
    kill: () => undefined,
});

export interface RenderResult {
    png?: Buffer;
    reason?: string;
}

/** A pending capture, as the store hands it to be derived. */
export interface DeriveTarget {
    archivePath: string;
    pageUrl: string;
    /** The archive's sha256, re-hashed and matched against the sealed one just now. */
    archiveSha256: string;
}

/** What the deriver made; the store hashes, seals and writes it. */
export interface DeriveResults {
    /** The archive these were derived from (DeriveTarget.archiveSha256). */
    archiveSha256: string;
    markdown?: string;
    fullpage?: Buffer;
    fullpageError?: string;
    contentLocation: string | null;
    urlMismatch: boolean;
    title: string;
    errors: string[];
}

export interface DeriveStore {
    /** The capture if it is still pending and not yet derived; else null. */
    deriveTarget(root: string, bundleId: string): Promise<DeriveTarget | null>;
    writeDerived(root: string, bundleId: string, results: DeriveResults): Promise<void>;
}

export interface CaptureDeriverDeps {
    store: DeriveStore;
    runParser: ParserRunner;
    /** renderArchive in the app. Absent: no full-page image, and derived.json says so. */
    renderArchive?: (archivePath: string) => Promise<RenderResult>;
    parseTimeoutMs?: number;
    /** renderArchive bounds itself; this is a backstop for a render that never returns. */
    renderTimeoutMs?: number;
    log?: { warn(...args: unknown[]): void };
}

export const PARSE_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 90_000;

type Timed<T> = { done: true; value: T } | { done: false };

function within<T>(promise: Promise<T>, ms: number): Promise<Timed<T>> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
        promise.then(value => ({ done: true as const, value })),
        new Promise<Timed<T>>(resolve => {
            timer = setTimeout(() => resolve({ done: false }), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

export class CaptureDeriver {
    private readonly queue: { root: string; bundleId: string }[] = [];
    private readonly queued = new Set<string>();
    private running: Promise<void> | null = null;

    constructor(private readonly deps: CaptureDeriverDeps) {}

    /** Queues a capture. A capture already queued or being derived is not queued twice. */
    enqueue(root: string, bundleId: string): void {
        const key = `${root}\n${bundleId}`;
        if (this.queued.has(key)) return;
        this.queued.add(key);
        this.queue.push({ root, bundleId });
        if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
    }

    /** Resolves once the queue is empty. */
    async idle(): Promise<void> {
        while (this.running) await this.running;
    }

    private async drain(): Promise<void> {
        for (let next = this.queue.shift(); next; next = this.queue.shift()) {
            try {
                await this.deriveOne(next.root, next.bundleId);
            } catch (err) {
                // The store could not read or write just now; the next listing queues it again.
                this.deps.log?.warn('[osint] deriving a capture failed:', err);
            } finally {
                this.queued.delete(`${next.root}\n${next.bundleId}`);
            }
        }
    }

    private async deriveOne(root: string, bundleId: string): Promise<void> {
        const target = await this.deps.store.deriveTarget(root, bundleId);
        if (!target) return;
        const results: DeriveResults = {
            archiveSha256: target.archiveSha256, contentLocation: null, urlMismatch: true, title: '', errors: [],
        };

        const parser = this.deps.runParser({ archivePath: target.archivePath, pageUrl: target.pageUrl });
        const timeout = this.deps.parseTimeoutMs ?? PARSE_TIMEOUT_MS;
        let parsed: Timed<ParseOutcome>;
        try {
            parsed = await within(parser.result, timeout);
        } catch (err) {
            parsed = { done: true, value: { ok: false, error: err instanceof Error ? err.message : String(err) } };
        } finally {
            parser.kill();
        }
        if (!parsed.done) {
            results.errors.push(`markdown: the parser did not finish within ${Math.round(timeout / 1000)}s and was stopped`);
        } else if (parsed.value.ok === false) {
            results.errors.push(`markdown: ${parsed.value.error}`);
        } else {
            const r = parsed.value.result;
            results.markdown = r.markdown;
            results.contentLocation = r.contentLocation;
            results.urlMismatch = r.urlMismatch;
            results.title = r.title;
            results.errors.push(...r.errors);
        }

        if (this.deps.renderArchive) {
            let rendered: Timed<RenderResult>;
            try {
                rendered = await within(this.deps.renderArchive(target.archivePath), this.deps.renderTimeoutMs ?? RENDER_TIMEOUT_MS);
            } catch (err) {
                rendered = { done: true, value: { reason: err instanceof Error ? err.message : String(err) } };
            }
            if (!rendered.done) results.fullpageError = 'the render did not finish in time';
            else if (rendered.value.png) results.fullpage = rendered.value.png;
            else results.fullpageError = rendered.value.reason ?? 'the render produced no image';
        } else {
            results.fullpageError = 'no renderer in this build';
        }

        await this.deps.store.writeDerived(root, bundleId, results);
    }
}
