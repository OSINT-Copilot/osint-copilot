/**
 * What a profile actually exposed, measured in the profile itself.
 *
 * The feature's honest weakness is that separate cookie jars are not anonymity: across
 * every profile a site still sees one machine's fingerprint, timezone, GPU and core count.
 * Rather than bury that in documentation nobody reads, this measures it and shows the
 * operator the real answer for the profile they are using.
 *
 * That turns the weakness into the thing no competitor offers -- a dated record of what a
 * given identity was actually leaking while it was in use.
 *
 * Deliberately LOCAL only. It contacts nothing: an external IP-echo would tell the
 * operator their egress address, but it would also make a request from the identity they
 * are testing, to a third party, as a side effect of asking a question. The report says
 * plainly that the public address is not covered and how to check it deliberately.
 */

/**
 * Runs in the guest's isolated world, so the page cannot see it or tamper with the
 * result. A string rather than a function reference because it is injected, not called;
 * it must depend on nothing outside the page.
 */
export const REALITY_CHECK_SNIPPET = `(async () => {
	const gl = (() => {
		try {
			const canvas = document.createElement('canvas');
			const context = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
			if (!context) return null;
			const info = context.getExtension('WEBGL_debug_renderer_info');
			return info ? {
				vendor: context.getParameter(info.UNMASKED_VENDOR_WEBGL),
				renderer: context.getParameter(info.UNMASKED_RENDERER_WEBGL),
			} : null;
		} catch { return null; }
	})();

	// Host candidates are how a page reads the machine's local addresses straight past a
	// proxy. With the WebRTC policy applied there should be none.
	const webrtc = await (async () => {
		try {
			if (typeof RTCPeerConnection === 'undefined') return { supported: false, addresses: [] };
			const pc = new RTCPeerConnection({ iceServers: [] });
			const addresses = new Set();
			pc.createDataChannel('probe');
			pc.onicecandidate = (event) => {
				const candidate = event && event.candidate && event.candidate.candidate;
				if (!candidate) return;
				const match = candidate.match(/([0-9]{1,3}(?:\\.[0-9]{1,3}){3}|[a-f0-9:]{8,})/i);
				if (match) addresses.add(match[1]);
			};
			await pc.setLocalDescription(await pc.createOffer());
			await new Promise((resolve) => setTimeout(resolve, 1200));
			pc.close();
			return { supported: true, addresses: Array.from(addresses) };
		} catch { return { supported: false, addresses: [] }; }
	})();

	const uaData = navigator.userAgentData || null;
	return {
		userAgent: navigator.userAgent,
		uaDataPlatform: uaData ? uaData.platform : null,
		uaDataMobile: uaData ? uaData.mobile : null,
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		locale: navigator.language,
		languages: Array.from(navigator.languages || []),
		screen: { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio },
		viewport: { width: innerWidth, height: innerHeight },
		hardwareConcurrency: navigator.hardwareConcurrency,
		deviceMemory: navigator.deviceMemory === undefined ? null : navigator.deviceMemory,
		webgl: gl,
		webrtc,
	};
})()`

export interface RealitySignals {
	userAgent: string
	uaDataPlatform: string | null
	uaDataMobile: boolean | null
	timeZone: string
	locale: string
	languages: string[]
	screen: { width: number, height: number, pixelRatio: number }
	viewport: { width: number, height: number }
	hardwareConcurrency: number
	deviceMemory: number | null
	webgl: { vendor: string, renderer: string } | null
	webrtc: { supported: boolean, addresses: string[] }
}

export type Verdict = 'ok' | 'warn' | 'leak'

export interface RealityFinding {
	label: string
	value: string
	verdict: Verdict
	/** What this means for the operator, in the terms they care about. */
	note: string
}

/**
 * Turns raw signals into findings, given what the profile CLAIMED to be.
 *
 * Pure, so the judgements are testable without a browser -- and they are the part that
 * matters, because a list of raw values invites the reader to assume the reassuring
 * interpretation.
 */
