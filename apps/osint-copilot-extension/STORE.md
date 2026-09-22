# Chrome Web Store listing (draft)

What to enter in the Chrome Web Store developer dashboard, and what to check before submitting. The same package and most of the text also serve Microsoft Edge Add-ons.

## To do, to get it listed

Chrome Web Store, in order:

- [ ] Register a Chrome Web Store developer account for Probe Point Analytics (one-off
      5 USD), and verify the publisher's email address.
- [ ] Fill in the contact address in `PRIVACY.md` (line 60 is a placeholder) and publish it
      at a public URL. The store form requires that URL, and this extension has to give one
      because it handles website content.
- [ ] Decide the version to submit. The manifest says 0.1.0; a store version can only ever
      go up, so if 1.0.0 is what the listing should start at, change it before the first
      upload, not after.
- [ ] Build the package with `npm run zip` and submit it, with the listing text below.
- [ ] Take the screenshots the listing needs (see the checklist under "Before submitting").
- [ ] Expect a slow review. `<all_urls>` and `pageCapture` put an extension in the class
      that gets read by a human, and the single-purpose and permission justifications below
      are what that review turns on.
- [ ] Once it is listed, put its link on the releases page's README, which today tells
      people to install the zip by hand.

Microsoft Edge Add-ons takes the same package: a free Partner Center account, its own
review, and the same listing text. Worth doing at the same time.

Firefox is **not** a submission but a port. See "Firefox" at the end.

## Before submitting

- [ ] Fill in the contact address in `PRIVACY.md`, and publish that page at a public URL (the store asks for one).
- [ ] Build the package: `npm run zip`, which writes `release/osint-copilot-extension-<version>.zip` without the development `key` (the store refuses one, and assigns its own id).
- [ ] Take screenshots: 1280×800 or 640×400, at least one. The side panel beside a page with a highlight, and the investigation in OSINT Copilot afterwards, show what it is for. Use a test investigation and a public page, not a real case.
- [ ] A 128×128 icon is in the package (`icons/icon-128.png`). The store also wants a 440×280 small promotional tile if you want it featured; optional.
- [ ] The app side needs nothing: OSINT Copilot pins whatever extension id pairs with it, so the store's id pairs like the development one.
- [ ] The summary below is also the manifest's `description` (`static/manifest.json`), which is where the store takes it from: change the two together.

## Listing

**Name** (at most 75 characters)

OSINT Copilot extension

