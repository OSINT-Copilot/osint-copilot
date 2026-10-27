OSINT Copilot currently publishes updates on the stable channel only. The update controls are
in the [[System Menu]].

# Checking for Updates

With **Automatically Check for Updates** enabled, a packaged build checks the OSINT Copilot
GitHub release feed when a window receives focus, at most once every 24 hours. Choose **Check
for Updates** to check immediately. Disabling automatic checks does not disable the manual
check.

# Installing an Update

Windows Setup and Linux AppImage builds download a compatible update and install it when the
app quits, or when you choose **Quit and Update**. A Windows portable build does not replace
itself; the Updates page opens the latest release so you can download a new portable executable.

Debian and RPM packages may require system authentication. If installation from the app fails,
download the package from the
[official releases page](https://github.com/OSINT-Copilot/osint-copilot-releases/releases/latest)
and install it with your package manager.

Source builds and unsupported package types should update from Git. Release binaries are
currently unsigned, so compare downloads with the SHA-256 digest published on the release page.
