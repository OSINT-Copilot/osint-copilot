The OSINT Copilot extension brings what you find on web pages into an investigation while you browse: notes, entities, page captures and highlights. It runs in Chrome and other Chromium browsers (tested in Chrome, Brave and Helium), and it talks only to OSINT Copilot on the same computer.

# Setting it up
1. Install the extension. Until it is in the Chrome Web Store, load it from a build: open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and select the extension's `dist` folder (see the extension's README for building it).
2. In OSINT Copilot, open the OSINT settings. Under **Browser extension**, turn on **Accept items from the browser extension**.
3. Choose **Pair new extension**. The app shows a one-time pairing string that starts with `ocpair1.`. It works once, for five minutes.
4. Click the extension's toolbar button to open its side panel, paste the string and choose **Pair**. OSINT Copilot asks you to confirm, naming the extension; nothing is accepted until you do.
5. Pick the investigation in the side panel. Items go to that investigation until you pick another.

Pairing is per browser profile. To stop a browser from sending, choose **Revoke** next to it in the settings, or **Unpair** in its side panel. The app accepts nothing from the extension while it is unlicensed, or while the setting is off.

# What you can send
Everything is attached to the page it came from: its address and title.

- **Quick note.** Type it in the side panel and send it.
- **Entity.** Select text, right-click it and choose **Send to OSINT Copilot as entity**, or use **Use selected text** in the panel. The panel suggests the kind (email, phone, username, domain, URL, IP address or wallet), which you can change. A username takes the page's site as its platform, so `john` on GitHub and `john` on X stay two people.
- **Page capture.** Press **Capture page** in the panel, choose **Capture this page to OSINT Copilot** on the page's right-click menu, or press `Ctrl+Shift+Y` (`Cmd+Shift+Y` on a Mac). The first capture asks Chrome for permission to read and save the pages you visit.
- **Highlight.** Select text and press **Highlight selection** in the panel, or right-click it and choose **Highlight in OSINT Copilot**. Add a note to it in the panel. A selection that holds text the page hides (a collapsed section, for example) is refused, so a quote is always what you saw.
  - Your highlights show on a page when you make them, and when you press **Show on this page** in the panel. To have them come back by themselves whenever you revisit a page, press **Allow** in the panel's Highlights section (and **Stop that** to turn it off). Allowing page capture does not turn this on.
  - Found again, a highlight is marked even if the page has moved around it; if its text has changed a little, it is marked with a wavy underline. Highlights that can no longer be found are listed under **Not found on this page**, and kept.
  - On a single-page site, a page that changes its address without reloading shows no highlights for the new address until you press **Show on this page**: the extension will not trust a page's word about which address it is on.

If OSINT Copilot is closed, items wait in the extension and are sent when it is running again.

# Where it lands
Items go straight into the investigation, marked as coming from the extension. A notice tells you how many arrived (click it to review them); **Show browser extension activity** in the [[Command Palette]] lists them too, and **Remove** takes any one back out again, exactly as far as it went in.

- **Entities** become entity notes, with the page as their source. Sending an address the investigation already has adds the page as another source of the same entity; it does not make a second one.
- **Every page** you send something from gets a Sources note in `OSINTCopilot/Sources/`: its address, your notes, the entities, captures and highlights from it. Text from the page is shown there as plain text in code blocks, so nothing in it can load anything or link anywhere.
- **Highlights** are sections of that Sources note. The full description of each one (the quote, the text around it, where it was) is kept beside it in a `.annotations.json` file of the same name, as the investigation's record of exactly what you highlighted. The extension does not read it back: marking highlights on pages uses the browser's own copy.
- **Captures** go to `OSINTCopilot/Evidence/`: the archive (MHTML), a full-page screenshot, what was on screen, the page's text as a note, and, for a PDF, the document itself. An Evidence entity records the page and the archive's SHA-256 digest. The archive is the page as the browser had it after its scripts ran, with the scripts removed; it is not the bytes the site sent.

# What stays private
- The extension sends nothing anywhere except to OSINT Copilot on this computer, over `127.0.0.1`. There is no account, no server of ours and no analytics.
- Items from the extension are not looked up on the Wayback Machine, unless you turn **Allow Wayback lookups for items from the extension** on for the investigation: a lookup would tell archive.org which pages you are investigating.
- Making the full-page screenshot and the page text from a capture is done with the network cut off, so a captured page cannot make the app contact the site, a tracker, or anything else. Links in Evidence and Sources notes do not fetch previews when you hover them.
- Finding your highlights on a revisit, once you allow it, happens inside the browser, from the extension's own copy; the app is not asked, so it does not learn which pages you visit. **Delete highlights kept in this browser**, in the panel, deletes that copy for every investigation, and leaves the investigations' own.
- Capturing a PDF fetches the document from the site once more, with your browser's cookies (you may need to be logged in to see it), from the exact address the tab shows.

# What this does not protect against
- A program running as your user on this computer can read your browser's data and your investigation's files anyway. The pairing and the signatures keep web pages, other extensions and other users of the computer out. The app keeps every item as it arrived, sealed, with the time it arrived and the extension that sent it, and a capture's files carry their SHA-256 digests. That catches accidental corruption and changes by other users of the computer, but a program running as you can read the app's key and reseal an edit.
- A page's own scripts can see the highlights the extension draws, and remove them from view; the extension puts them back. What counts is the record in the investigation, not what the page shows.
- The extension does not hide who you are from the sites you visit. Use your usual precautions for that.

# Troubleshooting
- **Not connected.** Check that OSINT Copilot is running and **Accept items from the browser extension** is on. The app listens on `127.0.0.1`, on port 23760 or the next free one up to 23764; the extension finds it. Items are kept and sent later.
- **The app does not recognise the extension.** It was revoked, or the app's data was reset. Pair again.
- **Highlights do not come back on a revisit.** Press **Allow** in the panel's Highlights section; Chrome asks for permission to read the pages you visit, unless page capture already has it. Without that, press **Show on this page** on the page.
- **Highlights are listed but not marked on a single-page site.** The page changed its address without reloading. Press **Show on this page**.
- **The panel cannot see the page.** Click the extension's toolbar button while on the page, or use one of its right-click items there. The extension sees a page only once you have.
