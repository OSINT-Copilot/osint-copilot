import { describe, it, expect } from "vitest";
import { enricherJsonPathFromId, skillMarkdownPathFromId } from "../utils/registry-paths";
import { DEFAULT_ENRICHERS_FOLDER, DEFAULT_SKILLS_FOLDER } from "../constants/vault-layout";

describe("registry paths", () => {
	it("skillMarkdownPathFromId uses default folder and slug", () => {
		expect(skillMarkdownPathFromId("", "Hello World")).toBe(`${DEFAULT_SKILLS_FOLDER}/hello-world.md`);
		expect(skillMarkdownPathFromId("Custom/skills", "my_skill")).toBe("Custom/skills/my_skill.md");
	});

	it("skillMarkdownPathFromId rejects readme id", () => {
		expect(skillMarkdownPathFromId("", "readme")).toBeNull();
	});

	it("enricherJsonPathFromId matches writer-style path", () => {
		expect(enricherJsonPathFromId("", "LeakCheck v2")).toBe(`${DEFAULT_ENRICHERS_FOLDER}/leakcheck-v2.json`);
		expect(enricherJsonPathFromId("OSINTCopilot/custom/enrichers", "foo")).toBe(
			"OSINTCopilot/custom/enrichers/foo.json",
		);
	});
});
