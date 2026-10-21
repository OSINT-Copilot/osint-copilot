# OSINT Copilot extension

A Chrome extension (Manifest V3, Chrome 140 or later) that sends notes, entities, page captures and highlights from web pages into an investigation in the OSINT Copilot desktop app on the same computer. Items go straight into the investigation, labelled "via extension". The app then shows a notice from which you can review them and remove any you did not mean to add.

Items are delivered only to the paired app over `http://127.0.0.1`. The extension has no
project server, account, analytics, or crash reporter. Capturing a PDF is the one website
request it can make: it fetches the exact PDF URL again with the browser's cookies. The wire
protocol is specified in
[`apps/tangent-electron/src/main/osint/extension/PROTOCOL.md`](../tangent-electron/src/main/osint/extension/PROTOCOL.md).

Licensed under Apache-2.0 (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)). Issues and support
requests belong in the [OSINT Copilot repository](https://github.com/OSINT-Copilot/osint-copilot).

## Build

From this folder (dependencies come from the repository's npm workspaces):

```sh
npm run build       # bundles into dist/
npm run watch       # rebuilds on change; reload the extension in chrome://extensions afterwards
npm run typecheck
npm test
npm run e2e         # builds, then drives the extension in Chromium against the app's real server
```

`npm run e2e` runs `e2e/smoke.spec.ts` headless: it pairs from the side panel, sends a note and two entities, captures a local page, and checks they reach a temporary investigation's inbox with valid MACs (and, for the capture, an archive whose SHA-256 is the one declared). It also makes highlights and checks when they are shown again: on a revisit only once allowed, on request otherwise, never on a selection holding hidden text, and on a single-page site never for an address the page moved to by itself. Chrome's permission prompt cannot be answered from Playwright, so the capture test loads a copy of the build whose manifest grants `pageCapture` and `<all_urls>` at install; the prompt itself is covered by the unit tests. It uses the Chromium Playwright was built for, or else the newest one in `~/.cache/ms-playwright`; set `OC_E2E_CHROMIUM` to choose another binary and `OC_E2E_HEADED=1` to watch.

`dist/` is generated and not committed. To redraw the icons after the app's icon changes, run `python3 scripts/make-icons.py` (needs Pillow).

## Store package

```sh
npm run zip         # builds, then writes release/osint-copilot-extension-<version>.zip
```

The zip is what the Chrome Web Store and Edge Add-ons take. It is `dist/` with one difference: the manifest has no `key`, because a store assigns its own id and refuses an upload that carries one. The app pins whichever id pairs with it, so a store copy pairs like the development one. The zip is reproducible with the same Node version (sorted entries, fixed timestamps; another zlib may deflate differently), leaves out dotfiles, and carries `LICENSE` and `NOTICE`. It needs Node 22.2 or later. To check a package in a browser, unzip it and run the end-to-end suite against it: `OC_E2E_DIST=<unzipped folder> npx playwright test -c playwright.config.ts`.

`STORE.md` has the listing text, the permission justifications and the privacy answers the store asks for, with a checklist; `PRIVACY.md` is the privacy policy, to be published at a public URL before submitting.

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
- **Capture page.** Press **Capture page** in the panel, choose **Capture this page to OSINT Copilot** from the page's right-click menu, or press **Ctrl+Shift+Y** (**Command+Shift+Y** on a Mac; change it at `chrome://extensions/shortcuts`). The extension saves the tab as an MHTML archive and, if the same tab is still in front at the same address, a screenshot of what is on screen. For a PDF tab it also fetches the PDF itself, with your browser's cookies (you may be logged in to see it) but only from the exact address the tab shows, with redirects refused. The capture goes into the investigation as Evidence. The first capture asks Chrome for two permissions (see below); the panel explains this before you are asked, and if you decline, nothing is captured. Chrome's own pages, the Chrome Web Store, `file://` pages and sites your organisation's policy blocks cannot be captured, and the panel says which applies. The panel shows the capture's progress (preparing, uploading N of M MB, delivered, queued or failed).
- **Highlights.** Select text on a page and press **Highlight selection** in the panel, or right-click it and choose **Highlight in OSINT Copilot**. The text is marked on the page, and the highlight is filed in the investigation, in the page's Sources note, with its full description (the quote, the text around it, where it was) kept beside the note in `<note>.annotations.json`. The panel lists the page's highlights with a note field for each: **Save note** files the note as an edit. **Delete** removes it here and in the investigation. Only the chosen investigation's highlights are shown; choosing another, or unpairing, updates open pages.
  - **Finding them again.** The extension finds a page's highlights again even after the page has shifted around them. A highlight whose text changed a little is marked with a wavy underline. Highlights it cannot find are listed under **Not found on this page**, with **Find again**, and are never deleted for not being found.
  - **When they are shown.** On a revisit, only if you allowed it in the panel (**Allow**; **Stop that** turns it off). This is a choice of its own: the permission page capture asks for does not turn it on. Otherwise highlights show where you make one, and when you press **Show on this page**. A single-page site that changes its address without loading gets no highlights for the new address until you press **Show on this page**, because Chrome names the document by where it was loaded from, and a page can move its address wherever it likes.
  - **What is refused.** A selection holding text the page hides (a collapsed section, for example) is refused, and the panel says why: the quote would not be what you saw. A right-click Highlight is refused inside a frame, or if the page changed the selection before it was read.
  - **Deleting the browser's copy.** **Delete highlights kept in this browser** (at the bottom of the Highlights section) deletes every highlight the extension keeps, for every investigation, and leaves the investigations' copies alone. It works with the queue full, and for investigations the app no longer lists.
  - The marks are drawn with the CSS Custom Highlight API: nothing is inserted into the page. They are not hidden from the page, though: a page's own scripts can list and even clear them, and the extension simply puts them back. What counts is the record in the investigation, not the page's display.
  - Looking for highlights on a revisit is local: the extension keeps them in its own storage, and asks the app nothing, so the app does not learn which pages you visit.
- **Queue.** Every item is queued before it is sent. If the app is closed, items wait and are sent when it is back. The extension retries when it starts, when you open the panel and when you act. While the panel is open it also retries on a timer, backing off to at most every ten minutes. If the app refuses an item (for example, the investigation no longer exists), the item stays in the queue marked as not sent. You can then retry it, send it to another investigation or delete it. The queue holds at most 100 items or 300 MB, a capture's files included. When it is full, new items are refused; old ones are never dropped. A capture's files are kept in the extension's IndexedDB until the app confirms it has the capture; an upload cut off by a closed app or a browser restart resumes with the files the app still lacks, under the same id. A capture the app refuses stays in the queue, files and all, marked as not sent, for you to retry or delete.

## Permissions

| Permission | What it is for |
|---|---|
| `storage` | The pairing key, the investigation list, your choice of investigation and whether highlights come back on a revisit (`chrome.storage.local`), plus the context-menu selection on its way to the panel (`chrome.storage.session`). |
| `sidePanel` | The side panel. |
| `contextMenus` | "Highlight in OSINT Copilot" and "Send to OSINT Copilot as entity" on selected text, and "Capture this page to OSINT Copilot" on a page. |
| `activeTab` | Seeing the current tab's URL and title, and reading its selection, after you click the toolbar button or the menu item there. This gives no access to other tabs or later visits. |
| `scripting` | Reading the selected text for **Use selected text**; running the highlight script, which marks and finds highlights, in a tab where you made a highlight or asked to show them (or, with revisits allowed, on every page as it loads); and adding the highlights' styles to a page. |
| `http://127.0.0.1/*` | Talking to the OSINT Copilot app on this computer. |
| `pageCapture` (optional) | Saving a tab as MHTML. Asked for, together with `<all_urls>`, the first time you capture a page, from that click or key press. |
| `<all_urls>` (optional) | Page capture: reading the tab's address and title, the screenshot of the visible part (`captureVisibleTab`), and fetching a PDF tab's own bytes. Highlights, only once you allow revisits in the panel: running the highlight script as each page loads, so your highlights come back. Chrome words this as reading and changing your data on all websites; the extension uses it only for these. You can withdraw it in `chrome://extensions`, and capture then asks again. |

The keyboard shortcut is a manifest `commands` entry, which needs no permission. The extension does not request `tabs`, `nativeMessaging`, `unlimitedStorage`, `externally_connectable` or `onMessageExternal`.

## Security, briefly

- **Pairing key.** The key derived at pairing lives only in `chrome.storage.local`, set to trusted contexts: the service worker and the extension's own pages. It is never in `storage.sync`. It is never sent to a page or a content script, and never shown in the panel. The pairing string's secret is discarded once the key exists.
- **Checking the app is really the app.** Before sending anything, the service worker checks the app's identity with `hello`. It checks that the proof is from the instance it paired with, and for the exact port it dialled. So a program that grabs the app's port first, or relays to the real app on another port, is refused. Every request is signed, and every reply's signature is checked. A reply that does not verify is treated as no reply, and the item is retried later under the same id. There is no unauthenticated fallback.
- **Who can ask the service worker to do things.** Only the extension's own pages can make requests. The extension's own content script, in a tab's top frame only, may ask about its own page's highlights (`content.ready`, `content.report`, `content.clicked`) and nothing else, and the worker answers about the page Chrome says the script is in, not one the message names. Messages from other extensions and from web pages are refused.
- **What a page can do.** Page text (a selection, a title) is treated as data. It fills a form field, and nothing is sent until you press Send. The panel never renders it as HTML.
- **Captures are of the page you meant.** The tab is read before and after the archive is made. If it navigated meanwhile, the capture is dropped. The screenshot shows whatever is on screen, so it is taken only while the same tab, at the same address, is still the one in front of its window, and checked again after; otherwise it is left out and the queue item says why. The files are hashed (SHA-256) in the extension and declared before they are sent, and each upload is signed over its bytes, so the app stores exactly what was captured.

## What this version does and does not do

Does:

- Pairing, and the authenticated channel to the app, including finding the app when it moves to another of its five ports (23760-23764).
- Choosing the investigation.
- Quick notes, and single entities from a selection or typed.
- Page capture (MHTML, a screenshot of the visible part, a PDF tab's original), from the panel, the page menu or a keyboard shortcut.
- A durable queue with retries, resuming a capture's upload where it stopped.
- Highlights with notes: filed in the investigation, found again on a revisit once allowed (also after the page shifted, and approximately when its text changed a little), shown on request otherwise, listed when not found, editable and deletable.

Does not yet:

- Highlight inside frames (an embedded post, a comment widget): the highlight script runs in the page's top frame only, and the right-click Highlight refuses a selection in a frame. Text selected in a frame is also attributed, for entities, to the page around it.
- Publish itself. The store package, listing text and privacy policy are ready (see Store package), but submitting it, and hosting the privacy policy, are done by hand.
- Retry on a schedule while the panel is closed. That would need the `alarms` permission, so for now queued items go when the extension next wakes: at browser start, when you open the panel, or when you send something.
- Run in Firefox (no `chrome.pageCapture`).
- Get tested in Microsoft Edge or Opera. The end-to-end suite passes in Chromium 153 (Chrome for Testing), Brave 1.95 and Helium 0.17. To run it in another browser, set `OC_E2E_CHROMIUM` to its binary; a browser installed as a snap cannot see `/tmp`, so point `TMPDIR` at a folder in your home as well.

## Layout

| Path | What it is |
|---|---|
| `static/` | `manifest.json`, the side panel's HTML and CSS, icons. Copied into `dist/`. |
| `src/shared/` | Protocol constants and types, base64url, signing strings (WebCrypto), the app's acceptance checks, `classify()`, URL helpers, manifest building. |
| `src/sw/` | The service worker: channel (pair, hello, signed requests and uploads), storage, IndexedDB queue (items and a capture's files), page capture, message router, context menus and the capture command, entry point. |
| `src/content/` | The highlight script, which runs in pages: the text model, describing a selection, finding it again, painting it, and keeping a page's highlights as the page changes (`page.ts`). |
| `src/sidepanel/` | The side panel (plain TypeScript and DOM). |
| `test/` | Vitest, in Node (the highlight script's tests in jsdom). The signing and entity tests read the app's shared vectors in `apps/tangent-electron/src/main/osint/extension/vectors/` directly. |
| `scripts/make-icons.py` | Regenerates the icons from the app's icon. |
