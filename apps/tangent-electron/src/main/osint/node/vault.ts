/**
 * Vault filesystem -- Node side.
 *
 * Every path is confined to the open vault root: the renderer is untrusted, and
 * entity.properties.filePath is LLM-writable, so confinement cannot be enforced on
 * that side. Paths are NFC-normalised on the way out because macOS APFS returns NFD
 * from readdir; an NFD path would miss the renderer's composed index key and send
 * entity-manager down its `create` branch for a file that already exists.
 *
 * There is no "current" vault. Each open vault is an OpenVault, and main keeps one per
 * window (keyed by webContents id, see openForSender). A single module-level root used
 * to be shared by every window, so with two windows on two vaults every write landed in
 * whichever vault was opened last -- including one window's entity notes, written into
 * the other's case.
 */
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { StatDto } from '../../../osint/host/types';

/**
 * The browser extension's inbox, at a workspace root. Main alone writes there: a bundle in
 * it carries extension provenance, and its state.json records what was applied. None of
 * the vault channels may reach it, so the renderer can neither forge a bundle nor edit
 * the journal through them. Matched case-insensitively and without trailing dots and
 * spaces, which Windows and macOS map onto the same folder, and without an NTFS stream
 * suffix.
 */
export const INBOX_FOLDER = '.osint-inbox';

function isInboxName(name: string): boolean {
    return name.split(':')[0].replace(/[. ]+$/, '').toLowerCase() === INBOX_FOLDER;
}

/**
 * `target` is an inbox folder or inside one, at any depth below `base`. Any depth, not just
 * the top: a vault opened on /cases reaches the inbox of a workspace nested at /cases/acme.
 * Both absolute, target inside base.
 */
function isUnderInbox(base: string, target: string): boolean {
    const rel = nodePath.relative(base, target);
    if (rel === '') return false;
    return rel.split(/[\\/]/).some(isInboxName);
}

/** `child` is `base` or somewhere beneath it. Both must be absolute. */
function isInside(base: string, child: string): boolean {
    const rel = nodePath.relative(base, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(rel));
}

/**
 * The real location `absolute` would touch: the realpath of its deepest existing
 * ancestor (or of itself). Components below that do not exist yet, so they cannot be
 * symlinks, and nodePath.resolve has already removed any `..` among them.
 *
 * Returns null for an entry that exists but cannot be realpathed -- a dangling symlink.
 * Walking past it to its parent would pass the check while writeFile followed the link
 * to wherever it points, so that case is refused rather than guessed at.
 */
function realpathOfDeepestExisting(absolute: string): string | null {
    let current = absolute;
    for (;;) {
        let exists = true;
        try {
            fs.lstatSync(current);
        } catch {
            exists = false;
        }
        if (exists) {
            try {
                return fs.realpathSync.native(current);
            } catch {
                return null;
            }
        }
        const parent = nodePath.dirname(current);
        if (parent === current) return current;
        current = parent;
    }
}

/**
 * Lists everything under `dir`, agreeing with resolve() on what is in the vault. lstat,
 * not stat: stat follows a symlink, so a link to a file outside the root was listed with
 * the outside file's size and mtime while every read of it was refused. A symlink is
 * listed (with its target's stat) only when its target is inside `realRoot`; one that
 * escapes, or dangles, is omitted. Symlinked folders are listed but not descended into,
 * which also keeps a link cycle from recursing forever.
 */
async function walk(dir: string, realRoot: string, out: StatDto[], toStat: (absolute: string, stats: fs.Stats) => StatDto): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const absolute = nodePath.join(dir, entry.name);
        // .git and node_modules would balloon the index for no benefit; Obsidian's own
        // config folder is likewise not part of the OSINT data model.
        if (entry.isDirectory() && (entry.name === '.git' || entry.name === 'node_modules')) continue;
        // Listed, an inbox (this workspace's, or a nested one's) would be files the shim
        // can see and never read.
        if (isInboxName(entry.name)) continue;
        let stats: fs.Stats;
        try {
            stats = await fsp.lstat(absolute);
            if (stats.isSymbolicLink()) {
                // The realpath flavour resolve() and realRoot use, so all three agree.
                if (!isInside(realRoot, fs.realpathSync.native(absolute))) continue;
                stats = await fsp.stat(absolute);
                out.push(toStat(absolute, stats));
                continue;
            }
            out.push(toStat(absolute, stats));
        } catch {
            continue; // dangling symlink, permission denied -- skip rather than abort the scan
        }
        if (stats.isDirectory()) await walk(absolute, realRoot, out, toStat);
    }
}

