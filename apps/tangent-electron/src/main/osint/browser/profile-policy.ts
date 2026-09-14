/**
 * What a browsing profile is, and which of its settings are allowed.
 *
 * A profile is an identity an investigator browses as: its own cookie jar, its own
 * egress, its own user-agent string. The descriptors are user-authored and live in the
 * vault, so main validates them here rather than trusting the file -- the same reasoning
 * exec-guard.ts applies to CLI paths out of `.osint-copilot/data.json`.
 *
 * Electron-free, so the rules are unit-testable.
 *
 * On the word "profile": not "sock puppet", not "identity protection", and never
 * "anonymous". What this buys is COMPARTMENTALISATION -- one profile's logins and cookies
 * cannot reach another's sites. It is not unlinkability: across every profile a site still
 * sees one machine's fingerprint, timezone, fonts and GPU. Copy that says otherwise would
 * be a safety claim the implementation cannot keep.
 */

/** Ids become partition names and directory names, so keep them boring. */
export const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface BrowseProfile {
	id: string
	name: string
	/** Shown on the pane border and chrome, so a glance says which identity is loaded. */
	colour: string
	userAgent?: string
	/** Sent as Accept-Language. Note that navigator.language does NOT follow it. */
	acceptLanguages?: string
	/** socks5://, http:// or https:// only -- see isProxyPermitted. */
	proxy?: string
}

export const DEFAULT_PROFILE: BrowseProfile = {
	id: 'default',
	name: 'Default',
	colour: '#6b7280',
}

/**
 * Proxy schemes a profile may use.
 *
 * socks4 and plain `socks://` are deliberately absent: they resolve hostnames on the
 * client, so every site the operator visits is leaked to whatever resolver the machine
 * uses -- which is precisely the exposure someone configures a proxy to avoid. Refusing
 * them is better than shipping a proxy setting that quietly does not do what its user
 * believes it does.
 */
const PERMITTED_PROXY_SCHEMES = ['socks5:', 'http:', 'https:']

export function isProxyPermitted(proxy: string): boolean {
	let parsed: URL
	try {
		parsed = new URL(proxy)
	}
	catch {
		return false
	}
	if (!PERMITTED_PROXY_SCHEMES.includes(parsed.protocol)) return false
	// A proxy with no host is a typo, and Chromium would silently ignore the rule.
	return parsed.hostname.length > 0
}

/** Reads one descriptor, returning null rather than a half-valid profile. */
export function normaliseProfile(raw: unknown): BrowseProfile | null {
	if (!raw || typeof raw !== 'object') return null
	const record = raw as Record<string, unknown>

	const id = typeof record.id === 'string' ? record.id.trim().toLowerCase() : ''
	if (!PROFILE_ID_PATTERN.test(id)) return null

	const name = typeof record.name === 'string' && record.name.trim()
		? record.name.trim()
		: id
	const colour = typeof record.colour === 'string' && /^#[0-9a-f]{6}$/i.test(record.colour)
		? record.colour
		: DEFAULT_PROFILE.colour

	const profile: BrowseProfile = { id, name, colour }

	if (typeof record.userAgent === 'string' && record.userAgent.trim()) {
		profile.userAgent = record.userAgent.trim()
	}
	if (typeof record.acceptLanguages === 'string' && record.acceptLanguages.trim()) {
		profile.acceptLanguages = record.acceptLanguages.trim()
	}
	// An unusable proxy is dropped, not silently downgraded to direct: configureProfile
	// refuses to start a session whose proxy was asked for and could not be honoured.
	if (typeof record.proxy === 'string' && record.proxy.trim()) {
		profile.proxy = record.proxy.trim()
	}

	return profile
}

export function parseProfiles(text: string | null): BrowseProfile[] {
	if (!text) return [DEFAULT_PROFILE]
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	}
	catch {
		return [DEFAULT_PROFILE]
	}
	const list = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as Record<string, unknown>)?.profiles)
			? (parsed as { profiles: unknown[] }).profiles
			: []

	const profiles: BrowseProfile[] = []
	const seen = new Set<string>()
	for (const entry of list) {
		const profile = normaliseProfile(entry)
		if (!profile || seen.has(profile.id)) continue
		seen.add(profile.id)
		profiles.push(profile)
	}

	if (!profiles.some(p => p.id === DEFAULT_PROFILE.id)) profiles.unshift(DEFAULT_PROFILE)
	return profiles
}

/**
 * Chromium proxy rules for a profile.
 *
 * Deliberately no DIRECT in the list. Chromium falls back to a direct connection only for
 * rules that name it, so leaving it out is what makes a dead proxy FAIL rather than
 * quietly sending the operator's real address to the site they are investigating. That
 * failure mode is the entire reason someone sets a proxy.
 */
export function proxyRulesFor(profile: BrowseProfile): string | null {
	if (!profile.proxy) return null
	if (!isProxyPermitted(profile.proxy)) return null
	return profile.proxy
}
