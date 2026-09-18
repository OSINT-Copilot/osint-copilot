/**
 * Moving a capture's files from the socket to the staging folder, and checking them again
 * at commit.
 *
 * A file is streamed to `<name>.part`, created exclusively, hashing as it goes, and
 * renamed to `<name>` only when its length, digest and first bytes all match what was
 * declared. Anything else deletes the .part: a staging folder never holds a file under
 * its real name that was not checked.
 *
 * No electron import.
 */
import * as fsp from 'fs/promises';
import * as nodePath from 'path';
import { createHash } from 'crypto';
import * as fs from 'fs';
import type { CaptureFileName } from '../extension/protocol';
import { SNIFF_BYTES, sniffCaptureFile } from '../capture/sniff';

export type ReceiveResult =
    | { ok: true }
    | { ok: false; error: 'too_large' | 'hash_mismatch' | 'invalid'; detail?: string };

export const PART_SUFFIX = '.part';

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

/**
 * Streams `body` into `dir/<name>`. Reads at most `size` bytes past which it stops and
 * reports an overrun; a body that ends short is an error too. Throws only for I/O
 * failures (and a body that errors, such as a closed socket), after deleting the .part.
 */
export async function receiveToFile(
    dir: string,
    name: CaptureFileName,
    body: AsyncIterable<Buffer>,
    expected: { size: number; sha256: string },
): Promise<ReceiveResult> {
    const part = nodePath.join(dir, name + PART_SUFFIX);
    const final = nodePath.join(dir, name);
    // A .part is only ever left by a write that died; the caller holds this name's lock.
    await fsp.rm(part, { force: true });
    const handle = await fsp.open(part, 'wx', 0o600);
    let closed = false;
    const discard = async (): Promise<void> => {
        if (!closed) {
            closed = true;
            await handle.close().catch(() => undefined);
        }
        await fsp.rm(part, { force: true }).catch(() => undefined);
    };
    try {
        const hash = createHash('sha256');
        const head: Buffer[] = [];
        let headBytes = 0;
        let received = 0;
        for await (const chunk of body) {
            received += chunk.length;
            if (received > expected.size) {
                await discard();
                return { ok: false, error: 'too_large' };
            }
            hash.update(chunk);
            if (headBytes < SNIFF_BYTES) {
                head.push(chunk);
                headBytes += chunk.length;
            }
            await handle.write(chunk);
        }
        if (received !== expected.size) {
            await discard();
            return { ok: false, error: 'invalid', detail: `${name}: the body ended after ${received} of ${expected.size} bytes` };
        }
        if (hash.digest('hex') !== expected.sha256) {
            await discard();
            return { ok: false, error: 'hash_mismatch' };
        }
        if (!sniffCaptureFile(name, Buffer.concat(head))) {
            await discard();
            return { ok: false, error: 'invalid', detail: `${name}: the content is not what the name says` };
        }
        await handle.sync();
        closed = true;
        await handle.close();
        await fsp.rename(part, final);
        await syncDir(dir);
        return { ok: true };
    } catch (err) {
        await discard();
        throw err;
    }
}

/** Streams a file through sha256, not following a symlink at its name. */
export async function hashFile(p: string): Promise<{ size: number; sha256: string }> {
    const handle = await fsp.open(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new Error(`${nodePath.basename(p)} is not a file`);
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
            size += (chunk as Buffer).length;
            hash.update(chunk as Buffer);
        }
        return { size, sha256: hash.digest('hex') };
    } finally {
        await handle.close();
    }
}
