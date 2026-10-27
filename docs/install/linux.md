# Install on Linux

OSINT Copilot is available as an AppImage, a Debian package, and an RPM. Release binaries are
currently unsigned; compare the SHA-256 digest with the value on the
[release page](https://github.com/OSINT-Copilot/osint-copilot-releases/releases/latest).

## Choose a package

- AppImage: portable; x86-64 and arm64.
- `.deb`: Debian, Ubuntu, Mint, and derivatives; x86-64.
- `.rpm`: Fedora, RHEL, openSUSE, and derivatives; x86-64.

Install a package with the distribution's package manager:

```bash
sudo apt install ./osint-copilot_<version>_amd64.deb
sudo dnf install --nogpgcheck ./osint-copilot-<version>.x86_64.rpm
sudo zypper install --allow-unsigned-rpm ./osint-copilot-<version>.x86_64.rpm
```

The installed app is available from the application menu or at
`/opt/OSINT Copilot/osint-copilot`. The package configures its launcher and Chromium sandbox.

## AppImage

```bash
chmod +x osint-copilot-<version>-x86_64.AppImage
./osint-copilot-<version>-x86_64.AppImage
```

If FUSE 2 is unavailable, either install the distribution's FUSE 2 compatibility package or
run without mounting:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./osint-copilot-<version>-x86_64.AppImage
```

Ubuntu 24.04 and later may prevent Chromium from creating its user namespace. On first start,
OSINT Copilot extracts its runtime to `~/.cache/osint-copilot/app` and prints the exact command
needed to configure the sandbox helper:

```bash
sudo chown root:root ~/.cache/osint-copilot/app/chrome-sandbox
sudo chmod 4755 ~/.cache/osint-copilot/app/chrome-sandbox
```

Start the AppImage again afterward. Updates preserve an already approved sandbox helper. If you
remove the cache or the app asks again after a repair, repeat the command. `OC_SANDBOX=off` is
an emergency escape hatch, but captured web content and model output make the sandbox valuable.

OSINT Copilot defaults to X11/XWayland because Electron's native Wayland backend is unreliable
on some systems. Set `OC_OZONE=native` to keep the session's native backend.

## Data, logs, and removal

- Investigations remain wherever you created them.
- Application settings and pairing data are under `~/.config/OSINT Copilot`.
- Logs are under `~/.config/OSINT Copilot/logs`.
- AppImage and updater caches are under `~/.cache/osint-copilot` and
  `~/.cache/osint-copilot-updater`.

Remove installed packages with `apt remove osint-copilot`, `dnf remove osint-copilot`, or
`zypper remove osint-copilot`. For an AppImage, delete the AppImage. These operations preserve
the profile and investigations unless you remove them separately.

No licence key is required. For update behavior, see [Updates](../updates.md).
