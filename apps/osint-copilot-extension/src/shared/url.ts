// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * URL and host helpers, built on the WHATWG URL parser that both Chrome and Node ship, so
 * the extension reaches the same verdicts as the app (whose Node url.domainToASCII is the
 * same host parser).
 */
import { PLATFORM } from './protocol';

/**
 * An http(s) URL with any username and password removed: credentials in a page URL are
 * someone's login and must not travel into a case file. Null for anything else.
 */
export function normalisePageUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	url.username = '';
	url.password = '';
	return url.href;
}

export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

/** IDNA to ASCII through the URL host parser; '' when the host is invalid. */
export function domainToAscii(value: string): string {
	try {
		return new URL(`http://${value}/`).hostname;
	} catch {
		return '';
	}
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
/** Dotted decimal only: the URL parser would read "01.2.3.4" as octal and "1.2.3" as valid. */
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

export function isIPv4(value: string): boolean {
	return IPV4.test(value);
}

/** Without a zone id ('fe80::1%eth0'), which names an interface on one machine, not an address. */
export function isIPv6(value: string): boolean {
	if (!value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) return false;
	try {
		new URL(`http://[${value}]/`);
		return true;
	} catch {
		return false;
	}
}

export function isIpAddress(value: string): boolean {
	return isIPv4(value) || isIPv6(value);
}

/**
 * The default platform for a username seen on a page: the page's host without "www.".
 * The app maps aliases (x.com and twitter.com are one platform) itself, so this sends the
 * host as it is and leaves one definition of "the same platform" in the app. Null when the
 * host would not pass the protocol's platform rule (an IP literal's brackets, or over 40
 * characters), so the user is asked instead of being sent a guess the app refuses.
 */
export function platformFromUrl(pageUrl: string | undefined): string | null {
	if (!pageUrl) return null;
	let host: string;
	try {
		host = new URL(pageUrl).hostname.toLowerCase();
	} catch {
		return null;
	}
	host = host.replace(/^www\./, '').replace(/\.$/, '');
	return PLATFORM.test(host) ? host : null;
}
