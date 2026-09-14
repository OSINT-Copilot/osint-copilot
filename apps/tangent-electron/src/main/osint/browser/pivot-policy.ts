/**
 * Pivots: taking a value off a page and asking other places about it.
 *
 * This is the feature people describe when they say "OSINT browser" -- select a username,
 * fan it out to the sites that might know it. Silo sells it as Gofer; Ostium's URL Builder
 * is the DIY version. It is cheap to build and has no moat: a list of URL templates is a
 * list of URL templates, and every such list rots.
 *
 * What is not cheap, and is the reason to build it here rather than admire it elsewhere,
 * is where the results land. A pivot opens panes in the SAME profile, each carrying what
 * it came from, so the fan-out is part of the investigation rather than eleven tabs the
 * analyst has to remember the provenance of.
 *
 * The bundled list is deliberately small and stable rather than the ~1,300 URLs Ostium
 * ships. A long list of mostly-dead links is a worse starting point than a short list of
 * live ones, and the vault file is where an analyst's real list lives.
 */

export type ValueKind =
	| 'email' | 'phone' | 'username' | 'domain' | 'url'
	| 'ipv4' | 'ipv6' | 'btc' | 'eth' | 'hash' | 'text'

export interface Pivot {
	id: string
	label: string
	category: string
	/** `{value}` is substituted, URL-encoded. */
	url: string
	appliesTo: ValueKind[]
	enabled: boolean
}

export const PIVOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Classifies a selected value.
 *
 * Order matters: a URL contains a domain, an email contains something username-shaped, and
 * a hash is hex that would otherwise read as a username. The first confident answer wins,
 * and `text` is the honest fallback rather than a guess.
 */
export function classify(raw: string): ValueKind {
	const value = raw.trim()
	if (!value) return 'text'

	if (/^https?:\/\/\S+$/i.test(value)) return 'url'
	if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value)) return 'email'

	if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)
		&& value.split('.').every(part => Number(part) <= 255)) return 'ipv4'
	if (/^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i.test(value) && value.includes('::')
		|| /^([0-9a-f]{1,4}:){7}[0-9a-f]{1,4}$/i.test(value)) return 'ipv6'

	// Before the hash check: an ETH address is also 40 hex characters.
	if (/^0x[0-9a-f]{40}$/i.test(value)) return 'eth'
	if (/^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(value)) return 'btc'
	if (/^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value)) return 'hash'

	// A phone number, once the punctuation people actually type is allowed for.
	const digits = value.replace(/[\s().-]/g, '')
	if (/^\+?\d{7,15}$/.test(digits)) return 'phone'

	if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value) && /\.[a-z]{2,}$/i.test(value)) return 'domain'
	// Deliberately narrow: no spaces, and the shapes handles actually take.
	if (/^@?[a-z0-9._-]{2,40}$/i.test(value)) return 'username'

	return 'text'
}

/** Strips the decoration people paste around a handle. */
export function cleanValue(raw: string, kind: ValueKind): string {
	const value = raw.trim()
	return kind === 'username' ? value.replace(/^@+/, '') : value
}

export function buildUrl(pivot: Pivot, value: string): string {
	return pivot.url.replace(/\{value\}/g, encodeURIComponent(value))
}

export function normalisePivot(raw: unknown): Pivot | null {
	if (!raw || typeof raw !== 'object') return null
	const record = raw as Record<string, unknown>

	const id = typeof record.id === 'string' ? record.id.trim().toLowerCase() : ''
	if (!PIVOT_ID_PATTERN.test(id)) return null

	const url = typeof record.url === 'string' ? record.url.trim() : ''
	// http(s) only, and it must actually use the value -- a template that ignores it is a
	// bookmark, and silently opening the same page for every selection is worse than
	// refusing the entry.
	if (!/^https?:\/\//i.test(url) || !url.includes('{value}')) return null

	const appliesTo = Array.isArray(record.appliesTo)
		? record.appliesTo.filter((kind): kind is ValueKind => typeof kind === 'string') as ValueKind[]
		: ['text' as ValueKind]

	return {
		id,
		label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : id,
		category: typeof record.category === 'string' && record.category.trim()
			? record.category.trim()
			: 'Other',
		url,
		appliesTo: appliesTo.length ? appliesTo : ['text'],
		enabled: record.enabled !== false,
	}
}

export function parsePivots(text: string | null): Pivot[] {
	if (!text) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	}
	catch {
		return []
	}
	const list = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as Record<string, unknown>)?.pivots)
			? (parsed as { pivots: unknown[] }).pivots
			: []

	const pivots: Pivot[] = []
	const seen = new Set<string>()
	for (const entry of list) {
		const pivot = normalisePivot(entry)
		if (!pivot || seen.has(pivot.id)) continue
		seen.add(pivot.id)
		pivots.push(pivot)
	}
	return pivots
}

