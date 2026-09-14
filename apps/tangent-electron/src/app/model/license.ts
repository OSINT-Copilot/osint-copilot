import { writable, derived, get, type Readable } from 'svelte/store'

import {
	NO_ENTITLEMENTS,
	tierAtLeast,
	type AppTier,
	type Entitlements,
	type LicenseStatus,
} from 'common/license'

/**
 * The current licence, for anything in the renderer that needs to know what the user paid
 * for.
 *
 * A store rather than a prop because entitlements are read far from where the licence is
 * checked -- a button deep in a settings panel, a command's `canExecute` -- and threading
 * the status down to each of those would touch every component in between.
 *
 * Set once from App.svelte when main answers, and again whenever a key is activated or
 * refreshed. Nothing else writes to it.
 *
 * ## This is presentation, not enforcement
 *
 * Everything here runs in the renderer, where a determined user can change it. It exists
 * to keep the interface honest -- to grey out and explain what a plan does not include,
 * rather than to offer something that then fails. Anything that actually costs money is
 * enforced by the dashboard, which counts credits against the key on every request.
 */

const status = writable<LicenseStatus | null>(null)

/** The whole status. Null until main has answered. */
export const licenseStatus: Readable<LicenseStatus | null> = { subscribe: status.subscribe }

export function setLicenseStatus(next: LicenseStatus | null) {
	status.set(next)
}

/**
 * What the user may do.
 *
 * Nothing, while the status is unknown or invalid. Defaulting closed matters: the window
 * renders for a moment before main answers, and a default of "everything" would flash the
 * full interface at someone who is about to be shown the licence gate.
 */
export const entitlements: Readable<Entitlements> = derived(
	status,
	$status => $status?.valid ? ($status.entitlements ?? NO_ENTITLEMENTS) : NO_ENTITLEMENTS,
)

export const tier: Readable<AppTier | null> = derived(
	status,
	$status => $status?.valid ? ($status.tier ?? null) : null,
)

/** Reactive check. `$can('graphAutomation')` in a component. */
export const can: Readable<(feature: keyof Entitlements) => boolean> = derived(
	entitlements,
	$entitlements => (feature: keyof Entitlements) => $entitlements[feature] === true,
)

/** One-shot check, for imperative code such as a command's `canExecute`. */
export function hasEntitlement(feature: keyof Entitlements): boolean {
	return get(entitlements)[feature] === true
}

/** One-shot tier check, e.g. `atLeastTier('premium')`. */
export function atLeastTier(minimum: AppTier): boolean {
	return tierAtLeast(get(tier) ?? undefined, minimum)
}

/**
 * The sentence to show where a feature is unavailable.
 *
 * Centralised so every locked control says the same thing and names the tier that unlocks
 * it, rather than each one inventing its own wording.
 */
export function upgradeMessage(feature: keyof Entitlements): string {
	const needed: Record<keyof Entitlements, AppTier> = {
		osint: 'basic',
		chat: 'basic',
		graphAutomation: 'basic',
		customModels: 'premium',
		localAgent: 'premium',
	}
	const label: Record<keyof Entitlements, string> = {
		osint: 'The OSINT tools are',
		chat: 'The chat view is',
		graphAutomation: 'AI entity extraction is',
		customModels: 'Custom model endpoints are',
		localAgent: 'The local agent is',
	}
	const tierName = needed[feature] === 'premium' ? 'Premium' : 'Basic'
	return `${label[feature]} not included in your plan. Upgrade to ${tierName} to use it.`
}
