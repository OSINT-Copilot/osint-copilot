// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

// Bundles the service worker and the side panel into dist/ and copies static/ beside
// them. `node build.mjs --watch` rebuilds on change; reload the extension afterwards.
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

async function copyStatic() {
	await cp(join(root, 'static'), dist, { recursive: true });
	// One version number: the manifest's comes from package.json, so the extVersion the
	// app shows in its pairing dialog is the one that was built.
	const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
	manifest.version = pkg.version;
	await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyStatic();

const options = {
	entryPoints: { sw: join(root, 'src/sw/index.ts'), sidepanel: join(root, 'src/sidepanel/index.ts') },
	outdir: dist,
	bundle: true,
	// The worker is registered with "type": "module"; the panel loads as <script type="module">.
	format: 'esm',
	target: 'chrome140',
	sourcemap: watch ? 'inline' : false,
	legalComments: 'none',
	logLevel: 'info',
	plugins: [{ name: 'static', setup(build) { build.onEnd(() => copyStatic()); } }],
};

if (watch) {
	await (await esbuild.context(options)).watch();
} else {
	await esbuild.build(options);
}
