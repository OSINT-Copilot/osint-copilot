import { describe, it, expect } from 'vitest'
import { randomBytes } from 'crypto'
import { canonicalJson, sealManifest, verifySealedManifest } from './manifest-mac'
import type { Manifest } from '../extension/protocol'

describe('canonicalJson', () => {
	it('sorts keys at every depth, keeps array order, and has no whitespace', () => {
		expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x y' } }))
			.toBe('{"a":{"c":"x y","d":[3,{"y":2,"z":1}]},"b":1}')
	})

	it('escapes strings exactly as JSON.stringify does', () => {
		const key = '\u2028'
		const value = 'a"\n\\'
		expect(canonicalJson({ [key]: value })).toBe(`{${JSON.stringify(key)}:${JSON.stringify(value)}}`)
	})
})

describe('sealed manifests', () => {
	const key = randomBytes(32)
	const manifest = {
		v: 1, bundleId: '0b8e4c5e-5d6a-4f1e-9a3b-2c1d0e9f8a7b', workspaceId: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'note',
		page: { url: 'https://example.com/', title: 'T' }, clientTime: '2026-09-18T10:00:00.000Z', note: { text: 'hi' },
	} as Manifest
	const server = { receivedAt: '2026-09-18T10:00:01.000Z', clientId: 'CCCCCCCCCCCCCCCCCCCCCC', origin: 'chrome-extension://' + 'a'.repeat(32), extVersion: '1.0.0' }

	it('verifies after a JSON round trip in any key order, and not under another key', () => {
		const sealed = sealManifest(key, manifest, server)
		const reordered = JSON.parse(JSON.stringify({ mac: sealed.mac, server: sealed.server, ...manifest }, null, 4))
		expect(verifySealedManifest(key, reordered)).toBe(true)
		expect(verifySealedManifest(randomBytes(32), sealed)).toBe(false)
	})

	it('fails for any change, and for things that are not manifests', () => {
		const sealed = sealManifest(key, manifest, server)
		expect(verifySealedManifest(key, { ...sealed, clientTime: '2026-09-18T10:00:00.001Z' })).toBe(false)
		expect(verifySealedManifest(key, { ...sealed, server: { ...server, origin: 'chrome-extension://' + 'b'.repeat(32) } })).toBe(false)
		expect(verifySealedManifest(key, { ...sealed, mac: undefined })).toBe(false)
		for (const junk of [null, 'x', [sealed], 42]) expect(verifySealedManifest(key, junk)).toBe(false)
	})
})
