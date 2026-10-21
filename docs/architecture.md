# Architecture

OSINT Copilot is an npm-workspace monorepo based on Tangent.

- `apps/tangent-electron`: Electron main process, preload, Svelte renderer, packaging, and tests.
- `apps/tangent-electron/src/osint`: renderer-side investigation features.
- `apps/tangent-electron/src/main/osint`: privileged investigation services, extension server,
  inbox, and network/process guards.
- `apps/osint-copilot-extension`: Manifest V3 Chromium extension.
- `packages/tangent-*`: editor support packages inherited from Tangent.
- `lib/typewriter*`: MIT-licensed Git submodules used by the editor.
- `Documentation`: the help workspace bundled into the desktop app.
- `demo`: a generated fictional investigation and screenshots.
- `tools/triage-eval`: an offline research/evaluation harness; it is not shipped.

The app build in `apps/tangent-electron/build/index.js` bundles main, preload, and renderer code
into `__build/` and zips `Documentation/`. Electron Builder then creates platform packages from
`electron-builder.json`.

Investigation records are Markdown and YAML under `OSINTCopilot/`. The renderer uses an Obsidian
compatibility shim for code ported from the earlier plugin. The extension protocol is specified
in `apps/tangent-electron/src/main/osint/extension/PROTOCOL.md`; test vectors are shared by the
desktop and extension suites.

Keep new investigation behavior in the OSINT-specific directories when practical. Changes to
the inherited editor core should stay small so upstream Tangent updates remain reviewable.
