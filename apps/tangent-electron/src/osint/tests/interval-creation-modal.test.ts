import { describe, it, expect, vi, afterEach } from 'vitest';
import { Notice } from 'obsidian';
import { FTMIntervalCreationModal } from '../modals/entity-modal';
import { ftmSchemaService } from '../services/ftm-schema-service';
import type { Entity } from '../entities/types';

vi.mock('obsidian', async (importOriginal) => {
    const mock = await importOriginal<Record<string, unknown>>();
    const { Modal } = await import('../obsidian-shim/ui/modal');
    return { ...mock, Modal, Notice: vi.fn() };
});

/**
 * The form that creates an FTM connection. It used to drop every field the user typed,
 * link the wrong pair of entities for types like Payment (and the right pair backwards
 * for Employment and Trip), leave out the dragged entities
 * whenever the range was an abstract parent (LegalEntity, Organization, Thing), and refuse
 * every custom connection type outright.
 */

const entity = (id: string, schema: string, label: string): Entity =>
    ({ id, type: schema, ftmSchema: schema, label, properties: {} });

const ann = entity('p1', 'Person', 'Ann');
const bob = entity('p2', 'Person', 'Bob');
const acme = entity('c1', 'Company', 'Acme');
const car = entity('v1', 'Vehicle', 'Van');

function openModal(type: string, entities: Entity[], sourceId?: string, targetId?: string) {
    const manager = {
        getAllEntities: () => entities,
        getEntity: (id: string) => entities.find((e) => e.id === id),
        createConnection: vi.fn(async () => ({ id: 'conn-1' })),
    };
    const modal = new FTMIntervalCreationModal({} as never, manager as never, type, undefined, sourceId, targetId);
    modal.open();
    return { manager, root: modal.contentEl };
}

/** The input, textarea or select under the field labelled `label` (required marker ignored). */
function field<T extends HTMLElement = HTMLInputElement>(root: HTMLElement, label: string): T {
    const wrap = Array.from(root.querySelectorAll<HTMLElement>('.graph_copilot-entity-field'))
        .find((el) => el.querySelector('label')?.textContent?.replace(/\s*\*\s*$/, '').trim() === label);
    if (!wrap) throw new Error(`no field labelled ${label}`);
    return wrap.querySelector('input, textarea, select') as unknown as T;
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
}

function choose(select: HTMLSelectElement, id: string): void {
    select.value = id;
    select.dispatchEvent(new Event('change'));
}

async function create(root: HTMLElement, manager: { createConnection: ReturnType<typeof vi.fn> }): Promise<void> {
    root.querySelector<HTMLButtonElement>('button.mod-cta')!.click();
    await vi.waitFor(() => {
        expect(manager.createConnection.mock.calls.length + vi.mocked(Notice).mock.calls.length).toBeGreaterThan(0);
    });
}

const endpointSelects = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLSelectElement>('select'));

afterEach(() => {
    document.body.innerHTML = '';
    vi.mocked(Notice).mockClear();
    ftmSchemaService.unregisterSchema('TestCustomLink');
});

