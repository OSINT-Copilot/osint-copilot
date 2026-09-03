# OSINT Copilot — vault prompts

This folder is **managed by you**. The plugin copies these files once when they are missing; it does not overwrite your edits.

## Layout

| Path | Role |
|------|------|
| `rules/global.md` | Prepended to orchestration planner context (tone, safety, citations). |
| `agents/*.md` | One file per agent; YAML frontmatter `id`, `name`, `description`; body = extra system instructions. |
| `skills/graph-extraction.md` | Instructions for **entity / graph extraction** (selected local AI CLI). Edits apply on next extraction after reload. |
| `logs/` | Optional **.md / .txt / .log** traces (enricher debug, run notes). Recent files may be merged into unified-agent **vault augmentation** (size-capped). |

**Task agents** (separate folder, default `OSINTCopilot/custom/task-agents/`) hold `agent_kind: task` manifests that create vault files via the selected local AI CLI — see **Settings → Task agents** and the README inside that folder.

## Settings

**Settings → OSINT Copilot → Vault prompts** — folder path, active agent id, install missing files, reload cache.

## Reload

After editing, use command palette: **OSINT Copilot: Reload vault prompts** (or restart Obsidian).
