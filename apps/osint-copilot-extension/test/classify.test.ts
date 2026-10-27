// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { describe, expect, it } from 'vitest';
import { classify } from '../src/shared/classify';
import { buildManifest } from '../src/shared/manifest';
import { ENTITY_KINDS, WALLET_CHAINS } from '../src/shared/protocol';
import { platformFromUrl } from '../src/shared/url';
import { checkEntityValue, validateEntity, validateManifest } from '../src/shared/validate';
import { entityVectors } from './vectors';

describe('validateEntity agrees with the app on every shared entity vector', () => {
	it.each(entityVectors.entities.map(v => [v.note, v] as const))('%s', (_n, v) => {
		const result = validateEntity(v.entity);
		expect(result.ok, JSON.stringify(result)).toBe(v.expect === 'accept');
		if (result.ok && v.value !== undefined) expect(result.value.value).toBe(v.value);
	});
});

describe('validateManifest agrees with the app on every shared manifest vector', () => {
	it.each(entityVectors.manifests.map(v => [v.note, v] as const))('%s', (_n, v) => {
		const result = validateManifest(v.manifest);
		expect(result.ok, JSON.stringify(result)).toBe(v.expect === 'accept');
		if (result.ok) {
			if (v.url !== undefined) expect(result.value.page.url).toBe(v.url);
			if (v.bundleId !== undefined) expect(result.value.bundleId).toBe(v.bundleId);
			if (v.text !== undefined && result.value.kind === 'note') expect(result.value.note.text).toBe(v.text);
		} else if (v.detail !== undefined) {
			expect(result.detail).toBe(v.detail);
		}
	});
});

/** A vector refused for what its value is, not for a stray field or a bad chain. */
function isValueReject(entity: Record<string, unknown>): boolean {
	const keys = Object.keys(entity);
	if (keys.some(k => !['kind', 'value', 'chain'].includes(k))) return false;
	if (!(ENTITY_KINDS as readonly unknown[]).includes(entity.kind)) return false;
	if (entity.kind === 'wallet') return (WALLET_CHAINS as readonly unknown[]).includes(entity.chain);
	return entity.chain === undefined;
}

describe('classify', () => {
	const accepted = entityVectors.entities.filter(v => v.expect === 'accept');

	it.each(accepted.map(v => [v.note, v] as const))('names the vector\'s kind for accepted %s', (_n, v) => {
		const got = classify(v.entity.value as string);
		expect(got).not.toBeNull();
		expect(got!.kind).toBe(v.entity.kind);
		if (v.entity.chain !== undefined) expect(got!.chain).toBe(v.entity.chain);
		expect(got!.value).toBe(v.value ?? v.entity.value);
	});

	it.each(entityVectors.entities.map(v => [v.note, v] as const))('never suggests anything the app would refuse (%s)', (_n, v) => {
		const got = classify(String(v.entity.value));
		if (got) expect(checkEntityValue(got.kind, got.value, got.chain)).toBeNull();
	});

	const valueRejects = entityVectors.entities.filter(v => v.expect === 'reject' && isValueReject(v.entity));

	it.each(valueRejects.map(v => [v.note, v] as const))('does not offer rejected %s as that kind', (_n, v) => {
		const got = classify(String(v.entity.value));
		if (got) expect(`${got.kind}/${got.chain ?? ''}`).not.toBe(`${v.entity.kind}/${v.entity.chain ?? ''}`);
	});

	it('returns null rather than a username for near-miss wallets and bare numbers', () => {
		expect(classify('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb')).toBeNull(); // Base58Check off by one
		expect(classify('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')).toBeNull();
		expect(classify('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBeNull(); // EIP-55 fails
		expect(classify('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA')).toBeNull(); // too short
		expect(classify('01.2.3.4')).toBeNull();
		expect(classify('123')).toBeNull();
		expect(classify('   ')).toBeNull();
		expect(classify('two words')).toBeNull();
	});

	it('handles everyday selections', () => {
		expect(classify('  analyst@example.com ')).toEqual({ kind: 'email', value: 'analyst@example.com' });
		expect(classify('@john_doe')).toEqual({ kind: 'username', value: '@john_doe' });
		expect(classify('https://example.com/x')).toEqual({ kind: 'url', value: 'https://example.com/x' });
		expect(classify('sub.example.co.uk')).toEqual({ kind: 'domain', value: 'sub.example.co.uk' });
		expect(classify('+1 555 010 4477')).toEqual({ kind: 'phone', value: '+1 555 010 4477' });
		expect(classify('TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW')).toEqual({ kind: 'wallet', chain: 'other', value: 'TJCnKsPa7y5okkXvQAidZBzqx3QyQ6sxMW' });
		expect(classify('x'.repeat(513))).toBeNull();
	});
});

describe('platformFromUrl', () => {
	it('defaults to the page host without www', () => {
		expect(platformFromUrl('https://www.github.com/john')).toBe('github.com');
		expect(platformFromUrl('https://x.com/john')).toBe('x.com');
		expect(platformFromUrl('https://[2001:db8::1]/')).toBeNull();
		expect(platformFromUrl(`https://${'a'.repeat(40)}.com/`)).toBeNull();
		expect(platformFromUrl(undefined)).toBeNull();
	});
});

describe('buildManifest', () => {
	const page = { url: 'https://user:pw@example.com/a', title: 'A page' };
	const deps = { uuid: () => '0B7E7C1E-3F7A-4C56-9A3E-2D4F5B6C7D8E', now: () => Date.UTC(2025, 9, 9, 8, 53, 20) };

	it('builds a note manifest exactly per §8, cleaned as the app will', () => {
		const got = buildManifest({ kind: 'note', workspaceId: 'AAAAAAAAAAAAAAAAAAAAAA', page, note: { text: ' hi\r\nthere ' } }, deps);
		expect(got).toEqual({
			ok: true,
			value: {
				v: 1,
				bundleId: '0b7e7c1e-3f7a-4c56-9a3e-2d4f5b6c7d8e',
				workspaceId: 'AAAAAAAAAAAAAAAAAAAAAA',
				kind: 'note',
				page: { url: 'https://example.com/a', title: 'A page' },
				clientTime: '2025-10-09T08:53:20.000Z',
				note: { text: 'hi\nthere' },
			},
		});
	});

	it('drops blank optional entity fields and refuses a bad value locally', () => {
		const ok = buildManifest({ kind: 'entity', workspaceId: 'AAAAAAAAAAAAAAAAAAAAAA', page, entity: { kind: 'username', value: 'john', platform: '', context: '' } }, deps);
		expect(ok.ok && ok.value.kind === 'entity' && ok.value.entity).toEqual({ kind: 'username', value: 'john' });
		const bad = buildManifest({ kind: 'entity', workspaceId: 'AAAAAAAAAAAAAAAAAAAAAA', page, entity: { kind: 'ip', value: '1.2.3' } }, deps);
		expect(bad).toEqual({ ok: false, detail: 'entity.value: not an IPv4 or IPv6 address' });
	});

	it('mints a fresh UUID v4 per item by default', () => {
		const a = buildManifest({ kind: 'note', workspaceId: 'AAAAAAAAAAAAAAAAAAAAAA', page, note: { text: 'x' } });
		const b = buildManifest({ kind: 'note', workspaceId: 'AAAAAAAAAAAAAAAAAAAAAA', page, note: { text: 'x' } });
		expect(a.ok && b.ok && a.value.bundleId !== b.value.bundleId).toBe(true);
	});
});
