/**
 * Copying a capture's files out of its bundle into the investigation, where the analyst
 * and the assistant can read them: `OSINTCopilot/Evidence/<slug>-<sha8>.<ext>`.
 *
 * Copies, never moves: the bundle's own files stay under its MAC until the bundle is
 * finished, so a placement that dies half way can simply run again from the same signed
 * source. Every file is first streamed from the bundle into a temporary file beside it
 * and hashed on the way; only once all of them are their sealed digests is any linked
 * into Evidence/ under its final name, so a file that fails its digest leaves nothing
 * placed. link() is an exclusive create that cannot follow a symlink at the name, and
 * never leaves a half-written file under a real name.
 *
 * The Evidence folder is resolved one component at a time and must really be inside the
 * workspace: a symlink planted at OSINTCopilot or OSINTCopilot/Evidence that points
 * elsewhere would otherwise carry every capture out of the investigation. A symlink that
 * stays inside is followed, as the vault itself would.
 *
 * Names come from the app only (evidenceStem): `[a-z0-9-]`, the archive's hash, a fixed
 * extension. When the name is taken by the same bytes the file is reused (the same page
 * captured twice is the same evidence); by other bytes, a suffixed name is chosen.
 *
 * No electron import.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as nodePath from 'path';
import { createHash, randomBytes } from 'crypto';
import { hashFile } from './capture-files';
import type { InboxPlacedRole } from '../../../osint/host/types';
import { OSINT_COPILOT_VAULT_ROOT } from '../../../osint/constants/vault-layout';

/** Vault-relative, as the renderer names it. The segments, for resolving on disk. */
export const EVIDENCE_SEGMENTS = [OSINT_COPILOT_VAULT_ROOT, 'Evidence'] as const;
export const EVIDENCE_FOLDER = EVIDENCE_SEGMENTS.join('/');

/** The extension each role is placed under. */
export const PLACED_EXTENSIONS: Record<InboxPlacedRole, string> = {
    archive: '.mhtml',
    fullpage: '.png',
    viewport: '.viewport.png',
    pdf: '.pdf',
    markdown: '.md',
};

/** A name taken by other bytes this many times over is not worth hunting past. */
const MAX_SUFFIX = 50;
const TEMP_PREFIX = '.place-';
const TEMP_SUFFIX = '.tmp';
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

export class PlacementError extends Error {}
/** The bundle's file is not the bytes its digest was sealed for. */
export class DigestMismatchError extends PlacementError {}