describe('FTMIntervalCreationModal', () => {
    it('saves the fields the user typed, without the entity references', async () => {
        const { manager, root } = openModal('Family', [ann, bob]);

        choose(field<HTMLSelectElement>(root, 'Person'), ann.id);
        choose(field<HTMLSelectElement>(root, 'Relative'), bob.id);
        type(field(root, 'Relationship'), '  Cousin ');
        type(field(root, 'Start date'), '2020-01-01');
        // A field typed in and then cleared is not saved.
        type(field(root, 'Summary'), 'draft');
        type(field(root, 'Summary'), '');
        await create(root, manager);

        expect(manager.createConnection).toHaveBeenCalledWith(
            ann.id, bob.id, 'Family',
            { relationship: 'Cousin', startDate: '2020-01-01' },
            { schemaFamily: 'ftm' },
        );
    });

    it('does not save a number field that was cleared', async () => {
        const { manager, root } = openModal('Payment', [ann, acme]);

        choose(field<HTMLSelectElement>(root, 'Payer'), ann.id);
        choose(field<HTMLSelectElement>(root, 'Beneficiary'), acme.id);
        type(field(root, 'Amount'), '12');
        type(field(root, 'Amount'), '');
        await create(root, manager);

        expect(manager.createConnection).toHaveBeenCalledWith(ann.id, acme.id, 'Payment', {}, { schemaFamily: 'ftm' });
    });

    it('links a custom connection type between From and To entities', async () => {
        ftmSchemaService.registerSchema({
            name: 'TestCustomLink', label: 'Test link', extends: ['Interval'],
            properties: { fee: { label: 'Fee', type: 'string' } },
        });
        const { manager, root } = openModal('TestCustomLink', [ann, acme], ann.id, acme.id);

        expect(field<HTMLSelectElement>(root, 'From entity').value).toBe(ann.id);
        expect(field<HTMLSelectElement>(root, 'To entity').value).toBe(acme.id);
        type(field(root, 'Fee'), 'x');
        await create(root, manager);

        expect(manager.createConnection).toHaveBeenCalledWith(ann.id, acme.id, 'TestCustomLink', { fee: 'x' }, { schemaFamily: 'ftm' });
        expect(Notice).not.toHaveBeenCalledWith(expect.stringContaining('requires at least two'));
    });

    it('offers entities whose type inherits the range, and the dragged pair, prefilled', async () => {
        const { manager, root } = openModal('Directorship', [ann, acme, car], ann.id, acme.id);

        const director = field<HTMLSelectElement>(root, 'Director');
        const organization = field<HTMLSelectElement>(root, 'Organization');
        expect(director.value).toBe(ann.id);
        expect(organization.value).toBe(acme.id);

        // In range first; everything else is still listed, after them.
        const inRange = (select: HTMLSelectElement) =>
            Array.from(select.querySelectorAll(':scope > option:not([disabled])')).map((o) => (o as HTMLOptionElement).value);
        const other = (select: HTMLSelectElement) =>
            Array.from(select.querySelectorAll('optgroup[label="Other entities"] > option')).map((o) => (o as HTMLOptionElement).value);
        expect(inRange(director)).toEqual([ann.id, acme.id]);
        expect(other(director)).toEqual([car.id]);
        expect(inRange(organization)).toEqual([acme.id]);
        expect(other(organization)).toEqual([ann.id, car.id]);

        await create(root, manager);
        expect(manager.createConnection).toHaveBeenCalledWith(ann.id, acme.id, 'Directorship', {}, { schemaFamily: 'ftm' });
    });

    it('draws only the two endpoints, and links the pair the user picked', async () => {
        const { manager, root } = openModal('Payment', [ann, acme]);

        const selects = endpointSelects(root);
        expect(selects).toHaveLength(2);
        expect(selects.map((s) => s.previousElementSibling?.textContent)).toEqual(['Payer *', 'Beneficiary *']);
        choose(selects[0], ann.id);
        choose(selects[1], acme.id);
        await create(root, manager);

        expect(manager.createConnection).toHaveBeenCalledWith(ann.id, acme.id, 'Payment', {}, { schemaFamily: 'ftm' });
    });

    // Their featured lists name the endpoints to-first; the edge still runs from the
    // employee, the participant and the start location.
    it.each([
        ['Employment', ann, acme, ['Employee *', 'Employer *']],
        ['ProjectParticipant', acme, entity('pr1', 'Project', 'Bridge'), ['Participant *', 'Project *']],
        ['Trip', entity('a1', 'Address', 'Home'), entity('a2', 'Address', 'Office'), ['Start location *', 'End location *']],
    ] as const)('%s runs from the entity its edge starts at', async (schema, from, to, labels) => {
        const { manager, root } = openModal(schema, [from, to], from.id, to.id);

        const selects = endpointSelects(root);
        expect(selects.map((s) => s.previousElementSibling?.textContent)).toEqual(labels);
        expect(selects.map((s) => s.value)).toEqual([from.id, to.id]);
        await create(root, manager);

        expect(manager.createConnection).toHaveBeenCalledWith(from.id, to.id, schema, {}, { schemaFamily: 'ftm' });
    });

    it('runs a type derived from Employment the same way', () => {
        ftmSchemaService.registerSchema({ name: 'TestCustomLink', label: 'Test link', extends: ['Employment'] });
        const { root } = openModal('TestCustomLink', [ann, acme], ann.id, acme.id);

        expect(field<HTMLSelectElement>(root, 'Employee').value).toBe(ann.id);
        expect(field<HTMLSelectElement>(root, 'Employer').value).toBe(acme.id);
    });

    it('prefills the endpoints of any type from the dragged pair, by position', () => {
        const { root } = openModal('UnknownLink', [ann, car], ann.id, car.id);

        expect(field<HTMLSelectElement>(root, 'Subject').value).toBe(ann.id);
        expect(field<HTMLSelectElement>(root, 'Object').value).toBe(car.id);
    });
});