**Summary** (at most 132 characters; the store shows the manifest's `description`, which is this text)

Send notes, entities, page captures and highlights from any web page into an OSINT Copilot investigation on this computer.

**Category**

Productivity (Workflow & planning)

**Language**

English

**Description**

The OSINT Copilot extension is the browser half of OSINT Copilot, the desktop application for open-source investigations. While you browse, it files what you find into the investigation you choose:

• Quick notes about the page you are on.
• Entities from selected text: email addresses, phone numbers, usernames (kept apart by platform), domains, URLs, IP addresses and crypto wallets, each with the page as its source. An address the investigation already has gains a source instead of a duplicate.
• Page captures: an MHTML archive of the page as you see it, a screenshot, and for a PDF the document itself, filed as evidence with the archive's SHA-256 digest.
• Highlights with notes. If you allow it, they are found again when you come back to the page, even after it has moved around them.

Everything lands straight in the investigation, marked as coming from the extension, and each item can be removed again from the application.

It needs the OSINT Copilot desktop application, running on the same computer. The extension talks only to it, over 127.0.0.1, after you pair them with a one-time code; it has no server, no account and no analytics. Items wait in the extension while the application is closed.

## Privacy practices tab

**Single purpose**

Collect material from web pages (notes, entities, page captures and highlights) into an investigation in the OSINT Copilot desktop application on the user's own computer.

**Permission justifications**

- `storage`: Keeps the pairing key for the local OSINT Copilot application, the list of investigations and the one chosen, and whether the user allowed highlights to come back on a revisit (`chrome.storage.local`); and text the user right-clicks to send as an entity, until the side panel takes it (`chrome.storage.session`, cleared when the browser closes). Items waiting to be sent and the user's highlights are kept in the extension's IndexedDB, which needs no permission.
- `sidePanel`: The extension's user interface is a side panel.
- `contextMenus`: Right-click items to highlight selected text, send it as an entity, and capture the page.
- `activeTab`: Reads the current tab's address, title and selected text only after the user clicks the extension's button or menu item on that tab.
- `scripting`: Reads the user's selection, runs the highlight script that marks and finds the user's highlights on the page, and adds the highlight styles.
- Host permission `http://127.0.0.1/*`: The only destination the extension sends data to: the OSINT Copilot application on the same computer.
- Optional `pageCapture`: Saves the page the user asks to capture as an MHTML archive. Requested at the user's first capture.
- Optional host permission `<all_urls>`: For a capture the user asks for, the screenshot of the visible page and, for a PDF, fetching the document. And, only if the user separately turns it on in the panel, finding their own highlights when they revisit a page; granting the permission for capture does not turn that on. Requested at the first capture, or from the panel for highlights.

**Remote code**

No. All code is in the package; nothing is loaded from the internet, and there is no eval.

**Data usage** (the form's categories)

- Website content: yes. Text the user selects, page captures and highlights, sent only to the user's own OSINT Copilot application on the same computer.
- Web history: yes, in a narrow sense. The address and title of pages the user sends something from, and of pages that hold the user's highlights, kept in the extension and in the user's investigation.
- Personally identifiable information, authentication information, personal communications, location, health, financial and payment information, user activity: not collected. Pages the user investigates may contain other people's personal information; the extension carries only what the user selects, to the user's own application.

Certify: data is not sold to third parties, not used or transferred for purposes unrelated to the item's single purpose, and not used to determine creditworthiness or for lending.

**Privacy policy URL**

Where `PRIVACY.md` is published.

## Firefox

There is no Firefox build, and the package here cannot become one. The extension is built on
four things Firefox does not have or does differently, so a listing on addons.mozilla.org
needs a port first:

| What the extension uses | Firefox |
| --- | --- |
| `chrome.pageCapture`, for the MHTML archive that is a capture's evidence | No equivalent. A capture would have to be rebuilt on a DOM serialiser, which changes what the evidence *is* and what its SHA-256 covers. This is the real work, and the reason the plan ruled Firefox out to begin with. |
| `chrome.sidePanel`, the whole user interface | `sidebar_action`, a different manifest key and a different lifecycle. |
| `background.service_worker` | Firefox MV3 runs an event page (`background.scripts`). |
| Nothing declares a Gecko id | `browser_specific_settings.gecko.id` is required before AMO will take an upload. |

If it is worth doing:

- [ ] Decide what a Firefox capture is, given no MHTML. Same question for its digest, which
      the app records as the evidence's identity.
- [ ] Port the manifest (event page, `sidebar_action`, Gecko id) and the side panel.
- [ ] Get the end-to-end suite running against Firefox, or accept that the Firefox build is
      only covered by the unit tests.
- [ ] Register an addons.mozilla.org account, submit, and expect a source-code request:
      AMO asks for buildable sources when a submission ships bundled JavaScript, which
      ours does (esbuild). That means handing Mozilla reviewers this package's source.

That last point is worth deciding before any of the work: the application's source is
private, and while the extension is a separate package under Apache-2.0, an AMO submission
means giving its source to reviewers under their confidentiality terms.

## Browsers

Tested with the end-to-end suite (`npm run e2e`, which drives the real extension in the browser against the app's real server) in Chromium 153 (Chrome for Testing), Brave 1.95 and Helium 0.17. Not tested in Microsoft Edge or Opera. The minimum is Chrome 140 (`minimum_chrome_version`).
