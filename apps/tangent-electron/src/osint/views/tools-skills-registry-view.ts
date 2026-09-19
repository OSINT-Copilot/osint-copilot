import {
	App,
	ItemView,
	Modal,
	Notice,
	Setting,
	TFile,
	WorkspaceLeaf,
	normalizePath,
} from "obsidian";
import type { EnricherRegistry } from "../services/enrichers/enricher-registry";
import { isEnricherRunnable, type EnricherSpec } from "../services/enrichers/enricher-schema";
import { parseSkillIdForVault } from "../services/custom-vault-operations";
import type { SkillRegistry } from "../skills/skill-registry";
import type { VaultSkillManifest } from "../skills/skill-types";
import { DEFAULT_ENRICHERS_FOLDER, DEFAULT_SKILLS_FOLDER } from "../constants/vault-layout";
import { ConfirmModal } from "../modals/confirm-modal";
import { enricherJsonPathFromId, skillMarkdownPathFromId } from "../utils/registry-paths";
import { ensureFolderChain } from "../utils/vault-bootstrap-fs";
import { submitOnEnter } from "../utils/submit-on-enter";

export const TOOLS_SKILLS_REGISTRY_VIEW_TYPE = "osint-copilot-tools-skills-registry";

export interface ToolsSkillsRegistryHost {
	app: App;
	skillRegistry: SkillRegistry;
	enricherRegistry: EnricherRegistry;
	settings: { skillsFolder: string; enrichersFolder: string };
}

function buildDraftEnricherJson(id: string, name: string): string {
	const now = new Date().toISOString();
	const spec = {
		id,
		name: name || id,
		description: "Draft — edit URL, domains, and auth before setting status to active.",
		status: "draft",
		enabled: false,
		allowedDomains: [],
		auth: { type: "none" },
		request: {
			method: "GET",
			urlTemplate: "https://example.com/?q={{query}}",
			headers: {},
		},
		inputHints: ["query"],
		skillInstructions: "",
		limits: { timeoutMs: 15000, retries: 1, maxResponseChars: 8000 },
		updatedAt: now,
	};
	return JSON.stringify(spec, null, 2);
}

