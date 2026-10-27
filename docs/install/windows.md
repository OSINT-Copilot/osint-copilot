# Install on Windows

OSINT Copilot supports Windows 10 and later. The release page provides one x64/arm64 Setup
executable and one portable executable. No separate runtime is required.

## Verify the download

Release binaries are currently unsigned, so Microsoft Defender SmartScreen may show **Windows
protected your PC**. Compare the file's SHA-256 hash with the digest on the
[release page](https://github.com/OSINT-Copilot/osint-copilot-releases/releases/latest):

```powershell
Get-FileHash '.\OSINT-Copilot-Setup-<version>.exe' -Algorithm SHA256
```

If the digest matches, choose **More info → Run anyway** in SmartScreen.

## Setup or portable

The Setup executable installs per user by default under
`%LOCALAPPDATA%\Programs\OSINT Copilot`, adds Start-menu shortcuts, and offers OSINT Copilot as
an alternate viewer for supported files. It does not replace existing file associations.

The portable executable runs without installing, creates no shortcuts or file associations,
and unpacks to a temporary directory at each start. Keep it in a stable location. Portable
builds do not install updates in place; download a newer portable executable when one is
released.

No licence key is required. Choose or create an investigation folder when the app opens.

## Data and logs

- Investigations remain wherever you created them.
- **Setup build:** application settings, workspace history, documentation, and
  browser-extension pairing data are under `%APPDATA%\OSINT Copilot`; logs are under
  `%APPDATA%\OSINT Copilot\logs`.
- **Portable build:** the same profile lives in a `.tangent_config` folder next to the
  portable executable, so keep the executable in a folder you can write to. Browser session
  data (cache, cookies for embedded pages) still goes under `%APPDATA%`.

Uninstalling the Setup build leaves these files and your investigations intact. To reset the
application profile, close OSINT Copilot and remove it explicitly:

```powershell
# Setup build
Remove-Item -Recurse -LiteralPath "$env:APPDATA\OSINT Copilot"
# Portable build: run in the folder that holds the portable executable
Remove-Item -Recurse -LiteralPath '.\.tangent_config'
```

That also revokes local extension pairings. It does not remove investigation folders.

## Uninstall

For the Setup build, use **Settings → Apps → Installed apps → OSINT Copilot → Uninstall**. For
the portable build, delete its executable and the `.tangent_config` folder beside it. See
[Privacy and data](../privacy-and-data.md) before removing profile or investigation data.
