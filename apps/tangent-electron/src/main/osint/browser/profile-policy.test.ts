import { describe, it, expect } from 'vitest'
import {
	DEFAULT_PROFILE,
	isProxyPermitted,
	normaliseProfile,
	parseProfiles,
	proxyRulesFor,
} from './profile-policy'

describe('reading profile descriptors out of the vault', () => {
	it('always offers a default, even with no file, bad JSON or junk', () => {
		// The descriptors are user-authored; a typo must not leave the operator unable to
		// browse at all.
		for (const input of [null, '', 'not json', '{}', '[]', '{"profiles":"nope"}']) {
			expect(parseProfiles(input)).toEqual([DEFAULT_PROFILE])
		}
	})

	it('accepts both a bare array and a { profiles: [] } wrapper', () => {
		const one = parseProfiles(JSON.stringify([{ id: 'alpha', name: 'Alpha' }]))
		const two = parseProfiles(JSON.stringify({ profiles: [{ id: 'alpha', name: 'Alpha' }] }))
		expect(one.map(p => p.id)).toEqual(['default', 'alpha'])
		expect(two.map(p => p.id)).toEqual(['default', 'alpha'])
	})

	it('drops entries it cannot make sense of, keeping the rest', () => {
		const profiles = parseProfiles(JSON.stringify([
			{ id: 'good', name: 'Good' },
			{ id: 'Has Spaces', name: 'nope' },
			{ id: '../escape', name: 'nope' },
			{ name: 'no id' },
			'a string',
		]))
		expect(profiles.map(p => p.id)).toEqual(['default', 'good'])
	})

	it('refuses duplicate ids, which would be two panes sharing one jar under two names', () => {
		const profiles = parseProfiles(JSON.stringify([
			{ id: 'alpha', name: 'First' },
			{ id: 'alpha', name: 'Second' },
		]))
		expect(profiles.filter(p => p.id === 'alpha')).toHaveLength(1)
		expect(profiles.find(p => p.id === 'alpha')!.name).toBe('First')
	})

	it('falls back to a readable name and colour rather than rejecting the profile', () => {
		const profile = normaliseProfile({ id: 'alpha' })!
		expect(profile.name).toBe('alpha')
		expect(profile.colour).toBe(DEFAULT_PROFILE.colour)
		expect(normaliseProfile({ id: 'alpha', colour: 'red' })!.colour).toBe(DEFAULT_PROFILE.colour)
		expect(normaliseProfile({ id: 'alpha', colour: '#AABBCC' })!.colour).toBe('#AABBCC')
	})
})

describe('which proxies a profile may use', () => {
	it('accepts socks5, http and https', () => {
		expect(isProxyPermitted('socks5://127.0.0.1:9050')).toBe(true)
		expect(isProxyPermitted('http://proxy.example:3128')).toBe(true)
		expect(isProxyPermitted('https://proxy.example:3128')).toBe(true)
	})

	it('refuses socks4 and bare socks, which resolve hostnames on this machine', () => {
		// That leaks every site the operator visits to their own resolver -- the exposure
		// a proxy is usually configured to avoid.
		expect(isProxyPermitted('socks4://127.0.0.1:9050')).toBe(false)
		expect(isProxyPermitted('socks://127.0.0.1:9050')).toBe(false)
	})

	it('refuses nonsense and proxies with no host', () => {
		expect(isProxyPermitted('not a url')).toBe(false)
		expect(isProxyPermitted('socks5://')).toBe(false)
		expect(isProxyPermitted('ftp://proxy.example')).toBe(false)
	})

	it('never puts DIRECT in the rules, so a dead proxy fails instead of leaking', () => {
		const rules = proxyRulesFor({ id: 'a', name: 'A', colour: '#000000', proxy: 'socks5://h:1' })
		expect(rules).toBe('socks5://h:1')
		expect(rules).not.toMatch(/DIRECT/i)
	})

	it('returns null for a proxy it will not use, so the caller can refuse rather than degrade', () => {
		expect(proxyRulesFor({ id: 'a', name: 'A', colour: '#000000', proxy: 'socks4://h:1' })).toBeNull()
		expect(proxyRulesFor({ id: 'a', name: 'A', colour: '#000000' })).toBeNull()
	})
})
