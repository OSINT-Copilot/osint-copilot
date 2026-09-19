import { App, Modal, Notice, Setting, type DropdownComponent } from 'obsidian';
import type { EnricherSpec } from '../services/enrichers/enricher-schema';
import { submitOnEnter } from '../utils/submit-on-enter';

/*
 * The two HTTP enricher palette commands ask for their input here. They used
 * window.prompt(), which Electron's renderer does not implement: it throws, so both
 * commands did nothing at all.
 */

export type EnricherState = 'active' | 'disabled';

/** The trimmed text when it is an http(s) URL, else null. */
function httpUrl(raw: string): string | null {
	const text = raw.trim();
	try {
		const url = new URL(text);
		return url.protocol === 'http:' || url.protocol === 'https:' ? text : null;
	} catch {
		return null;
	}
}

/** What the state dropdown offers first: the state the enricher is not in. */
function oppositeState(spec: EnricherSpec | undefined): EnricherState {
	return spec?.status === 'active' && spec.enabled ? 'disabled' : 'active';
}

/** The API documentation URL and what the enricher should do, for the draft command. */
export class EnricherDraftRequestModal extends Modal {
	private urlInput = '';
	private detailsInput = '';
	/** Enter and the button share one submit; this keeps a second press from drafting twice. */
	private submitting = false;

	constructor(
		app: App,
		private readonly onSubmit: (docUrl: string, details: string) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Draft HTTP enricher' });
		contentEl.createDiv({
			text: 'The model reads the documentation and drafts the enricher. It is saved as a disabled draft, for you to check before you activate it.',
			cls: 'setting-item-description',
		});

		new Setting(contentEl).setName('API documentation URL').addText((t) => {
			t.setPlaceholder('https://api.example.com/docs');
			t.onChange((v) => {
				this.urlInput = v;
			});
			submitOnEnter(t.inputEl, () => this.submit());
		});
		// A textarea, and so no submit on Enter: the requirements may need several lines.
		new Setting(contentEl)
			.setName('Requirements')
			.setDesc('What the enricher should search and return. Include the required parameters.')
			.addTextArea((t) => {
				t.setPlaceholder('Look up an e-mail address and return the breaches it appears in');
				t.inputEl.rows = 4;
				t.onChange((v) => {
					this.detailsInput = v;
				});
			});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Draft').setCta().onClick(() => this.submit()))
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	private submit(): void {
		if (this.submitting) return;
		const docUrl = httpUrl(this.urlInput);
		if (!docUrl) {
			new Notice('Enter the http(s) address of the API documentation.');
			return;
		}
		const details = this.detailsInput.trim();
		if (!details) {
			new Notice('Describe what the enricher should search and return.');
			return;
		}
		this.submitting = true;
		void (async () => {
			try {
				await this.onSubmit(docUrl, details);
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

/**
 * An enricher, picked from the ones in the vault, and the state to give it.
 *
 * Pressing Set state is the approval; there is no second confirmation. The picker
 * replaced a typed id, which had to be given without the ENRICH_ prefix and failed on
 * any other spelling.
 */
export class EnricherStateModal extends Modal {
	private selectedId: string;
	private nextState: EnricherState;
	private stateDropdown: DropdownComponent | undefined;
	private submitting = false;

	constructor(
		app: App,
		private readonly enrichers: readonly EnricherSpec[],
		private readonly onSubmit: (id: string, state: EnricherState) => void | Promise<void>,
	) {
		super(app);
		this.selectedId = enrichers[0]?.id ?? '';
		this.nextState = oppositeState(enrichers[0]);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Set HTTP enricher state' });
		contentEl.createDiv({
			text: 'Only an active enricher can run. Setting the state here is your approval, and it is recorded in the enrichers audit log.',
			cls: 'setting-item-description',
		});

		new Setting(contentEl).setName('Enricher').addDropdown((d) => {
			for (const e of this.enrichers) d.addOption(e.id, `${e.name} (${e.id}) · ${e.status}`);
			d.setValue(this.selectedId);
			d.onChange((id) => {
				this.selectedId = id;
				this.nextState = oppositeState(this.enrichers.find((e) => e.id === id));
				this.stateDropdown?.setValue(this.nextState);
			});
		});
		new Setting(contentEl).setName('New state').addDropdown((d) => {
			this.stateDropdown = d;
			d.addOption('active', 'Active').addOption('disabled', 'Disabled');
			d.setValue(this.nextState);
			d.onChange((v) => {
				this.nextState = v === 'active' ? 'active' : 'disabled';
			});
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Set state').setCta().onClick(() => this.submit()))
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
	}

	private submit(): void {
		if (this.submitting || !this.selectedId) return;
		this.submitting = true;
		void (async () => {
			try {
				await this.onSubmit(this.selectedId, this.nextState);
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
