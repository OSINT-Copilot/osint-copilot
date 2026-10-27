import { App, normalizePath } from "obsidian";
import { SKILL_DEFAULT_FILES } from "../data/skill-defaults";
import { SUPERSEDED_SKILL_DEFAULTS } from "../data/superseded-defaults";
import { DEFAULT_SKILLS_FOLDER } from "../constants/vault-layout";
import { createOrUpgradeStockFile } from "../utils/vault-bootstrap-fs";

export class SkillBootstrapService {
	constructor(
		private app: App,
		private getSkillsRoot: () => string,
	) {}

	async ensureDefaultsInstalled(): Promise<void> {
		const root = normalizePath(this.getSkillsRoot().trim() || DEFAULT_SKILLS_FOLDER);
		for (const def of SKILL_DEFAULT_FILES) {
			const path = normalizePath(`${root}/${def.path}`);
			await createOrUpgradeStockFile(this.app, path, def.content, SUPERSEDED_SKILL_DEFAULTS[def.path]);
		}
	}
}
