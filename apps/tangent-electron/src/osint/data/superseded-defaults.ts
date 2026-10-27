/**
 * Earlier stock texts of the skill and task-agent bootstrap files, by path in their folder.
 *
 * Bootstrap creates only the files a vault is missing, so a vault made before a default
 * changed kept the old text for good: the old example skill, sent with every chat turn,
 * told the model it was a sub-agent a workflow runs. A file that still holds one of these
 * texts exactly was never edited, and bootstrap replaces it with the current default; an
 * edited file matches none of them and is left alone. When a default changes, add its
 * previous text here.
 */

export const SUPERSEDED_SKILL_DEFAULTS: Record<string, readonly string[]> = {
	"README.md": [
		`# OSINT Copilot skills

Skills are markdown files in this folder. Each skill uses YAML frontmatter:

\`\`\`yaml
---
skill_kind: vault
id: my_skill
name: Display name
description: Short line for the planner tool list
---

Body: instructions used when this skill runs (selected local AI CLI).
\`\`\`

Chat uses a **unified agent** (Claude Code, Codex CLI, Hermes, or a custom runtime from settings). Custom skills here complement **HTTP enrichers** and can be created or updated when the agent proposes **custom_vault_operations** (including **upsert_enricher** for enricher JSON under the enrichers folder — confirm in chat before writes).

`,
	],
	"example-skill.md": [
		`---
skill_kind: vault
id: example_skill
name: Example skill
description: Template — customize or duplicate this file for vault-defined skills.
---

You are a specialized sub-agent invoked when a workflow runs this skill file.

Given the user request and any attachment context, produce a concise, actionable result for the main agent to synthesize.
`,
	],
};

export const SUPERSEDED_TASK_AGENT_DEFAULTS: Record<string, readonly string[]> = {
	"README.md": [
		`# Task agents (vault-pluggable)

Task agents run through the selected **Local AI CLI** (**Claude Code** or **Codex CLI**). Each \`.md\` file defines instructions + metadata. The model returns **JSON**; the plugin creates or updates vault files under allowed folders.

## Layout

| File | Role |
|------|------|
| \`*.md\` | One task agent per file; YAML frontmatter + body (instructions). |

## Frontmatter (task agents)

| Key | Required | Meaning |
|-----|----------|---------|
| \`agent_kind\` | yes | Must be \`task\` for this folder. |
| \`id\` | yes | Stable id (filename usually matches). |
| \`name\` | yes | Shown in the chat dropdown. |
| \`description\` | no | Tooltip / settings list. |
| \`output_schema\` | yes | Use \`vault_files_v1\`. |
| \`output_roots\` | yes | Comma-separated vault-relative folder prefixes where files may be written. |
| \`context_roots\` | no | Comma-separated folders (or note paths) to inject as wiki context. |
| \`max_notes\` | no | Cap notes pulled from context (default 20). |
| \`max_context_chars\` | no | Max characters of wiki context (default 120000). |
| \`enabled_default\` | no | \`true\`/\`false\` when no per-agent setting exists. |

## Output JSON (\`vault_files_v1\`)

The model must output **only** valid JSON:

\`\`\`json
{
  "version": "vault_files_v1",
  "files": [
    { "path": "relative/note.md", "body": "markdown body" }
  ]
}
\`\`\`

Optional per file: \`frontmatter\` as a string (YAML block) or omit for body-only notes.

Paths must stay under **both** the agent’s \`output_roots\` **and** the global allowlist in **Settings → OSINT Copilot → Task agents**.

## Settings

Enable **Task agents**, set folder path, global output allowlist, and per-agent toggles. Task agents are configured in **Settings**.
`,
		`# Task agents (vault-pluggable)

Task agents run through the selected **Local AI CLI** (**Claude Code** or **Codex CLI**). Each \`.md\` file defines instructions + metadata. The model returns **JSON**; the plugin creates or updates vault files under allowed folders.

## Layout

| File | Role |
|------|------|
| \`*.md\` | One task agent per file; YAML frontmatter + body (instructions). |

## Frontmatter (task agents)

| Key | Required | Meaning |
|-----|----------|---------|
| \`agent_kind\` | yes | Must be \`task\` for this folder. |
| \`id\` | yes | Stable id (filename usually matches). |
| \`name\` | yes | Shown in the chat dropdown. |
| \`description\` | no | Tooltip / settings list. |
| \`output_schema\` | yes | Use \`vault_files_v1\`. |
| \`output_roots\` | yes | Comma-separated vault-relative folder prefixes where files may be written. |
| \`context_roots\` | no | Comma-separated folders (or note paths) to inject as wiki context. |
| \`max_notes\` | no | Cap notes pulled from context (default 20). |
| \`max_context_chars\` | no | Max characters of wiki context (default 120000). |
| \`enabled_default\` | no | \`true\`/\`false\` when no per-agent setting exists. |

## Output JSON (\`vault_files_v1\`)

The model must output **only** valid JSON:

\`\`\`json
{
  "version": "vault_files_v1",
  "files": [
    { "path": "OSINTCopilot/custom/outputs/memos/note.md", "body": "markdown body" }
  ]
}
\`\`\`

Optional per file: \`frontmatter\` as a string (YAML block) or omit for body-only notes.

Paths are full vault paths, and must stay under **both** the agent’s \`output_roots\` **and** the global allowlist in **Settings → OSINT Copilot → Task agents**. A bare filename is written into the agent’s first \`output_roots\` folder.

## Settings

Enable **Task agents**, set folder path, global output allowlist, and per-agent toggles. Task agents are configured in **Settings**.
`,
	],
	"memo-writer.md": [
		`---
agent_kind: task
id: memo-writer
name: Memo writer
description: Draft short memos into the vault from chat + wiki context
output_schema: vault_files_v1
output_roots: OSINTCopilot/custom/outputs/memos/
context_roots: OSINTCopilot/custom/prompts/rules/
max_notes: 15
max_context_chars: 80000
enabled_default: true
---

You are a task agent that writes **concise investigation memos** as new Markdown notes in the vault.

Use the wiki context and the user message. Prefer bullet summaries, clear sections, and cite source note paths when the context includes them.

At the end, output **only** JSON matching \`vault_files_v1\` (no markdown fences, no commentary):

{
  "version": "vault_files_v1",
  "files": [
    {
      "path": "YYYY-MM-DD-topic-memo.md",
      "body": "# Title\\n\\n## Summary\\n...\\n\\n## Sources\\n- ...",
      "frontmatter": "title: Short title\\ndate: YYYY-MM-DD\\ntags: [memo, osint]"
    }
  ]
}

Use a unique filename (date prefix recommended). Keep \`path\` relative and under the configured output folder.
`,
	],
	"report-drafter.md": [
		`---
agent_kind: task
id: report-drafter
name: Report drafter
description: Longer structured report skeletons into allowed output folders
output_schema: vault_files_v1
output_roots: OSINTCopilot/custom/outputs/reports/
context_roots:
max_notes: 25
max_context_chars: 120000
enabled_default: false
---

You draft **structured OSINT-style reports** (Markdown) from the user request and any wiki context provided.

Sections to include when relevant: Executive summary, Key judgments, Facts (with uncertainty), Gaps, Recommended next steps, References (vault paths if present).

Output **only** JSON \`vault_files_v1\`:

{
  "version": "vault_files_v1",
  "files": [
    {
      "path": "report-<short-slug>.md",
      "body": "# Report title\\n\\n...",
      "frontmatter": "title: Report title\\ntype: draft-report"
    }
  ]
}

Paths must be relative under the agent output root. No prose outside the JSON.
`,
	],
};
