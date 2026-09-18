# OSINT Copilot extension

A Chrome extension (Manifest V3, Chrome 140 or later) that sends notes and entities from web pages into an investigation in the OSINT Copilot desktop app on the same computer. Items go straight into the investigation, labelled "via extension". The app then shows a notice from which you can review them and remove any you did not mean to add.

The extension talks only to the app, over `http://127.0.0.1`, and only after pairing. Nothing leaves the computer. The wire protocol is specified in [`apps/tangent-electron/src/main/osint/extension/PROTOCOL.md`](../tangent-electron/src/main/osint/extension/PROTOCOL.md).

Licensed under Apache-2.0 (see `LICENSE` and `NOTICE`).

## Build

From this folder (dependencies come from the repository's npm workspaces):

```sh
npm run build       # bundles into dist/
npm run watch       # rebuilds on change; reload the extension in chrome://extensions afterwards
npm run typecheck
npm test
npm run e2e         # builds, then drives the extension in Chromium against the app's real server
```

`npm run e2e` runs `e2e/smoke.spec.ts` headless: it pairs from the side panel, sends a note and an entity, and checks they reach a temporary investigation's inbox with valid MACs. It uses the Chromium Playwright was built for, or else the newest one in `~/.cache/ms-playwright`; set `OC_E2E_CHROMIUM` to choose another binary and `OC_E2E_HEADED=1` to watch.

`dist/` is generated and not committed. To redraw the icons after the app's icon changes, run `python3 scripts/make-icons.py` (needs Pillow).

## Load it in Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select this folder's `dist/`.
3. Pin the extension and click its toolbar button. The side panel opens.

The manifest's `key` pins the development extension id to **`eokeefakkjidnblbahcdjobcpallgnfk`**, so every unpacked copy has the same `chrome-extension://` origin and stays paired across rebuilds. The key is a public key generated for this package only. Its private key was never saved, because Chrome does not need it to load an unpacked extension. A Web Store build must drop the `key` field, because the store assigns its own id.

## Pair with the app

1. In OSINT Copilot, open the OSINT settings. Under **Browser extension**, turn on **Accept items from the browser extension**.
2. Choose **Pair new extension**. The app shows a one-time string like `ocpair1.23760.….…`. It works once, for five minutes.
3. Paste it into the side panel and choose **Pair**.
4. The app asks you to confirm, naming this extension's origin. Confirm.

The panel then shows the app as connected and lists your investigations. To stop using the extension, choose **Unpair** in the panel, or **Revoke** next to it in the app.

## Using it

- **Investigation.** The dropdown lists the app's investigations. A dot marks the ones open in a window, where items appear at once; the others get them the next time they are opened. When the app is not running, the panel shows the last list it saw and says it is offline.
- **Page.** Every item is attached to the page it came from (URL and title). The extension can see the current tab only after you click its toolbar button or its context-menu item on that tab. Until then the panel says so, rather than guessing the page.
- **Quick note.** Type and send.
- **Entity.** Select text on a page, right-click it and choose **Send to OSINT Copilot as entity**. You can also press **Use selected text** in the panel. The panel suggests a kind (email, phone, username, domain, URL, IP or wallet), which you can change. For wallets you choose the chain; for usernames the platform defaults to the page's site. Nothing is sent until you press **Send entity**.
- **Queue.** Every item is queued before it is sent. If the app is closed, items wait and are sent when it is back. The extension retries when it starts, when you open the panel and when you act. While the panel is open it also retries on a timer, backing off to at most every ten minutes. If the app refuses an item (for example, the investigation no longer exists), the item stays in the queue marked as not sent. You can then retry it, send it to another investigation or delete it. The queue holds at most 100 items or 300 MB. When it is full, new items are refused; old ones are never dropped.

## Permissions

| Permission | What it is for |
|---|---|
| `storage` | The pairing key, the investigation list and your choice of investigation (`chrome.storage.local`), plus the context-menu selection on its way to the panel (`chrome.storage.session`). |
| `sidePanel` | The side panel. |
| `contextMenus` | "Send to OSINT Copilot as entity" on selected text. |
| `activeTab` | Seeing the current tab's URL and title, and reading its selection, after you click the toolbar button or the menu item there. This gives no access to other tabs or later visits. |
| `scripting` | Reading the selected text for **Use selected text**, only in a tab where you have granted `activeTab`. |
| `http://127.0.0.1/*` | Talking to the OSINT Copilot app on this computer. |
| `pageCapture`, `webNavigation` (optional) | Not requested yet. Page capture comes in a later version, which will ask first. |
| `<all_urls>` (optional) | Not requested yet. Page capture without a click on each page will need it; Chrome will warn about it when asked. |

The extension does not request `tabs`, `nativeMessaging`, `unlimitedStorage`, `externally_connectable` or `onMessageExternal`.

## Security, briefly

- **Pairing key.** The key derived at pairing lives only in `chrome.storage.local`, set to trusted contexts: the service worker and the extension's own pages. It is never in `storage.sync`. It is never sent to a page or a content script, and never shown in the panel. The pairing string's secret is discarded once the key exists.
- **Checking the app is really the app.** Before sending anything, the service worker checks the app's identity with `hello`. It checks that the proof is from the instance it paired with, and for the exact port it dialled. So a program that grabs the app's port first, or relays to the real app on another port, is refused. Every request is signed, and every reply's signature is checked. A reply that does not verify is treated as no reply, and the item is retried later under the same id. There is no unauthenticated fallback.
- **Who can ask the service worker to do things.** Only the extension's own pages. Messages from content scripts and from other extensions are refused.
- **What a page can do.** Page text (a selection, a title) is treated as data. It fills a form field, and nothing is sent until you press Send. The panel never renders it as HTML.

## What this version does and does not do (Phase 1)

Does:

- Pairing, and the authenticated channel to the app, including finding the app when it moves to another of its five ports (23760-23764).
- Choosing the investigation.
- Quick notes, and single entities from a selection or typed.
- A durable queue with retries.

Does not yet:

- Capture pages (MHTML, screenshots): Phase 2.
- Highlight and annotate text on pages: Phase 3.
- Keyboard shortcuts, a Web Store build or a privacy policy: Phase 4.
- Retry on a schedule while the panel is closed. That would need the `alarms` permission, so for now queued items go when the extension next wakes: at browser start, when you open the panel, or when you send something.
- Run in Firefox (no `chrome.pageCapture`). Edge and Brave are untested.

## Layout

| Path | What it is |
|---|---|
| `static/` | `manifest.json`, the side panel's HTML and CSS, icons. Copied into `dist/`. |
| `src/shared/` | Protocol constants and types, base64url, signing strings (WebCrypto), the app's acceptance checks, `classify()`, URL helpers, manifest building. |
| `src/sw/` | The service worker: channel (pair, hello, signed requests), storage, IndexedDB queue, message router, context menu, entry point. |
| `src/sidepanel/` | The side panel (plain TypeScript and DOM). |
| `test/` | Vitest, in Node. The signing and entity tests read the app's shared vectors in `apps/tangent-electron/src/main/osint/extension/vectors/` directly. |
| `scripts/make-icons.py` | Regenerates the icons from the app's icon. |
