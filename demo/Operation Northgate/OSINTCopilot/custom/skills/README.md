# OSINT Copilot skills

Skills are markdown files in this folder. Each skill uses YAML frontmatter:

```yaml
---
skill_kind: vault
id: my_skill
name: Display name
description: Which requests this skill is for
---

Body: the steps the assistant follows when a request matches the description.
```

Chat uses a **unified agent** (Claude Code, Codex CLI, Hermes, or a custom runtime from settings). Every chat request sends it each skill here (name, description and body), and it follows a skill when the request matches that skill's description. Keep bodies short: a long one is cut to fit the prompt.

Skills complement **HTTP enrichers** and can be created or updated when the agent proposes **custom_vault_operations** (including **upsert_enricher** for enricher JSON under the enrichers folder — confirm in chat before writes).

