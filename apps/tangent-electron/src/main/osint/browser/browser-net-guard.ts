/**
 * Where a browsing guest's requests may go.
 *
 * The rest of the app's outbound traffic passes through net-guard.ts, which checks a
 * per-enricher domain allowlist and refuses private address space after DNS. A browser
 * cannot use that: one that refuses unknown infrastructure is not a browser, so the domain
 * allowlist is permanently gone for this surface.
 *
 * What survives is the address half, and it is worth keeping on its own. Without it, any
 * page an investigator opens can reach their loopback interface, their LAN, and the cloud
 * metadata endpoint -- scanning the machine and the network from inside the tool that was
 * supposed to keep the investigation at arm's length.
 *
 * The honest limit: this matches on the URL's host, so it stops literal private addresses
 * and the obvious local names, but a public hostname that RESOLVES to 127.0.0.1 gets
 * through. Chromium resolves separately from us, so a DNS check here would be advisory and
 * racy rather than authoritative -- it would read as a guarantee while not being one.
 */
import { isPrivateAddress } from '../node/net-guard'

/** Names that mean "this machine" without being an address. */
const LOCAL_NAMES = ['localhost', 'ip6-localhost', 'ip6-loopback']

function isLocalName(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, '')
	return LOCAL_NAMES.includes(host)
		|| LOCAL_NAMES.some(name => host.endsWith(`.${name}`))
		// RFC 6762; a .local name is resolved by mDNS on the local link.
		|| host.endsWith('.local')
}

export interface AddressPolicy {
	/**
	 * Permits loopback. Off in normal use; the integration suite serves its fixture page
	 * from 127.0.0.1, and pointing the spike at the live internet would make the test
	 * depend on someone else's uptime.
	 */
	allowLoopback?: boolean
}

export function isRequestAddressPermitted(url: string, policy: AddressPolicy = {}): boolean {
	let parsed: URL
	try {
		parsed = new URL(url)
	}
	catch {
		return false
	}

	// Only network schemes are this guard's business. `about:`, `blob:` and friends carry
	// no host to judge, and which SCHEMES a guest may open is decided by the navigation
	// policy in attach-guard -- judging them here too would mean cancelling the guest's
	// own `about:blank` before it ever attaches.
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true

	// Strip the brackets IPv6 literals carry in a URL.
	const host = parsed.hostname.replace(/^\[|\]$/g, '')
	if (!host) return false

	const loopback = host === '127.0.0.1' || host === '::1' || isLocalName(host)
	if (loopback) return policy.allowLoopback === true

	// A literal address is checked directly. A name is not resolved here: see the header.
	if (/^[0-9.]+$/.test(host) || host.includes(':')) {
		return !isPrivateAddress(host)
	}

	return true
}
