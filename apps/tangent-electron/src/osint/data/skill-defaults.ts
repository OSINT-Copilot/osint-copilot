/**
 * Bootstrap files under skillsFolder: created if missing, and upgraded while they still hold
 * an earlier stock text (superseded-defaults.ts).
 */
export const SKILL_DEFAULT_FILES: { path: string; content: string }[] = [
	{
		path: "README.md",
		content: `# OSINT Copilot skills

Skills are markdown files in this folder. Each skill uses YAML frontmatter:

\`\`\`yaml
---
skill_kind: vault
id: my_skill
name: Display name
description: Which requests this skill is for
---

Body: the steps the assistant follows when a request matches the description.
\`\`\`

Chat uses a **unified agent** (Claude Code, Codex CLI, Hermes, or a custom runtime from settings). Every chat request sends it each skill here (name, description and body), and it follows a skill when the request matches that skill's description. Keep bodies short: a long one is cut to fit the prompt.

Skills complement **HTTP enrichers** and can be created or updated when the agent proposes **custom_vault_operations** (including **upsert_enricher** for enricher JSON under the enrichers folder — confirm in chat before writes).

`,
	},
	{
		path: "example-skill.md",
		content: `---
skill_kind: vault
id: example_skill
name: Example skill
description: Template only — matches no request. Copy this file to write a skill of your own.
---

This file is a template and applies to no request. Do not follow it, and do not mention it.

To write a skill, copy this file, give it a new id, and make its description the kind of request it is for (for example: writing a subject profile of a person). Then replace this text with the steps the assistant should follow for such a request.
`,
	},
];
