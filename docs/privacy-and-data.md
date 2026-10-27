# Privacy and data

OSINT Copilot is local-first: investigations are folders you choose, and the app has no hosted
case database. Local-first does not mean network-free. The following features can contact other
services.

## Network connections

| Feature | Destination and trigger | Control |
| --- | --- | --- |
| Updates | GitHub release and asset hosts when a packaged app checks the stable feed; automatic checks run on window focus at most once every 24 hours | Disable automatic checks under **Settings → Updates**; manual checks still work |
| Online map | OpenFreeMap tile service while viewing a map | Select no online basemap or a local PMTiles source in OSINT settings |
| Geocoding | The Nominatim-compatible service you configure; address and coordinate queries are sent to its operator | Disabled by default. Enter an operator-approved endpoint under **Settings → OSINT Copilot → Map → Geocoding service**; remote endpoints must use HTTPS, while loopback HTTP is allowed |
| Wayback availability | Internet Archive CDX for HTTP(S) source URLs | Extension-originated items are off by default; control them per investigation |
| Link previews | The linked site when you hover a normal web link | Avoid hovering sensitive links; Evidence and Sources notes suppress previews |
| YouTube embeds | YouTube when an embed is displayed | Do not open the embed |
| Miro import | Miro API only when you request an import | Do not configure or invoke Miro import |
| Enrichers | Domains declared by the selected enricher | Review the enricher and approve each run |
| AI runtimes | Whatever service the separately installed CLI uses | Leave runtimes unconfigured; review [AI runtimes](ai-runtimes.md) |

OSINT Copilot does not start Electron's network crash reporter or upload crash dumps. Premium
licensing is dormant: no key is required, stored keys are not read, and the app does not contact
the licence server. The browser extension connects to the app only on `127.0.0.1`; capturing a
PDF may fetch that exact PDF URL again with browser cookies.

## Investigation data

An investigation can contain:

- `.tangent/`: workspace presentation and state;
- `.osint-copilot/data.json`: investigation settings, including a configured Miro token and
  geocoding endpoint;
- `.osint-inbox/`: extension delivery records;
- `OSINTCopilot/`: entities, connections, sources, evidence, conversations, boards, schemas,
  prompts, skills, enrichers, task agents, and outputs; and
- `OSINTCopilot/custom/credentials/`: plain-text enricher credentials.

Sharing or syncing an investigation shares all of those files unless you exclude them. Remove
credentials and tokens, inspect evidence metadata, and review logs before handing a case to
someone else.

## Application profile

The profile contains settings, workspace history, logs, extracted help, update state, and
browser-extension pairing material:

- Windows: `%APPDATA%\OSINT Copilot` (the portable build: `.tangent_config` next to its `.exe`)
- Linux: `~/.config/OSINT Copilot`
- macOS: `~/Library/Application Support/OSINT Copilot`

Linux AppImage caches also use `~/.cache/osint-copilot` and
`~/.cache/osint-copilot-updater`. Pairing secrets use the operating-system keychain where
available and fall back to local storage when it is not.

An older release may have left `license.json` in the profile. The current open-source build
leaves that file unread and untouched; you can remove it while the app is closed if you no
longer need it.

Removing the application does not delete investigations or the profile. Back up first, close
the app, and remove only the specific folder you intend to reset.
