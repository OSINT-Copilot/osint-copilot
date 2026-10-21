# Releasing

This page is for maintainers. A release must not be published until its installers, update from
the previous release, licence/notice files, and first-run behavior have been tested.

1. Update the app version in `apps/tangent-electron/package.json` (and `package-lock.json`), the
   OSINT-layer version `OSINT_VERSION` in `apps/tangent-electron/src/osint/version.ts`, and add
   `Documentation/Changelog/vX.Y.Z.md`. The release tag must be exactly
   `vX.Y.Z` for the desktop app version. The extension has its own version and artifact name.
2. Run unit tests, OSINT type checks, the production build, and end-to-end tests. Build and test
   the extension zip separately.
3. Commit with `Release X.Y.Z: <summary>` and create the annotated tag `vX.Y.Z`.
4. Let the release workflow package the Linux and Windows (x64 and arm64) artifacts. A manual workflow run builds,
   verifies, and checksums artifacts but never publishes them. Only a matching pushed version tag
   can run the final publisher. Build and dependency-install jobs receive no credentials; the
   cross-repository token is exposed only to the final publish step.
5. Review the draft in `OSINT-Copilot/osint-copilot-releases`. It is the permanent feed embedded
   in existing installations and must not be deleted or replaced without a bridge release.
6. Confirm the draft contains every AppImage, Debian and RPM package, Windows Setup and portable
   executable, each blockmap produced, all `latest*.yml` files, the extension zip, the demo
   investigation zip, and `SHA256SUMS.txt`. The workflow verifies the per-platform checksums before creating that manifest.
7. Test the previous-to-current update in clean Windows and Linux VMs. Test Setup, portable,
   AppImage, Debian, and RPM behavior separately; do not infer one package's behavior from
   another.
8. Publish only after the feed metadata names files that actually exist in the release.

macOS must remain absent from the official feed until signed and notarized builds and a tested
update path exist. Never commit certificate material, tokens, the offline licence-signing key,
or values from maintainer environments.
