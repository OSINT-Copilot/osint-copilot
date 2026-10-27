/**
 * Test helper: a ParserRunner that parses on the caller's thread, and so cannot really be
 * killed. The app always runs the parser in a utility process (utility-runner.ts).
 */
import { runParseJob } from './derive';
import type { ParserRunner } from './deriver';

export const inProcessRunner: ParserRunner = job => ({
    result: Promise.resolve().then(() => runParseJob(job)),
    kill: () => undefined,
});