function isStrictlyInside(parent: string, child: string): boolean {
    const rel = nodePath.relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

async function syncDir(dir: string): Promise<void> {
    try {
        const handle = await fsp.open(dir, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // Windows cannot open a directory; NTFS journals the link itself.
    }
}

/**
 * The real path of `<root>/OSINTCopilot/Evidence`, creating what is missing. Each
 * component is created only inside a folder already shown to be in the workspace, so not
 * even an empty folder is made outside it. `forbidden` (the inbox) may not be it or hold it.
 */
export async function evidenceDir(root: string, forbidden: string): Promise<string> {
    const realRoot = await fsp.realpath(root);
    let current = realRoot;
    for (const segment of EVIDENCE_SEGMENTS) {
        const next = nodePath.join(current, segment);
        try {
            await fsp.mkdir(next);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
        let real: string;
        try {
            real = await fsp.realpath(next);
        } catch {
            throw new PlacementError(`${nodePath.relative(realRoot, next)} cannot be resolved`);
        }
        if (!isStrictlyInside(realRoot, real)) {
            throw new PlacementError(`${EVIDENCE_FOLDER} is not a folder inside the investigation`);
        }
        current = real;
    }
    const realForbidden = await fsp.realpath(forbidden).catch(() => forbidden);
    if (current === realForbidden || isStrictlyInside(realForbidden, current)) {
        throw new PlacementError(`${EVIDENCE_FOLDER} points into the inbox`);
    }
    if (!(await fsp.stat(current)).isDirectory()) throw new PlacementError(`${EVIDENCE_FOLDER} is not a folder`);
    return current;
}

/** Removes temporary files an earlier placement left in the bundle folder when it died. */
export async function sweepPlacementTemps(dir: string): Promise<void> {
    for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
        if (name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX)) {
            await fsp.rm(nodePath.join(dir, name), { force: true }).catch(() => undefined);
        }
    }
}

/**
 * Streams `source` (not following a symlink at its name) to a new file in `tempDir`,
 * hashing on the way. Throws, leaving nothing, unless the bytes are `sha256`. The caller
 * removes the copy once it is placed.
 */
export async function copyVerified(source: string, tempDir: string, sha256: string): Promise<string> {
    const temp = nodePath.join(tempDir, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
    const input = await fsp.open(source, READ_FLAGS);
    try {
        if (!(await input.stat()).isFile()) throw new PlacementError(`${nodePath.basename(source)} is not a file`);
        const output = await fsp.open(temp, 'wx', 0o600);
        let ok = false;
        try {
            const hash = createHash('sha256');
            for await (const chunk of input.createReadStream({ autoClose: false })) {
                hash.update(chunk as Buffer);
                await output.write(chunk as Buffer);
            }
            if (hash.digest('hex') !== sha256) {
                throw new DigestMismatchError(`${nodePath.basename(source)} no longer matches its sealed digest`);
            }
            await output.sync();
            ok = true;
        } finally {
            await output.close();
            if (!ok) await fsp.rm(temp, { force: true }).catch(() => undefined);
        }
    } finally {
        await input.close();
    }
    return temp;
}

/**
 * `temp` under `dest`, exclusively. link() where the filesystem has hard links; where it
 * has not (FAT, some network shares) or Evidence is another device, an exclusive copy.
 */
async function linkExclusive(temp: string, dest: string): Promise<void> {
    try {
        await fsp.link(temp, dest);
        return;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EOPNOTSUPP') throw err;
    }
    try {
        await fsp.copyFile(temp, dest, fs.constants.COPYFILE_EXCL);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') await fsp.rm(dest, { force: true }).catch(() => undefined);
        throw err;
    }
}

export interface PlaceRequest {
    /** A private copy already checked against `sha256` (copyVerified): what is linked. */
    temp: string;
    /** Its sealed digest (manifest or derived.json). */
    sha256: string;
    ext: string;
}

export interface PlaceContext {
    /** Real path of the Evidence folder (evidenceDir). */
    dir: string;
    stem: string;
    /** Names this bundle recorded, before creating them, as its own; with their digests. */
    owned: Readonly<Record<string, string>>;
    /** Records `name` as this bundle's, durably, before it is created. */
    claim(name: string, sha256: string): Promise<void>;
    /** Takes back a claim for a name this bundle did not, after all, create. */
    unclaim(name: string): Promise<void>;
}

export interface PlacedOne {
    name: string;
    /**
     * Whether this bundle made the file: true when it was created now, or when an earlier
     * run of this bundle's placement recorded the name as its own and the same bytes are
     * there (it created it, then died before answering).
     */
    created: boolean;
    /** Created by this very call, so a placement failing later can take it back. */
    linkedNow: boolean;
}

/**
 * Places one file whose bytes were already verified. Never writes over or through
 * anything at a name: the same bytes there are reused, anything else is passed over for
 * a suffixed name.
 */
export async function placeOne(ctx: PlaceContext, req: PlaceRequest): Promise<PlacedOne> {
    let suffix = 1;
    // Bounded twice over: a name that keeps appearing between look and link is a race
    // with something that will not stop, not one to wait out.
    for (let tries = 0; suffix <= MAX_SUFFIX && tries < MAX_SUFFIX * 2; tries++) {
        const name = suffix === 1 ? `${ctx.stem}${req.ext}` : `${ctx.stem}-${suffix}${req.ext}`;
        const dest = nodePath.join(ctx.dir, name);
        const present = await fsp.lstat(dest).catch(() => null);
        if (present) {
            if (present.isFile()) {
                const got = await hashFile(dest).catch(() => null);
                if (got?.sha256 === req.sha256) return { name, created: ctx.owned[name] === req.sha256, linkedNow: false };
            }
            // Other bytes, a folder, or a symlink: never ours to write through or over.
            suffix++;
            continue;
        }
        // Recorded first, so a crash between the link and the journal still knows.
        await ctx.claim(name, req.sha256);
        try {
            await linkExclusive(req.temp, dest);
        } catch (err) {
            // Whatever is there now was not made by this bundle: the claim goes, or a
            // later look would find those bytes and call them ours. Then look again.
            await ctx.unclaim(name);
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw err;
        }
        await syncDir(ctx.dir);
        return { name, created: true, linkedNow: true };
    }
    throw new PlacementError(`no free name for ${ctx.stem}${req.ext}`);
}

/**
 * Takes back the files one placement created before it failed, so a capture that is not
 * placed leaves nothing in Evidence/ that no activity item owns and Remove cannot reach.
 */
export async function unplace(ctx: PlaceContext, names: readonly string[]): Promise<void> {
    for (const name of names) {
        await fsp.rm(nodePath.join(ctx.dir, name), { force: true });
        await ctx.unclaim(name);
    }
    if (names.length > 0) await syncDir(ctx.dir);
}
