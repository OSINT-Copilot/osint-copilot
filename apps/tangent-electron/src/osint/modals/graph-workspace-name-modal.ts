import { App, Modal, Notice, Setting, TextComponent } from 'obsidian';

/**
 * Ask for a graph workspace name (Electron has no window.prompt).
 */
export class GraphWorkspaceNameModal extends Modal {
	private textInput: TextComponent | undefined;
	/** Enter and the button share handleCreate; this keeps a second press from creating twice. */
	private creating = false;

	constructor(
		app: App,
		private readonly onCreate: (name: string) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'New graph workspace' });
		contentEl.createEl('p', {
			text: 'Each workspace saves its own node layout in the vault.',
			cls: 'setting-item-description',
		});

		new Setting(contentEl).setName('Name').addText((text) => {
			this.textInput = text;
			text.setPlaceholder('My investigation graph');
			// Enter in a bare <input> does nothing outside a <form>, so the only way to
			// confirm the name was to reach for the mouse. Key repeat and IME composition
			// commits both arrive as Enter and are not a submit.
			text.inputEl.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' || event.repeat || event.isComposing) return;
				event.preventDefault();
				void this.handleCreate();
			});
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Create')
					.setCta()
					.onClick(() => {
						void this.handleCreate();
					}),
			)
			.addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()));
	}

	private async handleCreate(): Promise<void> {
		if (this.creating) return;
		const name = this.textInput?.getValue().trim() ?? '';
		if (!name) {
			new Notice('Enter a name for the graph workspace.');
			return;
		}
		this.creating = true;
		try {
			await Promise.resolve(this.onCreate(name));
			this.close();
		} finally {
			this.creating = false;
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
