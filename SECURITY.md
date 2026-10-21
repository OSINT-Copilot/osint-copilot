# Security policy

## Supported versions

Security fixes target the latest published release. Older releases may be used to reproduce an
issue, but users should update once a fix is available.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/OSINT-Copilot/osint-copilot/security/advisories/new).
Do not open a public issue, discussion, or pull request for a vulnerability that has not been
coordinated with the maintainers.

Include, where applicable:

- the OSINT Copilot and OS versions;
- package type (Setup, portable, AppImage, Debian, RPM, macOS source build, or extension);
- extension and browser versions;
- reproduction steps and security impact;
- a minimal proof of concept using synthetic data; and
- a relevant, redacted log excerpt.

Do not upload real case material, credentials, pairing strings, licence keys, private keys, or
unredacted profile archives. GitHub privately notifies repository maintainers when the report is
submitted. Maintainers will acknowledge it, assess scope, coordinate a fix and disclosure, and
credit reporters who want public credit.

## Scope

The desktop main process, sandboxed renderer, preload bridge, extension pairing and signed
protocol, guarded network/process services, updater, package integrity, and local secret
handling are in scope. A vulnerability in an investigation-supplied enricher or skill is in
scope when project code fails to enforce its documented boundary.

Third-party AI-provider behavior, a malicious program already running as the same operating-
system user, and unsupported modifications are generally outside the project's control, though
we still welcome reports showing that OSINT Copilot unnecessarily increases their access.

## Known security-sensitive choices

- Linux users can explicitly set `OC_SANDBOX=off`; this reduces renderer isolation and is not
  recommended.
- Enricher credentials are plain files inside an investigation.
- Extension secrets use the OS keychain where available and a local fallback otherwise.
- Crash reporting is disabled.

See [Privacy and data](docs/privacy-and-data.md) and the
[extension privacy policy](apps/osint-copilot-extension/PRIVACY.md).
