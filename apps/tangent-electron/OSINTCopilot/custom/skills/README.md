# OSINT Copilot skills

Skills are markdown files in this folder. Each skill uses YAML frontmatter:

```yaml
---
skill_kind: vault
id: my_skill
name: Display name
description: Short line for the planner tool list
---

Body: instructions used when this skill runs (selected local AI CLI).
```

Chat uses a **unified agent** (Claude Code, Codex CLI, Hermes, or a custom runtime from settings). Custom skills here complement **HTTP enrichers** and can be created or updated when the agent proposes **custom_vault_operations** (including **upsert_enricher** for enricher JSON under the enrichers folder — confirm in chat before writes).

