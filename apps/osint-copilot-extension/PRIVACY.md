# OSINT Copilot extension: privacy policy

Last updated: 19 September 2026

The OSINT Copilot extension is made by Probe Point Analytics LLC. It lets you send notes, entities, page captures and highlights from web pages into the OSINT Copilot desktop application running on your own computer. This policy says what the extension handles, where it goes, and what it never does.

## In short

- The extension sends what you choose to send **only to the OSINT Copilot application on the same computer**, over `127.0.0.1`. It has no server, no account and no analytics. Probe Point Analytics does not receive anything from it.
- It acts when you ask it to: when you send a note or an entity, capture a page, or make a highlight.
- The one exception you choose to allow: with permission to read the pages you visit, it looks for your own highlights on each page as the page loads, so it can show them again. That happens inside the browser. It sends nothing when it does.

## What the extension handles

When you use it, the extension handles:

- the address and title of the page you are on;
- text you select, and what you type into the side panel (notes, an entity's value and context);
- a page capture: the page saved as an MHTML archive, a screenshot of the visible part, and, for a PDF, the PDF itself;
- a highlight: the text you selected, a little of the text around it, where it was on the page, and your note.

This can include personal information about other people that appears on the pages you investigate, such as names, email addresses or usernames. The extension does not interpret it; it carries what you selected to your own application.

## Where it goes

- **To the OSINT Copilot application on your computer**, which files it in the investigation you chose, in your own files on your own disk. The connection is to `127.0.0.1` only, and is authenticated with a key set up when you pair the extension with the application; nothing is sent until you have paired it and confirmed the pairing in the application.
- **To the site you are on, in one case:** capturing a PDF fetches the document again from the exact address the tab shows, with your browser's cookies, because you may need to be logged in to see it. Nothing else is sent to any website.
- **Nowhere else.** The extension contains no analytics, advertising, tracking or error-reporting code, loads no code from the internet, and does not sell, share or transfer anything to anyone.

What the OSINT Copilot application does with an investigation afterwards is governed by the application and its settings. Items from the extension are, by default, not looked up on the Internet Archive's Wayback Machine.

## What is stored in your browser

- **The pairing key** and your choice of investigation, in the extension's own storage (`chrome.storage.local`), readable only by the extension itself. The key is never synced to your Google account.
- **Items waiting to be sent**, including a capture's files, in the extension's own IndexedDB storage, until the application confirms it has them. Then they are deleted.
- **Your highlights**, in the extension's own IndexedDB storage, so they can be shown again when you revisit a page, until you delete them.

Removing the extension deletes all of this from your browser. What was sent to the application stays in your investigation until you remove it there.

## Permissions

| Permission | Why |
|---|---|
| Storage | The pairing key, your choice of investigation, and the queue and highlights described above. |
| Side panel | The extension's panel. |
| Context menus | The right-click items for highlighting, sending an entity and capturing a page. |
| Active tab | Seeing the current page's address and title, and its selected text, after you click the extension's button or one of its menu items there. |
| Scripting | Reading the selection, and running the highlight script that marks and finds highlights. |
| Access to `127.0.0.1` | Talking to the OSINT Copilot application on your computer. |
| Page capture (optional, asked for when you first capture) | Saving a page as an MHTML archive. |
| Read and change your data on all websites (optional, asked for when you first capture, or from the panel for highlights) | Capturing a page and its screenshot, fetching a PDF you capture, and finding your highlights when you revisit a page. Used only for these. |

## Changes

If this policy changes, the new version will be published with the extension and the date above updated.

## Contact

Probe Point Analytics LLC, [CONTACT ADDRESS: to be filled in before publishing].
