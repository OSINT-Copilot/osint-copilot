# Updates

Official builds check GitHub releases in
[`OSINT-Copilot/osint-copilot-releases`](https://github.com/OSINT-Copilot/osint-copilot-releases).
The feed location is embedded in each build.

Production builds check when a window receives focus, at most once every 24 hours, if automatic
checks are enabled. You can also use **Settings → Updates → Check for updates**. Stable is the
only supported channel at present.

## Package behavior

- Windows Setup and Linux AppImage builds download a compatible update and install it when the
  app quits, or when you choose **Quit and update**.
- Windows portable builds do not update in place. The app links to the release page; download
  and replace the portable executable manually.
- Debian and RPM builds may require system authentication to install an update. If the in-app
  installation fails, download the package and install it with `apt`, `dnf`, or `zypper`.
- Source builds and unsigned macOS builds should disable automatic checks and update from Git.

Never download an installer from a link shown inside investigation content. Use the project's
release page and verify the published SHA-256 digest. Release metadata files and blockmaps are
part of the update feed and must remain attached to each published release.
