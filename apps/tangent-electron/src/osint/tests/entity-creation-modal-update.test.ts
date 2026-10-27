import { describe, it, expect, vi, afterEach } from 'vitest';
import { Notice } from 'obsidian';
import { EntityCreationModal } from '../modals/entity-modal';
import { EntityType, type Entity } from '../entities/types';

vi.mock('obsidian', async (importOriginal) => {
    const mock = await importOriginal<Record<string, unknown>>();
    const { Modal } = await import('../obsidian-shim/ui/modal');
    return { ...mock, Modal, Notice: vi.fn() };
});

/**
 * The legacy entity form, opened on an existing entity (the map's Edit). updateEntity
 * answers null when it wrote nothing, and the form said "Updated" all the same.
 */

const ann: Entity = { id: 'p1', type: EntityType.Person, label: 'Ann', properties: { full_name: 'Ann' } };

function openEdit(updated: Entity | null) {
    const manager = { updateEntity: vi.fn(async () => updated), getBasePath: () => 'OSINTCopilot' };
    const onSaved = vi.fn();
    const modal = new EntityCreationModal({} as never, manager as never, EntityType.Person, onSaved, { ...ann.properties }, ann.id);
    modal.open();
    const close = vi.spyOn(modal, 'close');
    return { manager, onSaved, close, save: () => modal.contentEl.querySelector<HTMLButtonElement>('button.mod-cta')!.click() };
}

afterEach(() => {
    document.body.innerHTML = '';
    vi.mocked(Notice).mockClear();
});

describe('EntityCreationModal editing an entity', () => {
    it('says so and stays open when nothing was written', async () => {
        const { manager, onSaved, close, save } = openEdit(null);

        save();
        await vi.waitFor(() => expect(Notice).toHaveBeenCalled());

        expect(manager.updateEntity).toHaveBeenCalledWith(ann.id, expect.objectContaining({ full_name: 'Ann' }));
        expect(vi.mocked(Notice).mock.calls.map((c) => c[0])).toEqual(['Could not update this Person.']);
        expect(onSaved).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
    });

    it('reports the update and closes when it was written', async () => {
        const { onSaved, close, save } = openEdit({ ...ann, label: 'Ann Two' });

        save();
        await vi.waitFor(() => expect(close).toHaveBeenCalled());

        expect(vi.mocked(Notice).mock.calls.map((c) => c[0])).toEqual(['Updated Person: Ann Two']);
        expect(onSaved).toHaveBeenCalledWith(ann.id);
    });
});
