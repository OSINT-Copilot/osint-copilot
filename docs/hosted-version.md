# The hosted version

[osint-copilot.com](https://osint-copilot.com) also runs OSINT Copilot in the browser, for
subscribers (the free trial included). It is this application, hosted: the same workspace,
views, entity schemas, skills, enrichers and task agents, with the investigations kept on the
service's servers and the assistant provided by the service.

The hosted service is a separate, paid offering of the OSINT Copilot company, and its server
code is not part of this repository. The desktop app is not limited by it in any way:
everything in the desktop app is free, works without an account, and makes no request to
osint-copilot.com.

## How it differs

| | Desktop app | Hosted version |
|---|---|---|
| Your investigations | Folders on your computer | Folders on the service's servers, private to your account |
| AI assistant | A CLI you install and sign in to ([AI runtimes](ai-runtimes.md)) | Claude, run by the service and paid for with the plan's credits |
| Bringing files in | Copy them into the folder | Drag them onto the window to upload them |
| Browser extension | Yes | No |
| Offline basemaps (`.pmtiles`) | Yes | No |
| Account | None | Required, with an active plan or trial |

## Moving an investigation to the desktop app

On the website's **Investigations** page, choose **Download .zip** next to the investigation.
Unzip it, start the desktop app, choose **Open a workspace**, and select the unzipped folder.
Notes, files, entities, connections, canvases and settings come across unchanged, because the
download is the investigation's folder as the hosted app keeps it.

There is no import in the other direction yet. Individual files can be uploaded to a hosted
investigation by dragging them onto its window.

## Privacy

What the hosted service stores and sends, and how to delete it, is described in the
[website's documentation](https://osint-copilot.com/documentation/#privacy). The desktop app's
own data flows are in [Privacy and data](privacy-and-data.md).
