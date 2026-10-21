// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [directory, outputName = 'SHA256SUMS.txt'] = process.argv.slice(2)

if (!directory || path.basename(outputName) !== outputName) {
	throw new Error('usage: node scripts/release-checksums.mjs <directory> [output-file]')
}

const files = (await readdir(directory, { withFileTypes: true }))
	.filter(entry => entry.isFile() && !entry.name.startsWith('SHA256SUMS'))
	.map(entry => entry.name)
	.sort()

if (files.length === 0) throw new Error(`${directory} contains no release artifacts`)

const lines = []
for (const file of files) {
	const bytes = await readFile(path.join(directory, file))
	const digest = createHash('sha256').update(bytes).digest('hex')
	lines.push(`${digest}  ${file}`)
}

await writeFile(path.join(directory, outputName), `${lines.join('\n')}\n`)
console.log(`Wrote ${outputName} for ${files.length} artifacts`)
