# OSINT Copilot

An OSINT investigation workspace built on local markdown notes.

OSINT Copilot is a **fork of [Tangent](https://github.com/suchnsuch/Tangent)** by Taylor Hadden,
used under the Apache License 2.0. Tangent provides the note-writing workspace — the editor, file
tree, link index, query language, viewers and app shell. OSINT Copilot adds the investigation
toolset on top of it. See [NOTICE](./NOTICE) for attribution and a statement of changes.

## What it adds to Tangent

* **Entities and connections** as plain markdown notes, with an FTM / OIDSF schema system
  (141 bundled entity and relationship types, plus user-defined ones).
* **Entity graph** — a Cytoscape canvas with multiple graph workspaces, confidence filtering,
  undo/redo history and saved layouts.
* **Timeline** and **map** views derived from the same notes.
* **Chat agent** driving a local CLI runtime (Claude Code, Codex, or a custom one) that can read
  the vault, propose graph operations, and apply them on approval.
* **Enrichers** — user-authored HTTP integrations with a per-enricher domain allowlist,
  secrets resolved in the main process, and an SSRF guard.
* **Skills** and **task agents** — vault-authored, schema-constrained agents with a double
  write allowlist.

Everything is stored as markdown and YAML under an `OSINTCopilot/` folder in your workspace,
so the same folder can also be opened by the
[Obsidian plugin](https://github.com/Probe-Point-Analytics-LLC/Obsidian-OSINT-Copilot-plugin)
this project grew out of.

## Repository layout

Inherited from Tangent's monorepo.

### Applications
* [tangent-electron](./apps/tangent-electron/README.md) — the Electron application. OSINT Copilot's
  own code lives under `src/osint/` (renderer) and `src/main/osint/` (main process).
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

## Building locally

1. `git submodule init && git submodule update`
2. `npm ci` at the repository root.
3. `npm run build` at the root (or `npm run build:tangent-electron` for just the app).
4. `npm run dev` in `./apps/tangent-electron` (`dev:win` on Windows).

### Linux

See [Running on Linux](./Documentation/Running%20on%20Linux.md) for installing and running
the released AppImage or .deb, and for the three things that reliably go wrong: the Wayland
crash, FUSE, and Chromium's sandbox under AppArmor.

`npm run start` handles all three for you while developing. The notes below cover the rest.

### Linux: blank window or an immediate crash

If the app dies the moment it opens a window, your system's Wayland backend may not work with
Electron's renderer. Force the X11 backend:

```
npm run dev -- --ozone-platform=x11
# or, running the built app directly:
electron . --ozone-platform=x11
```

Also make sure `ELECTRON_RUN_AS_NODE` is not exported in your shell — it silently makes the
Electron binary run as plain Node, so no window ever opens and `electron --version` prints the
Node version.

## Staying current with upstream

`upstream` points at `suchnsuch/Tangent`. The fork deliberately keeps its edits to upstream files
small — new code goes in new directories — so `git merge upstream/main` stays cheap. Before adding
a line to a file under `apps/tangent-electron/src/{app,common,main,preload}/`, check whether a new
file under `src/osint/` would do instead.

## License

Apache License 2.0. See [LICENSE.txt](./LICENSE.txt) and [NOTICE](./NOTICE).
