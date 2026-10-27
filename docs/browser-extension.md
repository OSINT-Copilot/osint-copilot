# Browser extension

The OSINT Copilot extension sends selected notes, entities, page captures, PDFs, and highlights
to the desktop app on the same computer. It uses an authenticated connection to `127.0.0.1`
after pairing and has no project server, account, or analytics.

## Supported browsers

Chrome 140 or later is required. The extension is tested in Chromium, Brave, and Helium. Other
Chromium browsers such as Microsoft Edge may work but are not currently tested. Firefox is not
supported because it lacks the page-capture API used by this extension.

## Install a release

1. Download `osint-copilot-extension-<version>.zip` from the
   [release page](https://github.com/OSINT-Copilot/osint-copilot-releases/releases/latest).
2. Unzip it into a permanent folder.
3. Open `chrome://extensions`, `brave://extensions`, or `edge://extensions`.
4. Enable **Developer mode**, choose **Load unpacked**, and select the unzipped folder.

The release package has no fixed extension ID. Moving its folder can change the ID and require
pairing again.

## Pair it

1. In the desktop app, open the gear menu or press `Ctrl+,` / `Cmd+,`.
2. Open **OSINT Copilot → Browser extension** and enable **Accept items from the browser
   extension**.
3. Choose **Pair new extension**. The `ocpair1.` string works once and expires after five
   minutes.
4. Open the extension side panel, paste the string, and choose **Pair**.
5. Confirm the named extension in the desktop app, then select an investigation in the panel.

The app listens only on loopback ports 23760–23764. Revoke a browser from the app or choose
**Unpair** in the panel at any time.

## What is stored

The pairing key and selected investigation are in extension-local storage, not browser sync.
Queued captures and highlights are in the extension's IndexedDB until delivered or deleted.
Items already accepted by the app remain in the investigation. See the
[extension privacy policy](../apps/osint-copilot-extension/PRIVACY.md) for the complete data and
permissions description.

Captured evidence lands under `OSINTCopilot/Evidence/`; per-page source notes land under
`OSINTCopilot/Sources/`. The **Show browser extension activity** command lists accepted items.
The default capture shortcut is `Ctrl+Shift+Y` (`Cmd+Shift+Y` on macOS).

## Build from source

```bash
cd apps/osint-copilot-extension
npm run build
npm test
```

Load `dist/` as an unpacked extension. Development builds use a fixed public key so their ID is
stable across rebuilds. Protocol details are in
`apps/tangent-electron/src/main/osint/extension/PROTOCOL.md`.
