# Task agents (vault-pluggable)

Task agents run through the selected **Local AI CLI** (**Claude Code** or **Codex CLI**). Each `.md` file defines instructions + metadata. The model returns **JSON**; the plugin creates or updates vault files under allowed folders.

## Layout

| File | Role |
|------|------|
| `*.md` | One task agent per file; YAML frontmatter + body (instructions). |

## Frontmatter (task agents)

| Key | Required | Meaning |
|-----|----------|---------|
| `agent_kind` | yes | Must be `task` for this folder. |
| `id` | yes | Stable id (filename usually matches). |
| `name` | yes | Shown in the chat dropdown. |
| `description` | no | Tooltip / settings list. |
| `output_schema` | yes | Use `vault_files_v1`. |
| `output_roots` | yes | Comma-separated vault-relative folder prefixes where files may be written. |
| `context_roots` | no | Comma-separated folders (or note paths) to inject as wiki context. |
| `max_notes` | no | Cap notes pulled from context (default 20). |
| `max_context_chars` | no | Max characters of wiki context (default 120000). |
| `enabled_default` | no | `true`/`false` when no per-agent setting exists. |

## Output JSON (`vault_files_v1`)

The model must output **only** valid JSON:

```json
{
  "version": "vault_files_v1",
  "files": [
    { "path": "OSINTCopilot/custom/outputs/memos/note.md", "body": "markdown body" }
  ]
}
```

Optional per file: `frontmatter` as a string (YAML block) or omit for body-only notes.

Paths are full vault paths, and must stay under **both** the agent’s `output_roots` **and** the global allowlist in **Settings → OSINT Copilot → Task agents**. A bare filename is written into the agent’s first `output_roots` folder.

## Settings

Enable **Task agents**, set folder path, global output allowlist, and per-agent toggles. Task agents are configured in **Settings**.
