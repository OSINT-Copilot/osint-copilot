import { describe, it, expect, vi, afterEach } from 'vitest';
import { Notice } from 'obsidian';
import { CustomTypeCreationModal } from '../modals/custom-type-modal';

vi.mock('obsidian', async (importOriginal) => {
    const mock = await importOriginal<Record<string, unknown>>();
    const { Modal } = await import('../obsidian-shim/ui/modal');
    const setting = await import('../obsidian-shim/ui/setting');
    return {
        ...mock,
        Modal,
        Setting: setting.Setting,
        TextComponent: setting.TextComponent,
        DropdownComponent: setting.DropdownComponent,
        ButtonComponent: setting.ButtonComponent,
        Notice: vi.fn(),
    };
});

/** Types into an input one character at a time, as a user does: one input event per key. */
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    input.value = '';
    for (const ch of text) {
        input.value += ch;
        input.dispatchEvent(new Event('input'));
    }
}

function settingInput(root: HTMLElement, name: string): HTMLInputElement {
    const item = Array.from(root.querySelectorAll<HTMLElement>('.setting-item'))
        .find((el) => el.querySelector('.setting-item-name')?.textContent === name);
    return item!.querySelector('input, textarea') as HTMLInputElement;
}

function formInput(root: HTMLElement, label: string): HTMLInputElement {
    const field = Array.from(root.querySelectorAll<HTMLElement>('.graph_copilot-form-grid > div'))
        .find((el) => el.querySelector('.setting-item-name')?.textContent === label);
    return field!.querySelector('input') as HTMLInputElement;
}

function button(root: HTMLElement, text: string): HTMLButtonElement {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === text)!;
}

function openModal(existing?: Record<string, unknown>) {
    const service = { addCustomType: vi.fn(async (_type: unknown) => {}) };
    const modal = new CustomTypeCreationModal({} as never, service as never, existing as never);
    modal.open();
    return { modal, service, root: modal.contentEl };
}

afterEach(() => {
    document.body.innerHTML = '';
    vi.mocked(Notice).mockClear();
});

describe('CustomTypeCreationModal', () => {
    it('derives the label, plural and property key from everything typed, not the first key', async () => {
        const { service, root } = openModal();

        typeInto(settingInput(root, 'Type name'), 'NomineeFor');
        expect(settingInput(root, 'Display label').value).toBe('NomineeFor');
        expect(settingInput(root, 'Plural label').value).toBe('NomineeFors');

        typeInto(formInput(root, 'Label *'), 'Birth date');
        expect(formInput(root, 'Property key *').value).toBe('birthdate');
        button(root, 'Add property').click();

        button(root, 'Create type').click();
        await vi.waitFor(() => expect(service.addCustomType).toHaveBeenCalled());

        const saved = service.addCustomType.mock.calls[0][0] as Record<string, any>;
        expect(saved.name).toBe('NomineeFor');
        expect(saved.label).toBe('NomineeFor');
        expect(saved.plural).toBe('NomineeFors');
        expect(Object.keys(saved.properties)).toEqual(['birthdate']);
        expect(saved.properties.birthdate.label).toBe('Birth date');
    });

    it('stops following the name once the label is typed in', () => {
        const { root } = openModal();

        typeInto(settingInput(root, 'Type name'), 'Nominee');
        typeInto(settingInput(root, 'Display label'), 'Nominee for');
        typeInto(settingInput(root, 'Type name'), 'NomineeFor');

        expect(settingInput(root, 'Display label').value).toBe('Nominee for');
        expect(settingInput(root, 'Plural label').value).toBe('NomineeFors');
    });

    it('keeps a key the user typed, and follows the label again for the next property', () => {
        const { root } = openModal();

        typeInto(formInput(root, 'Label *'), 'Birth date');
        typeInto(formInput(root, 'Property key *'), 'dob');
        typeInto(formInput(root, 'Label *'), 'Date of birth');
        expect(formInput(root, 'Property key *').value).toBe('dob');

        const required = settingInput(root, 'Required');
        required.checked = true;
        required.dispatchEvent(new Event('change'));
        button(root, 'Add property').click();

        expect(required.checked).toBe(false);
        typeInto(formInput(root, 'Label *'), 'Place');
        expect(formInput(root, 'Property key *').value).toBe('place');
    });

    it('refuses to save two properties with one key', async () => {
        const { service, root } = openModal();
        typeInto(settingInput(root, 'Type name'), 'Shell');

        typeInto(formInput(root, 'Label *'), 'Birth date');
        button(root, 'Add property').click();
        typeInto(formInput(root, 'Label *'), 'Birthdate');
        button(root, 'Add property').click();

        button(root, 'Create type').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(service.addCustomType).not.toHaveBeenCalled();
        expect(Notice).toHaveBeenCalledWith(expect.stringContaining("'birthdate'"));
    });

    it('shows the saved label, plural and description when editing', () => {
        const { root } = openModal({
            name: 'Shell', label: 'Shell company', plural: 'Shell companies', description: 'A front.',
            extends: ['Thing'], properties: {},
        });

        expect(settingInput(root, 'Display label').value).toBe('Shell company');
        expect(settingInput(root, 'Plural label').value).toBe('Shell companies');
        expect(settingInput(root, 'Description').value).toBe('A front.');
    });
});
