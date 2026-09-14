import { describe, it, expect } from 'vitest'
import { isRequestAddressPermitted } from './browser-net-guard'

describe('where a browsing guest may send requests', () => {
	it('allows ordinary public addresses', () => {
		expect(isRequestAddressPermitted('https://example.com/')).toBe(true)
		expect(isRequestAddressPermitted('http://8.8.8.8/')).toBe(true)
		expect(isRequestAddressPermitted('https://sub.domain.example.co.uk/a?b=c')).toBe(true)
	})

	it('blocks the operator\'s own machine', () => {
		expect(isRequestAddressPermitted('http://127.0.0.1:8080/')).toBe(false)
		expect(isRequestAddressPermitted('http://[::1]:8080/')).toBe(false)
		expect(isRequestAddressPermitted('http://localhost:3000/')).toBe(false)
		expect(isRequestAddressPermitted('http://printer.local/')).toBe(false)
	})

	it('blocks the LAN and the cloud metadata endpoint', () => {
		// A page that can reach these can map the network the investigator is sitting on.
		expect(isRequestAddressPermitted('http://192.168.1.1/')).toBe(false)
		expect(isRequestAddressPermitted('http://10.0.0.5/')).toBe(false)
		expect(isRequestAddressPermitted('http://172.16.4.4/')).toBe(false)
		expect(isRequestAddressPermitted('http://169.254.169.254/latest/meta-data/')).toBe(false)
	})

	it('permits loopback only when explicitly told to', () => {
		expect(isRequestAddressPermitted('http://127.0.0.1:9/', { allowLoopback: true })).toBe(true)
		// ...and the permission does not leak to the rest of private space.
		expect(isRequestAddressPermitted('http://192.168.1.1/', { allowLoopback: true })).toBe(false)
		expect(isRequestAddressPermitted('http://169.254.169.254/', { allowLoopback: true })).toBe(false)
	})

	it('refuses anything it cannot parse as a URL', () => {
		expect(isRequestAddressPermitted('not a url')).toBe(false)
		expect(isRequestAddressPermitted('http://')).toBe(false)
	})

	it('leaves non-network schemes to the navigation policy', () => {
		// Judging these here would cancel the guest's own about:blank before it attaches.
		// Which schemes a guest may OPEN is decided in attach-guard, not here.
		expect(isRequestAddressPermitted('about:blank')).toBe(true)
		expect(isRequestAddressPermitted('devtools://devtools/bundled/x.js')).toBe(true)
	})
})
