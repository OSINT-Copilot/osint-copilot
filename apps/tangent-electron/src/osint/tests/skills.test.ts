import { describe, it, expect } from "vitest";
import { parseSkillMarkdown } from "../skills/parse-skill-markdown";

describe("parseSkillMarkdown", () => {
	it("parses vault skill frontmatter", () => {
		const raw = `---
skill_kind: vault
id: my_skill
name: Test Skill
description: Does a thing
---
Body line.`;
		const m = parseSkillMarkdown(raw, "OSINTCopilot/custom/skills/t.md");
		expect(m?.id).toBe("my_skill");
		expect(m?.name).toBe("Test Skill");
		expect(m?.body).toContain("Body line");
	});
});
