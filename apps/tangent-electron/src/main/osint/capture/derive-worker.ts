/**
 * The capture worker: an Electron utility process (its own webpack entry) that parses one
 * archive per message and posts the result back.
 *
 * Its own process so that 50 MB of hostile MHTML and a turndown pass over whatever HTML it
 * holds never block main's thread, and so that main can kill it outright when it takes too
 * long (utility-runner.ts). It is started fresh for each capture and does nothing else.
 *
 * No electron import: `process.parentPort` is how a utility process hears its parent.
 */
import { runParseJob, type ParseJob, type ParseOutcome } from './derive';

interface ParentPort {
    on(event: 'message', listener: (event: { data: unknown }) => void): void;
    postMessage(message: unknown): void;
}

function isJob(value: unknown): value is ParseJob {
    const v = value as ParseJob;
    return typeof v === 'object' && v !== null && typeof v.archivePath === 'string' && typeof v.pageUrl === 'string';
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (port) {
    port.on('message', event => {
        const outcome: ParseOutcome = isJob(event.data)
            ? runParseJob(event.data)
            : { ok: false, error: 'not a parse job' };
        port.postMessage(outcome);
    });
}
