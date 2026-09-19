// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Plain-language text for the protocol's error codes, and for the extension's own
 * failures, as the side panel shows them.
 */

const MESSAGES: Record<string, string> = {
	// Extension-side.
	malformed_pairing: 'That is not a pairing string. Copy the whole string that starts with "ocpair1." from OSINT Copilot\'s OSINT settings, under Browser extension.',
	unreachable: 'OSINT Copilot is not running, or "Accept items from the browser extension" is off. Items will be sent later.',
	unverified: 'Something answered on OSINT Copilot\'s port but could not prove it is your paired app. Nothing was sent to it.',
	pair_unreachable: 'Could not reach OSINT Copilot. Check that the app is running, that "Accept items from the browser extension" is on, and that the pairing string is the one it shows now.',
	not_paired: 'This extension is not paired with OSINT Copilot yet.',
	wrong_instance: 'The app that answered is not the one that showed this pairing string.',
	bad_proof: 'The app\'s reply to pairing did not check out. Nothing was stored; start a new pairing in the app.',
	bad_response: 'OSINT Copilot sent a reply this extension does not understand. Updating the extension or the app may help.',
	no_workspace: 'Choose an investigation first.',
	no_page: 'The extension cannot see which page you are on.',
	invalid_item: 'OSINT Copilot would refuse this item, so it was not queued.',
	item_gone: 'That item is no longer in the queue.',
	item_busy: 'That item is being sent right now, or is not waiting to be sent elsewhere. Try again in a moment.',
	workspace_changed: 'The investigation was changed in another window. Check the one chosen above, then send again.',
	queue_full: 'The send queue is full (100 items or 300 MB). Nothing was dropped; delete failed items or wait for the app to take the rest.',
	// Page capture.
	capture_permission_needed: 'Page capture needs Chrome\'s permission to read and save the pages you visit. Press Capture page in the side panel, or use the menu item or shortcut, and allow it when Chrome asks.',
	capture_permission_refused: 'Page capture was not allowed, so nothing was captured. It needs permission to read and save the pages you visit; you can allow it the next time you capture.',
	capture_browser_page: 'Chrome does not let extensions capture its own pages (chrome://, settings, other extensions) or the Chrome Web Store.',
	capture_not_web: 'Only web pages (http or https) can be captured into OSINT Copilot. This tab is not one.',
	capture_file_access: 'This is a file on your computer. Chrome lets extensions read files only when "Allow access to file URLs" is on for the extension in chrome://extensions, and OSINT Copilot accepts web pages (http or https) only.',
	capture_policy: 'Your organisation\'s browser policy does not allow extensions to read this site, so it cannot be captured.',
	capture_navigated: 'The tab went to another page while it was being captured, so the capture was dropped. Wait for the page to settle, then capture again.',
	capture_too_big: 'This page is too big to capture: the archive would be over the 50 MB OSINT Copilot accepts.',
	capture_tab_gone: 'The tab to capture was closed or could not be found.',
	capture_permission: 'Chrome did not let the extension read this page, so it cannot be captured.',
	capture_failed: 'Chrome could not capture this page.',
	capture_busy: 'A page is already being captured. Wait for it to finish.',
	blob_missing: 'The captured files are no longer stored in the browser (site data may have been cleared). Delete this item and capture the page again.',
	// Protocol codes (PROTOCOL.md §9).
	pair_expired: 'That pairing string has expired or was already used. Start a new pairing in the app and paste the new string.',
	pair_denied: 'Pairing was declined in OSINT Copilot.',
	bad_signature: 'The app refused the pairing proof. Check that you pasted the newest pairing string.',
	bad_origin: 'The app refused this extension\'s origin. If you paired a different copy of the extension, pair this one again.',
	unauthenticated: 'The app does not recognise this extension. If you revoked it in the app, pair again.',
	rate_limited: 'OSINT Copilot asked us to slow down. Will retry shortly.',
	unlicensed: 'OSINT Copilot has no active licence, so it is not accepting items. They will be sent once it is licensed.',
	unknown_workspace: 'That investigation is no longer available in OSINT Copilot.',
	invalid: 'OSINT Copilot refused the item as invalid.',
	budget_exceeded: 'That investigation\'s inbox is full (2 GB). Review pending items in the app; nothing is deleted to make room.',
	clock_skew: 'This computer\'s clock and OSINT Copilot\'s disagree by more than a minute.',
	replay: 'The app saw a repeated request. Will retry.',
	too_large: 'The item is too large for OSINT Copilot to accept.',
	hash_mismatch: 'The item was corrupted on the way to the app. Will retry.',
	bad_host: 'The app refused the request address.',
	bad_proto: 'This extension and OSINT Copilot speak different protocol versions. Update whichever is older.',
	internal: 'OSINT Copilot hit an internal error. Will retry.',
	unknown_bundle: 'OSINT Copilot no longer holds the partly sent capture. It will be sent again from the start.',
	conflict: 'OSINT Copilot is still receiving this capture on another connection. Will retry.',
	incomplete: 'OSINT Copilot is missing files of this capture. The missing ones will be sent again.',
};

export function describeError(code: string, detail?: string): string {
	const base = MESSAGES[code] ?? `OSINT Copilot replied "${code}".`;
	return detail ? `${base} (${detail})` : base;
}
