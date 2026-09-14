/**
 * Browsing profiles, resolved and applied in main.
 *
 * The renderer names a profile by id and never sees a partition, a proxy or a session.
 * Main reads the descriptors out of the vault itself -- the same shape as exec-guard.ts
 * reading CLI paths from `.osint-copilot/data.json`, and for the same reason: the file is
 * user-authored, so the side that acts on it validates it.
 *
 * Where the cookie jars live: Electron stores a `persist:` partition under
 * `userData/Partitions/<name>`. Deliberately NOT the vault. Two recursive watchers cover
 * the vault root, and a Chromium profile churns thousands of LevelDB files through both;
 * worse, Chromium's cookie encryption is off by default, so a vault-resident jar would be
 * plaintext live session cookies sitting inside the artifact analysts sync and share.
 *
 * (The plan said Session.fromPath for this. persist: partitions reach the same place --
 * userData, not the vault -- and are the documented path for `<webview partition>`, while
 * a fromPath session can only be attached to a guest through `webPreferences.session`,
 * which is unverified for webviews. The requirement was "not in the vault", and this
 * meets it without resting on an unverified hook.)
 */
import { session } from 'electron'
import Logger from 'js-logger'

import * as vaultFs from '../node/vault'
import { isRequestAddressPermitted } from './browser-net-guard'
import {
	DEFAULT_PROFILE,
	parseProfiles,
	proxyRulesFor,
	type BrowseProfile,
} from './profile-policy'

/** Where the descriptors live. Visible analyst content, beside the panes themselves. */
export const PROFILES_VAULT_PATH = 'OSINTCopilot/browsing/profiles.json'

/** Namespaced so nothing here can collide with a Tangent session. */
export const PARTITION_PREFIX = 'persist:osint-browse-'

export function partitionFor(profileId: string): string {
	return PARTITION_PREFIX + profileId
}

/** Sessions already configured this run; configuring twice would stack request handlers. */
const configured = new Set<string>()

export async function loadProfiles(): Promise<BrowseProfile[]> {
	try {
		return parseProfiles(await vaultFs.read(PROFILES_VAULT_PATH))
	}
	catch {
		// No file yet, or no vault open. One profile is a working browser.
		return [DEFAULT_PROFILE]
	}
}

export async function findProfile(profileId: string): Promise<BrowseProfile> {
	const profiles = await loadProfiles()
	return profiles.find(p => p.id === profileId) ?? DEFAULT_PROFILE
}

export class ProxyNotPermittedError extends Error {}

/**
 * Prepares a profile's session before anything loads in it.
 *
 * Throws rather than degrading. A profile that asks for a proxy and cannot have one must
 * not quietly browse direct: the operator chose the proxy so that the site they are
 * investigating does not learn where they are, and silently ignoring it would hand over
 * exactly what they were trying to withhold.
 */
export async function configureProfileSession(profile: BrowseProfile): Promise<void> {
	const partition = partitionFor(profile.id)
	if (configured.has(partition)) return

	const ses = session.fromPartition(partition)

	// Denied wholesale rather than prompted: each of these is a way for a page to learn
	// something about the operator, and an investigator clicking through a prompt on a
	// hostile page is exactly the mistake this tool should not offer them.
	ses.setPermissionRequestHandler((_contents, permission, callback) => {
		Logger.info('[osint] denied a guest permission request:', permission)
		callback(false)
	})
	ses.setPermissionCheckHandler(() => false)

	if (profile.userAgent) {
		// Sets the UA STRING only. navigator.userAgentData and the Sec-CH-UA-* headers keep
		// reporting the real platform, because Electron exposes no override for them -- so
		// this reduces an obvious tell, it does not make the profile look like another
		// machine. The UI must not describe it as more than that.
		ses.setUserAgent(profile.userAgent, profile.acceptLanguages)
	}
	else if (profile.acceptLanguages) {
		ses.setUserAgent(ses.getUserAgent(), profile.acceptLanguages)
	}

	if (profile.proxy) {
		const proxyRules = proxyRulesFor(profile)
		if (!proxyRules) {
			throw new ProxyNotPermittedError(
				`Profile "${profile.name}" asks for a proxy this build will not use: ${profile.proxy}. ` +
				'Only socks5://, http:// and https:// are accepted; socks4 resolves hostnames ' +
				'on this machine, which leaks every site you visit to your own resolver.')
		}
		await ses.setProxy({
			proxyRules,
			// `<-loopback>` REMOVES Chromium's implicit "never proxy localhost" rule. With it
			// left in, a request to a local address would sidestep the proxy entirely.
			proxyBypassRules: '<-loopback>',
		})
		// Sockets pooled before the rules changed keep the old egress, so a profile that
		// has already browsed would keep leaving by the previous route.
		await ses.closeAllConnections()
	}

	const allowLoopback = process.env.INTEGRATION_TEST === '1'
	ses.webRequest.onBeforeRequest((details, callback) => {
		if (isRequestAddressPermitted(details.url, { allowLoopback })) {
			callback({ cancel: false })
			return
		}
		Logger.warn('[osint] blocked a guest request to a local address:', details.url)
		callback({ cancel: true })
	})

	configured.add(partition)
	Logger.info(`[osint] browsing profile "${profile.id}" ready`,
		profile.proxy ? `via ${new URL(profile.proxy).protocol}//…` : '(direct)')
}

/** Test seam: sessions are process state and tests need a fresh view of them. */
export function resetConfiguredProfilesForTests(): void {
	configured.clear()
}
