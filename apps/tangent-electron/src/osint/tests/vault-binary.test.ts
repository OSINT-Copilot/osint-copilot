import { describe, it, expect } from 'vitest';
import { createTestAppAsync } from '../obsidian-shim/testing/create-test-app';
import { TFile } from '../obsidian-shim/vault/tfile';

/** A PNG header plus bytes that are illegal or lossy in UTF-8 if treated as text. */
function pngBytes(): Uint8Array {
    return new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,   // PNG magic
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x80, 0x81, 0xfe, 0xff, 0xc0, 0xaf, 0xed, 0xa0,   // lone continuation / surrogate bytes
        0x00, 0xff, 0x7f, 0x80,
    ]);
}

describe('binary vault writes', () => {
    it('round-trips bytes through createBinary without corrupting them', async () => {
        // These bytes are not valid UTF-8. The old path latin1-decoded them into a string
        // and handed that to a text write, so the UTF-8 encoder on the other side replaced
        // everything above 0x7f -- corrupting every image and PDF written through it.
        const app = await createTestAppAsync();
        const source = pngBytes();

        await app.vault.createBinary('Assets/thumb.png', source.buffer as ArrayBuffer);
        const file = app.vault.getAbstractFileByPath('Assets/thumb.png');
        expect(file).toBeInstanceOf(TFile);

        const read = new Uint8Array(await app.vault.readBinary(file as TFile));
        expect([...read]).toEqual([...source]);
    });

    it('does not truncate the file it just wrote', async () => {
        // createBinary used to follow the binary write with storage.write(path, '') purely
        // to obtain a stat, so every dropped image landed as zero bytes.
        const app = await createTestAppAsync();
        const source = pngBytes();
        const created = await app.vault.createBinary('Assets/thumb.png', source.buffer as ArrayBuffer);

        expect(created.stat.size).toBe(source.length);
        const read = new Uint8Array(await app.vault.readBinary(created));
        expect(read.length).toBe(source.length);
        // Still a real PNG header, not an empty file.
        expect([...read.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    it('overwrites through adapter.writeBinary and leaves no stale text cache', async () => {
        const app = await createTestAppAsync({ files: { 'Assets/thumb.png': 'old text content' } });
        const file = app.vault.getAbstractFileByPath('Assets/thumb.png') as TFile;
        // Populate the read-through cache with the old text.
        await app.vault.cachedRead(file);

        const source = pngBytes();
        await app.vault.adapter.writeBinary('Assets/thumb.png', source.buffer as ArrayBuffer);

        const read = new Uint8Array(await app.vault.readBinary(
            app.vault.getAbstractFileByPath('Assets/thumb.png') as TFile));
        expect([...read]).toEqual([...source]);
        // A stale cache entry would serve the old text back to the next reader.
        expect(await app.vault.adapter.read('Assets/thumb.png')).not.toBe('old text content');
    });

    it('refuses to create over an existing file, as before', async () => {
        const app = await createTestAppAsync({ files: { 'Assets/thumb.png': 'x' } });
        await expect(app.vault.createBinary('Assets/thumb.png', new Uint8Array([1, 2]).buffer as ArrayBuffer))
            .rejects.toThrow(/already exists/i);
    });
});

describe('binary writes and the index', () => {
    it('makes a newly written asset findable', async () => {
        // adapter.writeBinary went straight to the backend without upserting, so a
        // thumbnail written this way existed on disk but not in the index -- invisible to
        // getAbstractFileByPath, getFiles, and therefore to every card that referenced it.
        const app = await createTestAppAsync();
        await app.vault.adapter.writeBinary('Assets/new.png', pngBytes().buffer as ArrayBuffer);

        const file = app.vault.getAbstractFileByPath('Assets/new.png');
        expect(file).toBeInstanceOf(TFile);
        expect(app.vault.getFiles().map((f) => f.path)).toContain('Assets/new.png');
        expect((file as TFile).stat.size).toBe(pngBytes().length);
    });

    it('keeps the index in step when overwriting', async () => {
        const app = await createTestAppAsync();
        await app.vault.adapter.writeBinary('Assets/x.png', new Uint8Array([1, 2, 3]).buffer as ArrayBuffer);
        await app.vault.adapter.writeBinary('Assets/x.png', pngBytes().buffer as ArrayBuffer);

        const file = app.vault.getAbstractFileByPath('Assets/x.png') as TFile;
        expect(file.stat.size).toBe(pngBytes().length);
        expect(app.vault.getFiles().filter((f) => f.path === 'Assets/x.png')).toHaveLength(1);
    });
});