export function interpret(
	signals: RealitySignals,
	profile: { userAgent?: string, proxy?: string, acceptLanguages?: string },
): RealityFinding[] {
	const findings: RealityFinding[] = []

	if (profile.userAgent) {
		const platform = signals.uaDataPlatform
		const claimsWindows = /Windows/i.test(signals.userAgent)
		const claimsMac = /Mac OS X|Macintosh/i.test(signals.userAgent)
		const contradicts = !!platform && (
			(claimsWindows && platform !== 'Windows') || (claimsMac && platform !== 'macOS'))
		findings.push({
			label: 'User-agent vs client hints',
			value: `${signals.userAgent} · platform reports "${platform ?? 'unknown'}"`,
			verdict: contradicts ? 'leak' : 'warn',
			note: contradicts
				? 'The spoofed user-agent and the Sec-CH-UA-Platform hint disagree. A site that '
					+ 'reads both sees a browser lying about its operating system, which is more '
					+ 'distinctive than not spoofing at all.'
				: 'Electron exposes no override for navigator.userAgentData, so the client hints '
					+ 'report the real platform. Setting the string reduces an obvious tell; it '
					+ 'does not make this look like another machine.',
		})
	}

	findings.push({
		label: 'Time zone',
		value: signals.timeZone,
		verdict: 'warn',
		note: 'Read from the operating system and identical in every profile. Electron has no '
			+ 'API to change it, so this is a reliable way to link one profile to another.',
	})

	findings.push({
		label: 'Language',
		value: `${signals.locale} · ${signals.languages.join(', ') || 'none'}`,
		verdict: profile.acceptLanguages && !signals.locale.startsWith(profile.acceptLanguages.slice(0, 2))
			? 'warn'
			: 'ok',
		note: profile.acceptLanguages
			? 'Accept-Language is set per profile, but navigator.language comes from the app '
				+ 'locale and does not follow it. The header and the JavaScript can disagree.'
			: 'Comes from the app locale, and is the same in every profile.',
	})

	findings.push({
		label: 'Hardware',
		value: `${signals.hardwareConcurrency} cores`
			+ (signals.deviceMemory === null ? '' : ` · ${signals.deviceMemory} GB`)
			+ ` · ${signals.screen.width}x${signals.screen.height} @${signals.screen.pixelRatio}`,
		verdict: 'warn',
		note: 'Identical across every profile, and a strong key for joining them together.',
	})

	if (signals.webgl) {
		findings.push({
			label: 'GPU',
			value: `${signals.webgl.vendor} · ${signals.webgl.renderer}`,
			verdict: 'warn',
			note: 'The same in every profile, and specific enough to identify this machine.',
		})
	}

	const leaked = signals.webrtc.addresses
	findings.push({
		label: 'WebRTC addresses',
		value: leaked.length ? leaked.join(', ') : 'none offered',
		verdict: leaked.length ? 'leak' : 'ok',
		note: leaked.length
			? 'WebRTC handed out addresses for this machine. These go around any proxy, and '
				+ 'this is the usual way a "proxied" browser gives its user away.'
			: 'No host candidates were offered, so the WebRTC policy is doing its job.',
	})

	findings.push({
		label: 'Egress',
		value: profile.proxy ? `via ${profile.proxy}` : 'direct — your own connection',
		verdict: profile.proxy ? 'ok' : 'warn',
		note: profile.proxy
			? 'Traffic for this profile leaves through the configured proxy, and a dead proxy '
				+ 'fails rather than falling back to a direct connection.'
			: 'This profile browses from your real address. Separate cookies do not hide that; '
				+ 'the site sees the same IP as every other profile.',
	})

	findings.push({
		label: 'Public address',
		value: 'not checked',
		verdict: 'warn',
		note: 'Deliberately not measured: asking a third party for your egress address would '
			+ 'itself make a request from this identity. Load an address-echo site in this '
			+ 'profile if you want to see it.',
	})

	return findings
}
