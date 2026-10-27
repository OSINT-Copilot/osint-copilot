# Build on macOS

There is no supported macOS binary yet. The current community-supported path is to build the
app from source. The resulting app is unsigned, unnotarized, and does not self-update.

## Prerequisites

- macOS with Xcode Command Line Tools
- Node.js 22 and npm
- Git and about 2 GB of free disk space

## Build and run

```bash
xcode-select --install
git clone --recurse-submodules https://github.com/OSINT-Copilot/osint-copilot.git
cd osint-copilot
npm ci
npm run build:tangent-electron
cd apps/tangent-electron
npm run start
```

No licence key is required.

To make an unsigned universal `.dmg` and `.zip`, run:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac
```

Artifacts are written to `apps/tangent-electron/dist`. Icon composition may require a recent
Xcode; `build/icon.icns` is the fallback icon source for local packaging.

Because the build is unsigned, macOS may require **Control-click → Open** or approval under
**System Settings → Privacy & Security**. Disable automatic update checks: official releases do
not currently publish a signed macOS update feed.

Application data is normally under `~/Library/Application Support/OSINT Copilot`. Your
investigations remain in the folders you selected. Please report reproducible macOS build issues
through the repository, noting the macOS, Xcode, Node, and CPU architecture versions.
