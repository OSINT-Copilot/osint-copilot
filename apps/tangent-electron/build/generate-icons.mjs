// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC
//
// Regenerate every desktop and browser-extension icon from build/icon.svg.  The ICO and
// ICNS writers embed PNG payloads, which modern Windows, macOS and electron-builder read
// directly.  Keeping this script in the repository makes the original OSINT Copilot mark
// reproducible without proprietary design tools.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const buildDir = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.dirname(buildDir)
const repoRoot = path.resolve(appDir, '../..')
const source = path.join(buildDir, 'icon.svg')
const strippedSource = path.join(buildDir, 'icon-stripped.svg')

async function render(svgPath, size) {
	const image = await loadImage(await fs.readFile(svgPath))
	const canvas = createCanvas(size, size)
	const context = canvas.getContext('2d')
	context.imageSmoothingEnabled = true
	context.imageSmoothingQuality = 'high'
	context.clearRect(0, 0, size, size)
	context.drawImage(image, 0, 0, size, size)
	return canvas.toBuffer('image/png')
}

async function write(file, data) {
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, data)
}

function ico(images) {
	const count = images.length
	const header = Buffer.alloc(6 + count * 16)
	header.writeUInt16LE(0, 0)
	header.writeUInt16LE(1, 2)
	header.writeUInt16LE(count, 4)
	let offset = header.length
	images.forEach(({ size, png }, index) => {
		const at = 6 + index * 16
		header[at] = size >= 256 ? 0 : size
		header[at + 1] = size >= 256 ? 0 : size
		header[at + 2] = 0
		header[at + 3] = 0
		header.writeUInt16LE(1, at + 4)
		header.writeUInt16LE(32, at + 6)
		header.writeUInt32LE(png.length, at + 8)
		header.writeUInt32LE(offset, at + 12)
		offset += png.length
	})
	return Buffer.concat([header, ...images.map(({ png }) => png)])
}

function icns(images) {
	const types = new Map([
		[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'],
		[256, 'ic08'], [512, 'ic09'], [1024, 'ic10'],
	])
	const chunks = images.map(({ size, png }) => {
		const chunk = Buffer.alloc(8 + png.length)
		chunk.write(types.get(size), 0, 4, 'ascii')
		chunk.writeUInt32BE(chunk.length, 4)
		png.copy(chunk, 8)
		return chunk
	})
	const header = Buffer.alloc(8)
	header.write('icns', 0, 4, 'ascii')
	header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
	return Buffer.concat([header, ...chunks])
}

const allSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]
const rendered = new Map()
for (const size of allSizes) rendered.set(size, await render(source, size))

await write(path.join(buildDir, 'icon.png'), rendered.get(512))
for (const size of [16, 32, 48, 64, 128, 256]) {
	await write(path.join(buildDir, 'icons', `${size}x${size}.png`), rendered.get(size))
}
await write(path.join(appDir, 'static', 'favicon.png'), rendered.get(128))
await write(path.join(appDir, 'static', 'tangent_256.png'), rendered.get(256))
await write(path.join(buildDir, 'Icon.icon', 'Assets', 'icon-stripped.png'), await render(strippedSource, 1024))

const icoImages = allSizes.filter(size => size <= 256).map(size => ({ size, png: rendered.get(size) }))
await write(path.join(buildDir, 'icon.ico'), ico(icoImages))
const icnsImages = [16, 32, 64, 128, 256, 512, 1024].map(size => ({ size, png: rendered.get(size) }))
await write(path.join(buildDir, 'icon.icns'), icns(icnsImages))

const extensionIcons = path.join(repoRoot, 'apps', 'osint-copilot-extension', 'static', 'icons')
for (const size of [16, 32, 48, 128]) {
	await write(path.join(extensionIcons, `icon-${size}.png`), rendered.get(size))
}

console.log('Generated OSINT Copilot desktop and extension icons from build/icon.svg')