/** One opened vault. Every operation resolves against this vault's root and no other. */
export class OpenVault {
    private constructor(
        /** Absolute path as opened; vault paths are reported relative to this. */
        readonly root: string,
        /** The root with symlinks resolved, which is what confinement is checked against. */
        readonly realRoot: string,
    ) {}

    static async open(dir: string): Promise<{ vault: OpenVault; snapshot: StatDto[] }> {
        const root = nodePath.resolve(dir);
        await fsp.mkdir(root, { recursive: true });
        // The same realpath flavour resolve() uses, so the two sides compare in one form.
        const vault = new OpenVault(root, fs.realpathSync.native(root));

        const snapshot: StatDto[] = [];
        await walk(root, vault.realRoot, snapshot, (absolute, stats) => vault.toStat(absolute, stats));
        return { vault, snapshot };
    }

    /**
     * Resolves a vault-relative path to absolute, refusing anything that escapes the root
     * -- lexically (`..`), and through a symlink inside the vault that points out of it.
     * The lexical check alone let `link -> /etc` turn `link/passwd` into a read outside
     * the vault, and page text from the browser extension ends up in these paths.
     *
     * The inbox folder is refused the same two ways: by name, and by where a symlink
     * inside the vault really leads.
     */
    private resolve(vaultPath: string): string {
        const normalized = vaultPath === '/' ? '' : vaultPath.replace(/^\/+/, '');
        const absolute = nodePath.resolve(this.root, normalized);
        if (!isInside(this.root, absolute)) {
            throw new Error(`Path escapes the vault root: ${vaultPath}`);
        }
        const real = realpathOfDeepestExisting(absolute);
        if (real === null || !isInside(this.realRoot, real)) {
            throw new Error(`Path escapes the vault root: ${vaultPath}`);
        }
        if (isUnderInbox(this.root, absolute) || isUnderInbox(this.realRoot, real)) {
            throw new Error(`The browser extension's inbox is managed by the app: ${vaultPath}`);
        }
        return absolute;
    }

    /**
     * resolve() for operations that act on the entry itself rather than through it:
     * fs.rm, fs.rename and shell.trashItem all remove or move a symlink, never its target.
     * So only the parent must really be inside the vault; the final component may be a
     * symlink pointing anywhere, or nowhere. resolve() would refuse such a link, leaving
     * a dangling or outward-pointing link in the vault that nothing could delete.
     *
     * The root itself is refused outright. Every caller removes, moves or trashes what it
     * is given, and none has a reason to do that to the whole workspace -- while "/", ""
     * and "x/.." all resolve to it, so one bad path from a renderer flow would otherwise
     * delete the investigation.
     */
    private resolveEntry(vaultPath: string): string {
        const normalized = vaultPath === '/' ? '' : vaultPath.replace(/^\/+/, '');
        const absolute = nodePath.resolve(this.root, normalized);
        if (absolute === this.root) {
            throw new Error(`Refusing to remove, move or trash the vault root: ${vaultPath}`);
        }
        if (!isInside(this.root, absolute)) {
            throw new Error(`Path escapes the vault root: ${vaultPath}`);
        }
        const realParent = realpathOfDeepestExisting(nodePath.dirname(absolute));
        if (realParent === null || !isInside(this.realRoot, realParent)) {
            throw new Error(`Path escapes the vault root: ${vaultPath}`);
        }
        if (isUnderInbox(this.root, absolute)
            || isUnderInbox(this.realRoot, nodePath.join(realParent, nodePath.basename(absolute)))) {
            throw new Error(`The browser extension's inbox is managed by the app: ${vaultPath}`);
        }
        return absolute;
    }

    private toVaultPath(absolute: string): string {
        const rel = nodePath.relative(this.root, absolute).split(nodePath.sep).join('/');
        return (rel === '' ? '/' : rel).normalize('NFC');
    }

