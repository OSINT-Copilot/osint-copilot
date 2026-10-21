/**
 * One deliberate switch for the dormant premium/licensing implementation.
 *
 * `false` is the open-source product: no key is needed, every entitlement is on,
 * the licence gate and settings page are hidden, the licence server is never
 * contacted, and any existing license.json is left unread and untouched.
 *
 * Setting this to `true` restores the licensing behaviour retained in the app.
 */
export const PREMIUM_LICENSING_ENABLED = false
