// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Guesses what kind of entity a selection is, for the side panel's entity form.
 *
 * A guess, which the user can override, so it is tuned to two rules. First, whatever it
 * returns passes the app's check for that kind (validate.ts), so a suggestion is never one
 * the app refuses. Second, when it cannot tell, it says so (null) rather than filing the
 * text under the most permissive kind: a near-miss wallet address, a broken checksum or a
 * bare number is not quietly offered as a username.
 *
 * The value is the selection with control characters removed and surrounding whitespace
 * trimmed, and otherwise as selected: the app computes identifier keys itself
 * (lowercasing, punycode, digit-only phones), so normalising here would only lose what
 * the investigator saw.
 */
import { LIMITS, type EntityKind, type WalletChain } from './protocol';
import { isIPv4, isIPv6, isHttpUrl } from './url';
import { checkEntityValue, isDomain, isEmail, isPhone, isValidBtcAddress, isValidEthAddress, stripControlChars } from './validate';

export interface Classified {
	kind: EntityKind;
	chain?: WalletChain;
	value: string;
}

/** Shapes that are plainly meant as addresses on a chain we check. Failing the check means a typo. */
const LOOKS_ETH = /^0x[0-9a-fA-F]{30,}$/;
const LOOKS_BTC = /^(?:[13][1-9A-HJ-NP-Za-km-z]{24,34}|(?:bc|tb|BC|TB)1[0-9A-Za-z]{6,87})$/;

/**
 * Chains we cannot checksum but whose addresses announce themselves: Cardano, Litecoin
 * SegWit, BNB Beacon, Cosmos-SDK chains, Tezos, Kaspa, Bitcoin Cash's cashaddr form, and
 * Tron's T-prefixed Base58. Anything else chain-shaped is left for the user to label.
 */
const OTHER_CHAIN = [
	/^(?:addr1|stake1|ltc1|bnb1|cosmos1|osmo1|terra1)[0-9a-z]{20,}$/,
	/^tz[123][1-9A-HJ-NP-Za-km-z]{33}$/,
	/^(?:kaspa|bitcoincash):[0-9a-z]{40,}$/,
	/^T[1-9A-HJ-NP-Za-km-z]{33}$/,
];

/** An optional @, then letters (any script), digits, _ . -; and at least one letter. */
const USERNAME = /^@?[\p{L}\p{N}_.-]{1,64}$/u;

export function classify(raw: string): Classified | null {
	if (typeof raw !== 'string') return null;
	const value = stripControlChars(raw).trim();
	if (!value || value.length > LIMITS.entityValue) return null;
	const found = guess(value);
	// The invariant this module promises; a mismatch is a bug here, not the user's problem.
	if (found && checkEntityValue(found.kind, found.value, found.chain) !== null) return null;
	return found;
}

function guess(value: string): Classified | null {
	if (/^https?:\/\//i.test(value)) return isHttpUrl(value) ? { kind: 'url', value } : null;
	if (isEmail(value)) return { kind: 'email', value };
	// Before phone: "192.0.2.1" is also seven digits and dots.
	if (isIPv4(value) || isIPv6(value)) return { kind: 'ip', value };

	if (LOOKS_ETH.test(value)) return isValidEthAddress(value) ? { kind: 'wallet', chain: 'eth', value } : null;
	if (isValidBtcAddress(value)) return { kind: 'wallet', chain: 'btc', value };
	if (LOOKS_BTC.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value) && value.length >= 26) return null;
	if (OTHER_CHAIN.some(re => re.test(value))) return { kind: 'wallet', chain: 'other', value };

	// Digits and dots alone read as a version or a mistyped address, not a phone number.
	if (!/^[\d.]+$/.test(value) && isPhone(value) && (value.startsWith('+') || value.replace(/\D/g, '').length >= 7)) {
		return { kind: 'phone', value };
	}
	// A domain needs a real top-level label (letters, or punycode), not "1.2.3".
	if (isDomain(value) && /(?:^|\.)(?:[\p{L}]{2,63}|xn--[a-z0-9-]+)\.?$/iu.test(value)) return { kind: 'domain', value };
	if (USERNAME.test(value) && /\p{L}/u.test(value)) return { kind: 'username', value };
	return null;
}