    private toStat(absolute: string, stats: fs.Stats): StatDto {
        return {
            path: this.toVaultPath(absolute),
            type: stats.isDirectory() ? 'folder' : 'file',
            ctime: stats.birthtimeMs || stats.ctimeMs,
            mtime: stats.mtimeMs,
            size: stats.size,
        };
    }

    async read(path: string): Promise<string> {
        return fsp.readFile(this.resolve(path), 'utf-8');
    }

    async readBinary(path: string): Promise<Uint8Array> {
        return new Uint8Array(await fsp.readFile(this.resolve(path)));
    }

    private async statOf(absolute: string): Promise<StatDto> {
        return this.toStat(absolute, await fsp.stat(absolute));
    }

    async write(path: string, data: string): Promise<StatDto> {
        const absolute = this.resolve(path);
        await fsp.mkdir(nodePath.dirname(absolute), { recursive: true });
        await fsp.writeFile(absolute, data, 'utf-8');
        return this.statOf(absolute);
    }

    async writeBinary(path: string, data: Uint8Array): Promise<StatDto> {
        const absolute = this.resolve(path);
        await fsp.mkdir(nodePath.dirname(absolute), { recursive: true });
        await fsp.writeFile(absolute, data);
        return this.statOf(absolute);
    }

    async create(path: string, data: string): Promise<StatDto> {
        const absolute = this.resolve(path);
        if (fs.existsSync(absolute)) throw new Error('File already exists.');
        await fsp.mkdir(nodePath.dirname(absolute), { recursive: true });
        await fsp.writeFile(absolute, data, 'utf-8');
        return this.statOf(absolute);
    }

    async mkdir(path: string): Promise<StatDto> {
        const absolute = this.resolve(path);
        if (fs.existsSync(absolute)) throw new Error('Folder already exists.');
        await fsp.mkdir(absolute, { recursive: true });
        return this.statOf(absolute);
    }

    async remove(path: string): Promise<void> {
        await fsp.rm(this.resolveEntry(path), { recursive: true, force: true });
    }

    async rename(from: string, to: string): Promise<void> {
        // Both sides are validated before anything touches the disk: creating the
        // destination's folder first left an empty directory behind a refused rename.
        const source = this.resolveEntry(from);
        const target = this.resolveEntry(to);
        await fsp.mkdir(nodePath.dirname(target), { recursive: true });
        await fsp.rename(source, target);
    }

    /**
     * Absolute path, for the trash implementation in main (needs Electron's shell).
     * Checked like remove(): trashItem moves a symlink, not what it points at.
     */
    absolutePathOf(path: string): string {
        return this.resolveEntry(path);
    }
}

// ------------------------------------------------------------------ per window

/** The part of Electron's WebContents this module needs; tests pass a stand-in. */
export interface VaultSender {
    readonly id: number;
    isDestroyed(): boolean;
    once(event: 'destroyed', listener: () => void): unknown;
}

const bySender = new Map<number, OpenVault>();
/** Senders we already hooked 'destroyed' on, so reopening does not stack listeners. */
const hookedSenders = new Set<number>();

/**
 * Opens `dir` as `sender`'s vault, replacing any vault it had open before. The entry
 * is dropped when the webContents is destroyed, so a closed window's root cannot be
 * picked up by anything later.
 */
export async function openForSender(sender: VaultSender, dir: string): Promise<StatDto[]> {
    const { vault, snapshot } = await OpenVault.open(dir);
    // The window may have closed while we walked the tree; its 'destroyed' has then
    // already fired and would never drop an entry added now.
    if (sender.isDestroyed()) throw new Error('The window closed before its vault opened');
    const id = sender.id;
    if (!hookedSenders.has(id)) {
        hookedSenders.add(id);
        sender.once('destroyed', () => {
            hookedSenders.delete(id);
            bySender.delete(id);
        });
    }
    bySender.set(id, vault);
    return snapshot;
}

/** The sender's own vault, or null. Never another window's. */
export function findVaultForSender(senderId: number): OpenVault | null {
    return bySender.get(senderId) ?? null;
}

/** The sender's own vault; throws the same error the single-root version did. */
export function vaultForSender(senderId: number): OpenVault {
    const vault = bySender.get(senderId);
    if (!vault) throw new Error('No vault is open');
    return vault;
}
