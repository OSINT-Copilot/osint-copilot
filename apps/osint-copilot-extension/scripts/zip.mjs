// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

// Builds the extension and packs dist/ into release/osint-copilot-extension-<version>.zip,
// the file the Chrome Web Store (and Edge Add-ons) take.
//
// The store build differs from dist/ in one way: the manifest has no "key". That key pins
// the development id so unpacked copies stay paired across rebuilds; a store assigns its
// own id, and refuses an upload that carries one. The app pins whichever id pairs with it,
// so a store copy pairs like any other.
//
// The zip is reproducible: entries in sorted order, each with the same fixed timestamp, so
// the same source built with the same Node version gives the same bytes and the same
// digest (another zlib may deflate differently). Written here with Node's zlib rather than
// a zip command, which Windows does not have.
//
// Nothing whose name begins with a dot goes in (.DS_Store, an editor's swap file): the
// package holds what the build made, and the files it must have are checked.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, '');
const dist = join(root, 'dist');

// 2026-01-01 00:00:00, in MS-DOS date and time fields.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
/** "Made by" Unix, spec 2.0: lets unzip restore ordinary file permissions. */
const MADE_BY = (3 << 8) | 20;
const FILE_MODE = 0o100644;
/** Bit 11: names are UTF-8. */
const UTF8 = 0x0800;

/** What a store package must hold: the manifest's entry points, and the licence files. */
export const REQUIRED = ['manifest.json', 'sw.js', 'content.js', 'sidepanel.html', 'sidepanel.js', 'LICENSE', 'NOTICE'];

async function files(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...await files(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

/** A zip of `entries` ({name, data}), deflated where that helps, stored where it does not. */
export function zip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const nameBytes = Buffer.from(name, 'utf8');
		const deflated = deflateRawSync(data, { level: 9 });
		const method = deflated.length < data.length ? 8 : 0;
		const body = method === 8 ? deflated : data;
		const crc = crc32(data);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(UTF8, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, nameBytes, body);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(MADE_BY, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(UTF8, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE((FILE_MODE << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);

		offset += local.length + nameBytes.length + body.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

/**
 * The package's entries from a build folder, in sorted order: the manifest without its
 * "key", everything else as built, dotfiles left out (and returned as `skipped`).
 */
export async function packEntries(dir) {
	const entries = [];
	const skipped = [];
	for (const path of (await files(dir)).sort()) {
		const name = relative(dir, path).split(sep).join('/');
		if (name.split('/').some((part) => part.startsWith('.'))) {
			skipped.push(name);
			continue;
		}
		let data = await readFile(path);
		if (name === 'manifest.json') {
			const manifest = JSON.parse(data.toString('utf8'));
			delete manifest.key;
			data = Buffer.from(JSON.stringify(manifest, null, '\t') + '\n');
		}
		if (name.endsWith('.map')) throw new Error(`${name}: a source map in the build; build without --watch`);
		entries.push({ name, data });
	}
	for (const required of REQUIRED) {
		if (!entries.some((e) => e.name === required)) throw new Error(`${required} is missing from the build`);
	}
	return { entries, skipped };
}

async function main() {
	const built = spawnSync(process.execPath, [join(root, 'build.mjs')], { stdio: 'inherit' });
	if (built.status !== 0) process.exit(built.status ?? 1);

	const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	const { entries, skipped } = await packEntries(dist);
	if (skipped.length > 0) console.log(`left out: ${skipped.join(', ')}`);

	const out = join(root, 'release', `osint-copilot-extension-${pkg.version}.zip`);
	await mkdir(dirname(out), { recursive: true });
	const bytes = zip(entries);
	await writeFile(out, bytes);
	const digest = createHash('sha256').update(bytes).digest('hex');
	console.log(`${relative(process.cwd(), out)}  ${entries.length} files, ${bytes.length} bytes\nsha256  ${digest}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
