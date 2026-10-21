OSINT Copilot is local-first, but some features can make network requests.

# Network Connections

* **Updates** — Packaged builds check the OSINT Copilot GitHub release feed when a window
  receives focus, at most once every 24 hours, if automatic checks are enabled. You can disable
  automatic checks or start a check yourself under [[Updates]]. Only stable releases are used.
* **Maps** — The online basemap loads tiles from OpenFreeMap by default. In the OSINT Copilot
  settings, choose no online basemap, use a local PMTiles file, or configure a different tile
  provider.
* **Geocoding** — Geocoding is disabled until you enter an operator-approved,
  Nominatim-compatible service under **Settings > OSINT Copilot > Map > Geocoding service**.
  Address and coordinate queries go to that operator. Remote services must use HTTPS; HTTP is
  allowed only for a loopback service on this computer.
* **Wayback checks, link previews, and embeds** — These contact the Internet Archive or the
  linked site when used. Wayback checks for browser-extension items are off by default, and
  Evidence and Sources notes suppress link previews.
* **Optional integrations** — Miro import, enrichers, and AI command-line runtimes contact only
  the services you configure or invoke. Review their destinations and data policies first.
* **Browser extension** — The extension delivers items to the app over `127.0.0.1`. Capturing a
  PDF can fetch that exact PDF address again with the browser's cookies.

# What Is Not Sent

Automatic crash reporting is disabled: OSINT Copilot does not start Electron's network crash
reporter or upload crash dumps. Premium licensing is dormant, so no licence key is required and
the app does not contact a licence server.

Investigation files remain in the folder you chose unless you deliberately share, sync, or send
them through one of the optional features above.
