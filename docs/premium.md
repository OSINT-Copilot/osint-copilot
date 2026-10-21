# Premium status

Premium licensing is dormant. All current OSINT Copilot features are available without a key,
the Licence settings page is hidden, and the application does not contact the licence server.

The verification, subscription, and entitlement code remains in the repository behind the
compile-time `PREMIUM_LICENSING_ENABLED` switch in
`apps/tangent-electron/src/common/premium.ts`. Keeping it makes the transition explicit and
testable without creating a runtime back door.

If an earlier version stored a key in the application profile, free mode leaves that file in
place but does not read, validate, transmit, or delete it. You may remove the profile yourself
if you want to erase it.

Any future paid service must provide server-side value and be documented before activation.
Because this client is open source, a client-only feature gate cannot be treated as security or
effective enforcement. No future plan, price, or activation date is promised here.
