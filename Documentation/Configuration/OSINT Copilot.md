The OSINT Copilot options are found in the [[System Menu]]. They cover the browser extension, the chat agent and the command-line tools it runs, the map, and the entity graph.

# Browser Extension
Turn on **Accept items from the browser extension** to let paired browsers send notes, entities, page captures and highlights into your investigations. **Pair new extension** shows a one-time string to paste into the extension's side panel; it works once, for five minutes. Each paired browser is listed with its version and when it was last seen, and **Revoke** stops it from sending. **Allow Wayback lookups for items from the extension** is set for the open investigation only, and is off by default, since a lookup tells the Internet Archive which pages the case is looking at. See [[Browser Extension]] for the whole workflow.

# About
Shows the version of the OSINT layer. The app's own version is on the About page, and updates arrive through the app's own updater.

# Views
**Opening a view** decides what the Chat, Entities, Timeline, Locations and Tools buttons do. __Switch to it__ shows one thing at a time, a note or a view. __Open beside the current pane__ adds a pane per click, the way a note opens to the right.

# Graph Note Lock
Notes locked from the entity graph are read-only until you unlock them, and task agents skip writing to them. **Locked notes** shows how many there are, and **Unlock all** makes every one of them writable again.

# Chat Context
**Max notes** is the most notes the chat includes as context for a request, from 1 to 200. **System prompt** is the default instruction the chat starts from when answering questions.

# Vault Prompts
The **Prompts folder** holds the Markdown rules, agents and graph-extraction skill the chat uses, which you can edit. **Active agent id** picks one of the agents in its `agents` folder by the `id` in its front matter. **Install missing default prompt files** puts back any default file that is missing, without overwriting your edits.

# Skills (Vault)
Four folders in the vault extend the chat agent. The **Skills folder** holds Markdown skills, which the agent follows when a request matches one. The **Enrichers folder** holds JSON enricher specs, HTTP lookups the agent can propose and that run only once you approve them. The **Credentials folder** holds plain-text secrets, such as API keys, that enrichers read; it must stay under `OSINTCopilot/custom/`. The **Scripts folder** holds scripts the agent may propose; you review each change in the chat, and OSINT Copilot never runs them.

# Task Agents (Vault)
With **Enable task agents** on, the chat in General mode lets you pick a task agent: a workflow run by the local AI CLI that creates files in the vault. The **Task agents folder** holds their Markdown manifests. The **Global output allowlist** lists the folders any task agent may write to; an agent may write only where both this list and its own output roots allow. **Install missing default task-agent files** puts back the README and sample agents, and brings any you have not edited up to the current defaults. Each agent found has its own switch below it. The **Conversation history folder** is where chat conversations are saved.

# Unified Chat Agent
**Agent runtime** chooses the local program that answers chat requests: Claude Code, Codex CLI, Hermes, or a custom runtime. You can also change it in the chat's header. Hermes has its own path, extra arguments, timeout and health-check arguments here; Claude Code and Codex are set up under Local AI CLI below. **Test agent runtime** checks that the chosen runtime can be reached.

# Custom Runtimes
Any local command-line program that follows the Hermes contract (the prompt on standard input, the answer on standard output) can be added with **Add custom runtime**. Its name, id, path, arguments, timeout and health-check arguments can be edited while it is the selected Agent runtime.

# Local AI CLI
**Extraction and task-agent CLI** chooses Claude Code or Codex CLI for entity extraction from attachments, image analysis and task agents. Both run on your computer and use the sign-in their CLI already has. For Claude Code, set the **Claude CLI path**, **Claude model**, extra arguments and timeout; for Codex, the **Codex CLI path**, an optional model override, extra arguments and timeout, and **Check login** confirms Codex is signed in. **Extraction log verbosity** sets how much extraction detail the chat shows, and **Extraction debug: raw CLI output** adds the CLI's raw output, which may include sensitive content. **Test selected local AI CLI** runs a small request the same way the chat does.

# Miro Import
Imports one Miro board's items and connectors into the vault as a Markdown note the chat can read. It is a one-time import, not a live sync, and importing the same board again overwrites its note. Enter a **Miro access token** (stored in plain text in OSINT Copilot's settings) and a **Board ID or URL**, then choose **Import board now**.

# Map
**Geocoding service** is empty by default, which disables address and coordinate lookups. To enable them, enter the root URL of a Nominatim-compatible service whose operator permits your use. Queries are sent to that operator. Remote endpoints must use HTTPS; HTTP is accepted only for localhost.

The **Offline basemap** is a PMTiles file read from disk, which works with no network and tells no one what you are looking at. **Online basemap** is OpenFreeMap by default; every tile it fetches tells the provider which area you are viewing, so set it to __None__ to stop that, or choose __Custom tile server__ and give a **Tile URL template** containing `{z}`, `{x}` and `{y}` and its **Attribution**. **Basemap colours** follows the app's theme, or is always light or always dark.

# Graph View
**Enable graph features** turns on the graph view and the entity and relationship features behind it. **Schema families in type pickers** and **OIDSF bundled schema layers** choose which types are offered when you create entities and connections; types already in the vault still show on the graph. **Auto-refresh graph view** refreshes the graph when the AI creates entities, and **Auto-open graph view** opens it when entities are created and it is not already open.
