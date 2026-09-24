# OSINT Copilot

An OSINT investigation workspace built on local markdown notes.

OSINT Copilot is a **fork of [Tangent](https://github.com/suchnsuch/Tangent)** by Taylor Hadden,
used under the Apache License 2.0. Tangent provides the note-writing workspace — the editor, file
tree, link index, query language, viewers and app shell. OSINT Copilot adds the investigation
toolset on top of it. See [NOTICE](./NOTICE) for attribution and a statement of changes.

## What it adds to Tangent

* **Entities and connections** as plain markdown notes, with an FTM / OIDSF schema system
  (141 bundled entity and relationship types, plus user-defined ones). Each records its sources
  and a confidence level derived from them (unverified to conflicted) in its front matter.
* **Entity graph** — a Cytoscape canvas with multiple graph workspaces, undo/redo history and
  saved layouts.
* **Timeline** and **map** views derived from the same notes.
* **Chat agent** driving a local CLI runtime (Claude Code, Codex, or a custom one) that can read
  the vault, propose graph operations, and apply them on approval.
* **Enrichers** — user-authored HTTP integrations with a per-enricher domain allowlist,
  secrets resolved in the main process, and an SSRF guard.
* **Skills** and **task agents** — vault-authored, schema-constrained agents with a double
  write allowlist.
* **Browser extension** — sends notes, entities, page captures and highlights from web pages
  into an investigation, over an authenticated channel to the app on the same computer.

[demo/](./demo/README.md) holds *Operation Northgate*, a fictional investigation that uses all of
it.

Everything is stored as markdown and YAML under an `OSINTCopilot/` folder in your workspace,
so the same folder can also be opened by the
[Obsidian plugin](https://github.com/Probe-Point-Analytics-LLC/Obsidian-OSINT-Copilot-plugin)
this project grew out of.

## Repository layout

Inherited from Tangent's monorepo.

### Applications
* [tangent-electron](./apps/tangent-electron/README.md) — the Electron application. OSINT Copilot's
  own code lives under `src/osint/` (renderer) and `src/main/osint/` (main process).
* [osint-copilot-extension](./apps/osint-copilot-extension/README.md) — the browser extension
  (Chrome and other Chromium browsers).
* [tangent-website](./apps/tangent-website/README.md) — upstream's website source.
* [tangent-test-workspace-generator](./apps/tangent-test-workspace-generator/README.md) — CLI tool for
  generating test content.

### Packages
* [tangent-html-to-markdown](./packages/tangent-html-to-markdown/README.md) — converts `text/html`
  clipboard data to markdown.
* [tangent-query-parser](./packages/tangent-query-parser/README.md) — parser for the query language.

### Lib
Git submodules.
* [typewriter](./lib/typewriter/README.md) — Tangent's fork of
  [Typewriter](https://github.com/typewriter-editor/typewriter).
* [typewriter-document](./lib/typewriter-document/README.md) — Tangent's fork of Typewriter's
  document model.

## Running the released app

Builds are at
[osint-copilot-releases](https://github.com/OSINT-Copilot/osint-copilot-releases/releases/latest):
an **AppImage** (portable, x64 and arm64) and a **.deb**. Windows installers exist for 0.14.0;
0.14.1 and 0.14.4 are Linux-only fixes, so Windows users should take 0.14.0. There is no macOS
build.

### The .deb

```bash
sudo apt install ./osint-copilot_0.14.4_amd64.deb
```

Then start it from the applications menu. The package installs an AppArmor profile granting the
user namespace its Chromium sandbox needs, and its menu entry carries the X11 switch, so it needs
neither of the workarounds the AppImage performs. From a terminal:

```bash
"/opt/OSINT Copilot/osint-copilot"
```

### The AppImage

```bash
chmod +x osint-copilot-0.14.4-x86_64.AppImage
./osint-copilot-0.14.4-x86_64.AppImage
```

On most systems that is all. On **Ubuntu 24.04 and later** the first start unpacks the
application to `~/.cache/osint-copilot/app` and then stops, because Ubuntu does not let an
application that is not installed set up the Chromium sandbox. It prints one command:

```bash
sudo chown root:root ~/.cache/osint-copilot/app/chrome-sandbox && sudo chmod 4755 ~/.cache/osint-copilot/app/chrome-sandbox
```

Run it once and start the app again. Every later start, and every upgrade, works with a full
sandbox and needs nothing further.

Why not just run without the sandbox: this application renders captured web pages, enricher
responses and model output, so the renderer sandbox is doing real work. If you would rather have
it anyway, `OC_SANDBOX=off ./osint-copilot-0.14.4-x86_64.AppImage` starts without it.

The app also restarts itself once with the X11 backend on a Wayland session, because Electron's
Wayland backend crashes as it opens a window on some systems; `OC_OZONE=native` opts out.

If the AppImage will not mount at all — `Cannot mount AppImage, please check your FUSE setup` —
run `APPIMAGE_EXTRACT_AND_RUN=1 ./osint-copilot-0.14.4-x86_64.AppImage`, or install `libfuse2`.

On first run the app asks for a licence key, and takes either a subscription key or an offline
`OSINT-...` key.

### Installing the browser extension

`osint-copilot-extension-<version>.zip` is on the same release page. It runs in Chrome 140+ and
other Chromium browsers — Edge, Brave and Helium — and there is **no Firefox build**: page
capture is built on `chrome.pageCapture`, which Firefox does not have. `STORE.md` in the
extension's folder says what a port would involve.

It is not in a web store yet, so install it by hand: unzip it somewhere permanent (deleting the
folder uninstalls it), open `chrome://extensions`, turn on **Developer mode**, and choose **Load
unpacked**. From a source build, load `apps/osint-copilot-extension/dist` instead, after
`npm run build` there.

Then pair it: in the OSINT settings, under **Browser extension**, turn on **Accept items from
the browser extension**, choose **Pair new extension**, and paste the `ocpair1.` string it shows
into the extension's side panel. [Browser Extension](./Documentation/Browser%20Extension.md) has
the rest — what you can send, where it lands, and what stays private.

## Building and running from source

1. `git submodule init && git submodule update`
2. `npm ci` at the repository root.
3. `npm run build` at the root (or `npm run build:tangent-electron` for just the app).
4. `cd apps/tangent-electron && npm run start`

`npm run start` goes through `scripts/launch.mjs`, which handles the three Linux problems for
you: it defaults to the X11 backend, falls back to `--no-sandbox` (loudly) where AppArmor blocks
the sandbox, and strips `ELECTRON_RUN_AS_NODE`. That variable, if you have it exported, silently
makes the Electron binary run as plain Node — no window ever opens, and `electron --version`
prints the Node version.

While working on the app, `npm run dev` (`dev:win` on Windows) rebuilds as you edit. It does not
go through that launcher, so on Linux pass the flag yourself:

```bash
npm run dev -- --ozone-platform=x11
```

If the build is killed part-way it ran out of memory; give it more with
`NODE_OPTIONS=--max-old-space-size=4096`.

### Running without a licence key

A **development** build starts without a key when `OSINT_SKIP_LICENSE=1` is set:

```bash
npm run build:dev                       # in apps/tangent-electron
OSINT_SKIP_LICENSE=1 npm run start
```

`npm run dev` builds in development mode too, so `OSINT_SKIP_LICENSE=1 npm run dev` works the
same way; the integration test harness sets the variable itself. The check is compiled into a
production build, so there the variable does nothing and the key is asked for whatever the
environment says: a shipped application must never treat an environment variable as a way past
the gate.

### Packaging your own installers

```bash
cd apps/tangent-electron && npm run package:linux
```

The AppImage and .deb land in `apps/tangent-electron/dist/`, and nothing is uploaded.

### Releasing

A release starts with a `Release X.Y.Z` commit on `main` — the version in
`apps/tangent-electron/package.json`, `OSINT_VERSION` in `src/osint/version.ts`, and a
`Documentation/Changelog/vX.Y.Z.md` — and a pushed `vX.Y.Z` tag.

That tag runs [`.github/workflows/release.yml`](./.github/workflows/release.yml), which tests on
macOS and then builds on all three platforms natively. The same workflow can be started by hand
(**Actions → Release → Run workflow**) to build a branch without minting a version.

What it does with the builds depends on one secret:

* **`RELEASES_TOKEN` set** — each platform publishes into a **draft** release in the public
  `OSINT-Copilot/osint-copilot-releases` repository, which is where the in-app updater looks.
  Nothing reaches users until that draft is published by hand. The token has to be a personal
  access token with contents:write on *that* repository; the automatic `GITHUB_TOKEN` is scoped
  to this one and cannot write there.
* **not set** — each platform only packages, and the installers are attached to the workflow
  run for 14 days. That is the mode to stay in while the builds are unsigned.

Releases can also be built by hand, which is how every release so far was made:
`npm run build:tangent-electron` at the root, then `GH_TOKEN=... npm run publish:linux` in
`apps/tangent-electron`. macOS cannot be built this way from Linux at all.

#### Code signing

Both platforms that need it are switchable, and off until the secrets exist:

| Secret | Effect |
|---|---|
| `APPLE_CSC_LINK`, `APPLE_CSC_KEY_PASSWORD` | Signs the macOS build with a Developer ID certificate (base64 `.p12` and its password). |
| `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_ID_PASSWORD` | Notarizes it, through `build/after-sign.js`. |
| `AZURE_KEY_VAULT_URL`, `AZURE_CERT_NAME`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` | Signs the Windows build through AzureSignTool, in `build/sign-windows.js`. |

Without them the build is unsigned rather than broken. Unsigned installers do run, with
consequences worth knowing: Windows SmartScreen warns until a download reputation builds, macOS
refuses to open the app without a trip through Privacy & Security, and electron-updater cannot
update an unsigned macOS app at all. So unsigned builds are for testing on those platforms, not
for publishing.

Upstream's `build/jsign.js` and `build/notarize.js` are left untouched: the first signs against
Tangent's own YubiKey, and the second fails a build when Apple's credentials are absent. Our two
hooks above wrap that behaviour instead of editing theirs.

## Staying current with upstream

`upstream` points at `suchnsuch/Tangent`. The fork deliberately keeps its edits to upstream files
small — new code goes in new directories — so `git merge upstream/main` stays cheap. Before adding
a line to a file under `apps/tangent-electron/src/{app,common,main,preload}/`, check whether a new
file under `src/osint/` would do instead.

## License

Apache License 2.0. See [LICENSE.txt](./LICENSE.txt) and [NOTICE](./NOTICE).