function yamlDoubleQuoted(s: string): string {
	const oneLine = s.replace(/\r?\n/g, " ").trim();
	return `"${oneLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

class AddSkillModal extends Modal {
	private idInput = "";
	private nameInput = "";
	private descInput = "";
	/** Enter and the button share one submit; this keeps a second press from creating twice. */
	private submitting = false;

	constructor(
		app: App,
		private onSubmit: (id: string, name: string, description: string) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "New vault skill" });
		contentEl.createDiv({
			text: "Id becomes the filename (slug). README is reserved.",
			cls: "setting-item-description",
		});

		new Setting(contentEl).setName("Skill id").addText((t) => {
			t.setPlaceholder("my_skill");
			t.onChange((v) => {
				this.idInput = v;
			});
			submitOnEnter(t.inputEl, () => this.submit());
		});
		new Setting(contentEl).setName("Display name").addText((t) => {
			t.setPlaceholder("My skill");
			t.onChange((v) => {
				this.nameInput = v;
			});
			submitOnEnter(t.inputEl, () => this.submit());
		});
		new Setting(contentEl).setName("Description").addTextArea((t) => {
			t.setPlaceholder("Which requests this skill is for");
			t.inputEl.rows = 3;
			t.onChange((v) => {
				this.descInput = v;
			});
		});

		// One row, two buttons, as GraphWorkspaceNameModal has it. Two Setting rows put
		// Create and Cancel on separate lines, each beside the empty label column of a
		// settings entry.
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Create").setCta().onClick(() => this.submit()))
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	private submit(): void {
		if (this.submitting) return;
		const id = parseSkillIdForVault(this.idInput);
		if (!id || id === "readme") {
			new Notice("Enter a valid skill id (letters, numbers, _ and -).");
			return;
		}
		const name = this.nameInput.trim() || id;
		const description = this.descInput.trim() || "New vault skill";
		this.submitting = true;
		void (async () => {
			try {
				await this.onSubmit(id, name, description);
				this.close();
			} finally {
				this.submitting = false;
			}
		})();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class AddEnricherDraftModal extends Modal {
	private idInput = "";
	private nameInput = "";
	private submitting = false;

	constructor(
		app: App,
		private onSubmit: (id: string, name: string) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "New enricher draft" });
		contentEl.createDiv({
			text: "Creates a disabled draft JSON. Edit domains and URL before enabling.",
			cls: "setting-item-description",
		});
		new Setting(contentEl).setName("Enricher id").addText((t) => {
			t.setPlaceholder("my_enricher");
			t.onChange((v) => {
				this.idInput = v;
			});
			submitOnEnter(t.inputEl, () => this.submit());
		});
		new Setting(contentEl).setName("Display name").addText((t) => {
			t.setPlaceholder("My enricher");
			t.onChange((v) => {
				this.nameInput = v;
			});
			submitOnEnter(t.inputEl, () => this.submit());
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Create draft").setCta().onClick(() => this.submit()))
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	private submit(): void {
		if (this.submitting) return;
		const id = parseSkillIdForVault(this.idInput);
		if (!id) {
			new Notice("Enter a valid enricher id.");
			return;
		}
		const name = this.nameInput.trim() || id;
		this.submitting = true;
		void (async () => {
			try {
				await this.onSubmit(id, name);
				this.close();
			} finally {
				this.submitting = false;
			}
		})();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class ToolsSkillsRegistryView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private host: ToolsSkillsRegistryHost,
	) {
		super(leaf);
	}

	getViewType(): string {
		return TOOLS_SKILLS_REGISTRY_VIEW_TYPE;
	}

	async onOpen(): Promise<void> {
		const root = this.containerEl.children[1];
		root.empty();
		root.addClass("osint-copilot-registry-root");

		const toolbar = root.createDiv({ cls: "osint-copilot-registry-toolbar" });
		// The accent goes on the action that creates something, not on Refresh: a
		// highlighted Refresh beside a plain "Add skill" said the opposite of what the
		// view is for.
		const addSkillBtn = toolbar.createEl("button", { text: "Add skill", cls: "mod-cta" });
		addSkillBtn.addEventListener("click", () => {
			new AddSkillModal(this.app, (id, name, description) => this.createSkillFile(id, name, description)).open();
		});
		const addEnrichBtn = toolbar.createEl("button", { text: "Add enricher draft" });
		addEnrichBtn.addEventListener("click", () => {
			new AddEnricherDraftModal(this.app, (id, name) => this.createEnricherDraft(id, name)).open();
		});
		// Trailing, where the map's and the timeline's refresh sit.
		const trailing = toolbar.createDiv({ cls: "osint-copilot-registry-toolbar-trailing" });
		this.refreshBtn = trailing.createEl("button", { text: "Refresh" });
		this.refreshBtn.addEventListener("click", () => {
			void this.reload();
		});

		const grid = root.createDiv({ cls: "osint-copilot-registry-grid" });
		this.skillsCol = grid.createDiv({ cls: "osint-copilot-registry-column" });
		this.enrichCol = grid.createDiv({ cls: "osint-copilot-registry-column" });

		// The registries drop their caches on these events, but nothing told the open view,
		// so a skill added by a chat Apply, a palette command or another editor stayed
		// missing until Refresh. Debounced: one Apply can write several files.
		const scheduleReloadFromPath = (path: string): void => {
			if (!this.isRegistryPath(path)) return;
			if (this.vaultReloadTimer !== null) {
				window.clearTimeout(this.vaultReloadTimer);
			}
			this.vaultReloadTimer = window.setTimeout(() => {
				this.vaultReloadTimer = null;
				void this.reload();
			}, 400);
		};
		this.registerEvent(this.app.vault.on("create", (f) => scheduleReloadFromPath(f.path)));
		this.registerEvent(this.app.vault.on("modify", (f) => scheduleReloadFromPath(f.path)));
		this.registerEvent(this.app.vault.on("delete", (f) => scheduleReloadFromPath(f.path)));
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				scheduleReloadFromPath(f.path);
				if (typeof oldPath === "string") scheduleReloadFromPath(oldPath);
			}),
		);

		await this.reload();
	}

	/**
	 * A skill note, an enricher spec, or either folder itself, under the folders set now.
	 * The enrichers audit log is none of these, so the set-state command's own log line
	 * does not trigger a second reload.
	 */
	private isRegistryPath(path: string): boolean {
		const p = normalizePath(path);
		const skillsRoot = normalizePath(this.host.settings.skillsFolder.trim() || DEFAULT_SKILLS_FOLDER);
		const enrichersRoot = normalizePath(this.host.settings.enrichersFolder.trim() || DEFAULT_ENRICHERS_FOLDER);
		if (p === skillsRoot || p === enrichersRoot) return true;
		if (p.startsWith(`${skillsRoot}/`) && p.endsWith(".md")) return true;
		return p.startsWith(`${enrichersRoot}/`) && p.endsWith(".json");
	}

	private skillsCol!: HTMLElement;
	private enrichCol!: HTMLElement;
	private refreshBtn: HTMLButtonElement | null = null;
	/** reload() is reachable from five places and every caller discards the promise. */
	private reloadInFlight: Promise<void> | null = null;
	/** A reload was asked for while one ran; that one may have read the folders too early. */
	private reloadAgain = false;
	private vaultReloadTimer: number | null = null;

	/**
	 * Single-flight, and it never rejects. Every caller discards the promise, so a
	 * registry that threw -- an unreadable skills folder, an enricher JSON that does not
	 * parse -- used to surface as an unhandled rejection and a view frozen on whatever it
	 * showed last, under a Refresh button that looked as if it had not been pressed.
	 *
	 * A call that arrives mid-reload is not dropped: one more run follows, since the change
	 * that prompted it can have landed after the running one read the folders.
	 */
	private reload(): Promise<void> {
		if (this.reloadInFlight) {
			this.reloadAgain = true;
			return this.reloadInFlight;
		}
		this.reloadInFlight = this.doReload().finally(() => {
			this.reloadInFlight = null;
			if (this.reloadAgain) {
				this.reloadAgain = false;
				void this.reload();
			}
		});
		return this.reloadInFlight;
	}

	private async doReload(): Promise<void> {
		this.setRefreshBusy(true);
		try {
			this.host.skillRegistry.invalidate();
			this.host.enricherRegistry.invalidate();
			// Settled independently: one registry failing must not hide the other's list.
			const [skills, enrichers] = await Promise.allSettled([
				this.host.skillRegistry.listVaultSkills(),
				this.host.enricherRegistry.listAll(),
			]);
			if (skills.status === "fulfilled") this.renderSkills(skills.value);
			else this.renderColumnError(this.skillsCol, "Vault skills", "Could not read the skills folder", skills.reason);
			if (enrichers.status === "fulfilled") this.renderEnrichers(enrichers.value);
			else this.renderColumnError(this.enrichCol, "HTTP enrichers", "Could not read the enrichers folder", enrichers.reason);
		} catch (err) {
			console.error("[ToolsSkillsRegistryView] reload failed:", err);
			new Notice("Could not refresh the registry.");
		} finally {
			this.setRefreshBusy(false);
		}
	}

	private setRefreshBusy(busy: boolean): void {
		const btn = this.refreshBtn;
		if (!btn) return;
		btn.disabled = busy;
		btn.setText(busy ? "Refreshing\u2026" : "Refresh");
	}

	/** The column's heading and one line saying what went wrong, in place of a stale list. */
	private renderColumnError(col: HTMLElement, heading: string, what: string, reason: unknown): void {
		console.error(`[ToolsSkillsRegistryView] ${what}:`, reason);
		col.empty();
		col.createEl("h3", { text: heading });
		const message = reason instanceof Error ? reason.message : String(reason);
		col.createDiv({ text: `${what}: ${message}`, cls: "osint-copilot-registry-error" });
	}

	private renderSkills(skills: VaultSkillManifest[]): void {
		this.skillsCol.empty();
		this.skillsCol.createEl("h3", { text: "Vault skills" });
		this.skillsCol.createDiv({
			text: `Folder: ${normalizePath(this.host.settings.skillsFolder.trim() || DEFAULT_SKILLS_FOLDER)}`,
			cls: "osint-copilot-registry-hint",
		});
		if (skills.length === 0) {
			this.skillsCol.createDiv({ text: "No skills found.", cls: "osint-copilot-registry-empty" });
			return;
		}
		for (const s of skills) {
			const row = this.skillsCol.createDiv({ cls: "osint-copilot-registry-row" });
			row.createEl("div", { text: s.name, cls: "osint-copilot-registry-row-title" });
			row.createEl("code", { text: s.id, cls: "osint-copilot-registry-row-id" });
			const actions = row.createDiv({ cls: "osint-copilot-registry-row-actions" });
			const openBtn = actions.createEl("button", { text: "Open note" });
			openBtn.addEventListener("click", () => void this.openPath(s.sourcePath));
			const delBtn = actions.createEl("button", { text: "Delete", cls: "mod-warning" });
			delBtn.addEventListener("click", () => this.confirmTrashSkill(s));
		}
	}

	private renderEnrichers(list: EnricherSpec[]): void {
		this.enrichCol.empty();
		this.enrichCol.createEl("h3", { text: "HTTP enrichers" });
		this.enrichCol.createDiv({
			text: `Folder: ${normalizePath(this.host.settings.enrichersFolder.trim() || DEFAULT_ENRICHERS_FOLDER)}`,
			cls: "osint-copilot-registry-hint",
		});
		if (list.length === 0) {
			this.enrichCol.createDiv({ text: "No enricher JSON files found.", cls: "osint-copilot-registry-empty" });
			return;
		}
		for (const e of list) {
			const row = this.enrichCol.createDiv({ cls: "osint-copilot-registry-row" });
			const title = row.createEl("div", { cls: "osint-copilot-registry-row-title" });
			title.setText(e.name);
			const runnable = isEnricherRunnable(e);
			row.createEl("code", {
				text: `${e.id} · ${e.status} · ${e.enabled ? "enabled" : "disabled"} · ${runnable ? "runnable" : "not runnable"}`,
				cls: "osint-copilot-registry-row-id",
			});
			const path =
				enricherJsonPathFromId(this.host.settings.enrichersFolder, e.id) ??
				normalizePath(`${normalizePath(this.host.settings.enrichersFolder.trim() || DEFAULT_ENRICHERS_FOLDER)}/${e.id}.json`);
			const actions = row.createDiv({ cls: "osint-copilot-registry-row-actions" });
			const openBtn = actions.createEl("button", { text: "Open file" });
			openBtn.addEventListener("click", () => void this.openPath(path));
			const delBtn = actions.createEl("button", { text: "Delete", cls: "mod-warning" });
			delBtn.addEventListener("click", () => this.confirmTrashEnricher(e, path));
		}
	}

	private async openPath(vaultPath: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(vaultPath));
		if (!(f instanceof TFile)) {
			new Notice("File not found: " + vaultPath);
			return;
		}
		await this.app.workspace.getLeaf(false).openFile(f);
	}

	private confirmTrashSkill(s: VaultSkillManifest): void {
		new ConfirmModal(
			this.app,
			"Move skill to trash?",
			`Move "${s.name}" (${s.sourcePath}) to trash?`,
			() => {
				void this.trashByPath(s.sourcePath, "skill");
			},
			undefined,
			true,
			"Move to trash",
		).open();
	}

	private confirmTrashEnricher(e: EnricherSpec, path: string): void {
		new ConfirmModal(
			this.app,
			"Move enricher to trash?",
			`Move enricher "${e.name}" (${path}) to trash?`,
			() => {
				void this.trashByPath(path, "enricher");
			},
			undefined,
			true,
			"Move to trash",
		).open();
	}

	private async trashByPath(vaultPath: string, kind: "skill" | "enricher"): Promise<void> {
		const norm = normalizePath(vaultPath);
		const f = this.app.vault.getAbstractFileByPath(norm);
		if (!(f instanceof TFile)) {
			new Notice("File not found.");
			return;
		}
		try {
			await this.app.fileManager.trashFile(f);
		} catch (err) {
			console.error(err);
			new Notice("Could not move file to trash.");
			return;
		}
		if (kind === "skill") this.host.skillRegistry.invalidate();
		else this.host.enricherRegistry.invalidate();
		new Notice("Moved to trash.");
		await this.reload();
	}

	private async createSkillFile(id: string, name: string, description: string): Promise<void> {
		const rel = skillMarkdownPathFromId(this.host.settings.skillsFolder, id);
		if (!rel) {
			new Notice("Invalid skill id.");
			return;
		}
		const existing = this.app.vault.getAbstractFileByPath(rel);
		if (existing) {
			new Notice("A file already exists at " + rel);
			return;
		}
		const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
		if (parent) await ensureFolderChain(this.app, parent);
		const body = `---
skill_kind: vault
id: ${id}
name: ${yamlDoubleQuoted(name)}
description: ${yamlDoubleQuoted(description)}
---

Replace this text with the steps the assistant should follow when a request matches the description.
`;
		try {
			await this.app.vault.create(rel, body);
		} catch (e) {
			console.error(e);
			new Notice("Could not create skill file.");
			return;
		}
		this.host.skillRegistry.invalidate();
		new Notice("Skill created.");
		await this.reload();
	}

	private async createEnricherDraft(id: string, name: string): Promise<void> {
		const rel = enricherJsonPathFromId(this.host.settings.enrichersFolder, id);
		if (!rel) {
			new Notice("Invalid enricher id.");
			return;
		}
		const existing = this.app.vault.getAbstractFileByPath(rel);
		if (existing) {
			new Notice("A file already exists at " + rel);
			return;
		}
		const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
		if (parent) await ensureFolderChain(this.app, parent);
		const json = buildDraftEnricherJson(id, name);
		try {
			await this.app.vault.create(rel, json);
		} catch (e) {
			console.error(e);
			new Notice("Could not create enricher file.");
			return;
		}
		this.host.enricherRegistry.invalidate();
		new Notice("Enricher draft created.");
		await this.reload();
	}

	async onClose(): Promise<void> {
		if (this.vaultReloadTimer !== null) {
			window.clearTimeout(this.vaultReloadTimer);
			this.vaultReloadTimer = null;
		}
		this.containerEl.children[1].empty();
	}
}
