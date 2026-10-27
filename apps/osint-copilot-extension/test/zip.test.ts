// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs build script, without type declarations.
import { REQUIRED, packEntries, zip } from '../scripts/zip.mjs';

type Entry = { name: string; data: Buffer };

/** Reads a zip back through its central directory, as an unzip tool would. */
function unzip(buf: Buffer): Array<{ name: string; data: Buffer; method: number; flags: number }> {
	const end = buf.length - 22;
	expect(buf.readUInt32LE(end)).toBe(0x06054b50);
	const count = buf.readUInt16LE(end + 10);
	let at = buf.readUInt32LE(end + 16);
	const out = [];
	for (let i = 0; i < count; i++) {
		expect(buf.readUInt32LE(at)).toBe(0x02014b50);
		const method = buf.readUInt16LE(at + 10);
		const flags = buf.readUInt16LE(at + 8);
		const crc = buf.readUInt32LE(at + 16);
		const csize = buf.readUInt32LE(at + 20);
		const usize = buf.readUInt32LE(at + 24);
		const nameLen = buf.readUInt16LE(at + 28);
		const local = buf.readUInt32LE(at + 42);
		const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
		expect(buf.readUInt32LE(local)).toBe(0x04034b50);
		const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
		const body = buf.subarray(start, start + csize);
		const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
		expect(data.length).toBe(usize);
		expect(crc32(data)).toBe(crc);
		out.push({ name, data, method, flags });
		at += 46 + nameLen;
	}
	return out;
}

describe('the store package zip', () => {
	const entries = [
		{ name: 'manifest.json', data: Buffer.from('{"manifest_version":3}\n'.repeat(20)) },
		{ name: 'icons/icon-16.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
		{ name: 'naïve.txt', data: Buffer.alloc(0) },
	];

	it('holds exactly the files it was given, byte for byte', () => {
		const back = unzip(zip(entries));
		expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
		for (const [i, e] of back.entries()) expect(e.data.equals(entries[i].data)).toBe(true);
	});

	it('deflates what shrinks, stores what does not, and marks names as UTF-8', () => {
		const back = unzip(zip(entries));
		expect(back[0].method).toBe(8);
		expect(back[1].method).toBe(0);
		for (const e of back) expect(e.flags & 0x0800).toBe(0x0800);
	});

	it('is the same bytes every time for the same input', () => {
		expect(zip(entries).equals(zip(entries))).toBe(true);
	});
});

describe('what goes into the store package', () => {
	const staticManifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../static/manifest.json'), 'utf8'));
	let dir: string;

	/** A build folder: the required files, the real manifest, and whatever else is given. */
	function build(extra: Record<string, string> = {}, leaveOut: string[] = []): string {
		dir = mkdtempSync(join(tmpdir(), 'oc-zip-'));
		const files: Record<string, string> = { ...Object.fromEntries(REQUIRED.map((n: string) => [n, `// ${n}`])), 'icons/icon-16.png': 'png', ...extra };
		files['manifest.json'] = JSON.stringify(staticManifest);
		for (const name of leaveOut) delete files[name];
		for (const [name, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, name)), { recursive: true });
			writeFileSync(join(dir, name), text);
		}
		return dir;
	}

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it('drops the development key from the manifest, and changes nothing else in it', async () => {
		expect(staticManifest.key).toBeTruthy();
		const { entries } = await packEntries(build());
		const manifest = JSON.parse((entries as Entry[]).find((e) => e.name === 'manifest.json')!.data.toString('utf8'));
		const { key: _key, ...rest } = staticManifest;
		expect(manifest).toEqual(rest);
	});

	it('holds the build\'s files in sorted order, and leaves out dotfiles', async () => {
		const { entries, skipped } = await packEntries(build({ '.DS_Store': 'x', 'icons/.icon-16.png.swp': 'x' }));
		const names = (entries as Entry[]).map((e) => e.name);
		expect(names).toEqual([...names].sort());
		expect(names).toEqual(expect.arrayContaining([...REQUIRED, 'icons/icon-16.png']));
		expect(names.some((n) => n.split('/').some((p) => p.startsWith('.')))).toBe(false);
		expect(skipped).toEqual(['.DS_Store', 'icons/.icon-16.png.swp']);
	});

	it('refuses a build missing a file the extension needs, or holding a source map', async () => {
		await expect(packEntries(build({}, ['content.js']))).rejects.toThrow('content.js is missing');
		rmSync(dir, { recursive: true, force: true });
		await expect(packEntries(build({ 'sw.js.map': '{}' }))).rejects.toThrow('source map');
	});
});