/**
 * User entries override bundled ones of the same id.
 *
 * Overriding rather than appending is what lets an analyst fix a bundled link that has
 * rotted, or disable one they do not want to touch, without maintaining the whole list.
 */
export function mergePivots(bundled: Pivot[], user: Pivot[]): Pivot[] {
	const byId = new Map(bundled.map(pivot => [pivot.id, pivot]))
	for (const pivot of user) byId.set(pivot.id, pivot)
	return [...byId.values()]
}

export function pivotsFor(pivots: Pivot[], kind: ValueKind): Pivot[] {
	return pivots.filter(pivot => pivot.enabled && pivot.appliesTo.includes(kind))
}

/**
 * The bundled starter list.
 *
 * Small, and every entry is a plain URL shape that does not require a session. Anything
 * needing a login would open a sign-in page, which is a worse answer than not offering
 * the pivot.
 */
export const BUNDLED_PIVOTS: Pivot[] = ([
	// Search, which applies to anything at all.
	{ id: 'google-exact', label: 'Google (exact phrase)', category: 'Search',
		url: 'https://www.google.com/search?q=%22{value}%22',
		appliesTo: ['text', 'email', 'phone', 'username', 'domain', 'btc', 'eth', 'hash'] },
	{ id: 'duckduckgo', label: 'DuckDuckGo', category: 'Search',
		url: 'https://duckduckgo.com/?q=%22{value}%22',
		appliesTo: ['text', 'email', 'phone', 'username', 'domain', 'btc', 'eth', 'hash'] },
	{ id: 'bing', label: 'Bing', category: 'Search',
		url: 'https://www.bing.com/search?q=%22{value}%22',
		appliesTo: ['text', 'email', 'phone', 'username'] },

	// Accounts.
	{ id: 'github-user', label: 'GitHub profile', category: 'Accounts',
		url: 'https://github.com/{value}', appliesTo: ['username'] },
	{ id: 'reddit-user', label: 'Reddit profile', category: 'Accounts',
		url: 'https://www.reddit.com/user/{value}', appliesTo: ['username'] },
	{ id: 'x-user', label: 'X profile', category: 'Accounts',
		url: 'https://x.com/{value}', appliesTo: ['username'] },
	{ id: 'instagram-user', label: 'Instagram profile', category: 'Accounts',
		url: 'https://www.instagram.com/{value}/', appliesTo: ['username'] },
	{ id: 'tiktok-user', label: 'TikTok profile', category: 'Accounts',
		url: 'https://www.tiktok.com/@{value}', appliesTo: ['username'] },

	// Email.
	{ id: 'hibp', label: 'Have I Been Pwned', category: 'Email',
		url: 'https://haveibeenpwned.com/account/{value}', appliesTo: ['email'] },

	// Infrastructure.
	{ id: 'crtsh', label: 'crt.sh certificates', category: 'Infrastructure',
		url: 'https://crt.sh/?q={value}', appliesTo: ['domain'] },
	{ id: 'whois', label: 'WHOIS', category: 'Infrastructure',
		url: 'https://who.is/whois/{value}', appliesTo: ['domain'] },
	{ id: 'urlscan-domain', label: 'urlscan.io', category: 'Infrastructure',
		url: 'https://urlscan.io/domain/{value}', appliesTo: ['domain'] },
	{ id: 'virustotal-domain', label: 'VirusTotal domain', category: 'Infrastructure',
		url: 'https://www.virustotal.com/gui/domain/{value}', appliesTo: ['domain'] },
	{ id: 'shodan-host', label: 'Shodan host', category: 'Infrastructure',
		url: 'https://www.shodan.io/host/{value}', appliesTo: ['ipv4', 'ipv6'] },
	{ id: 'virustotal-ip', label: 'VirusTotal address', category: 'Infrastructure',
		url: 'https://www.virustotal.com/gui/ip-address/{value}', appliesTo: ['ipv4', 'ipv6'] },

	// Archives.
	{ id: 'wayback', label: 'Wayback Machine', category: 'Archives',
		url: 'https://web.archive.org/web/*/{value}', appliesTo: ['domain', 'url'] },

	// Chains.
	{ id: 'mempool-btc', label: 'mempool.space address', category: 'Blockchain',
		url: 'https://mempool.space/address/{value}', appliesTo: ['btc'] },
	{ id: 'blockchain-btc', label: 'Blockchain.com address', category: 'Blockchain',
		url: 'https://www.blockchain.com/explorer/addresses/btc/{value}', appliesTo: ['btc'] },
	{ id: 'etherscan', label: 'Etherscan address', category: 'Blockchain',
		url: 'https://etherscan.io/address/{value}', appliesTo: ['eth'] },
] as Array<Omit<Pivot, 'enabled'>>).map(pivot => ({ ...pivot, enabled: true }))
