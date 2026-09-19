import { describe, it, expect, vi, afterEach } from 'vitest';
import { Notice } from 'obsidian';
import { MapView } from '../views/map-view';
import type { Entity } from '../entities/types';

// The shim's Modal, which has a contentEl and mounts on document.body, and a spy Notice.
vi.mock('obsidian', async (importOriginal) => {
    const mock = await importOriginal<Record<string, unknown>>();
    const { Modal } = await import('../obsidian-shim/ui/modal');
    return { ...mock, Modal, Notice: vi.fn() };
});

/**
 * The map's "Geolocate missing" dialog when the note does not take the coordinates:
 * updateEntity answers null (the note is locked, or the entity is gone), and the row
 * said Done and the batch counted it geocoded.
 */
function openDialog() {
    const address: Entity = { id: 'a1', type: 'Address', label: '1 Main St', properties: { full: '1 Main St' } };
    const entityManager = {
        getAllEntities: () => [address],
        updateEntity: vi.fn(async () => null),
        loadEntitiesFromNotes: vi.fn(async () => undefined),
    };
    const view = new MapView({} as never, entityManager as never);
    (view as any).app = {};
    (view as any).geocodingService = {
        geocodeAddressWithRetry: vi.fn(async () => ({ latitude: 51.5, longitude: -0.12, displayName: '1 Main St', confidence: 0.9 })),
    };
    (view as any).showGeolocateMissingDialog();
    const row = document.querySelector<HTMLButtonElement>('.geolocate-item button')!;
    const all = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Geolocate all')!;
    return { entityManager, row, all };
}

afterEach(() => {
    document.body.innerHTML = '';
    vi.mocked(Notice).mockClear();
});

describe('MapView geolocate dialog: coordinates the note did not take', () => {
    it('marks the row failed', async () => {
        const { entityManager, row } = openDialog();
        row.click();
        await vi.waitFor(() => expect(row.textContent).not.toBe('Geocoding…'));
        expect(entityManager.updateEntity).toHaveBeenCalled();
        expect(row.textContent).toBe('Failed');
    });

    it('counts it failed in a batch', async () => {
        const { row, all } = openDialog();
        all.click();
        await vi.waitFor(() => expect(vi.mocked(Notice)).toHaveBeenCalled());
        expect(vi.mocked(Notice).mock.calls[0][0]).toBe('Geocoded 0 location(s). 1 failed.');
        expect(row.textContent).toBe('Failed');
    });
});

describe('MapView refresh', () => {
    it('reloads the notes as a routine reload, which rewrites only the changed graph-yaml entries', async () => {
        const entityManager = { loadEntitiesFromNotes: vi.fn(async () => { throw new Error('EIO'); }) };
        const view = new MapView({} as never, entityManager as never);
        // A stand-in: the failed load returns before the map is touched.
        (view as any).map = {};
        await view.refresh();
        expect(entityManager.loadEntitiesFromNotes).toHaveBeenCalledWith({ graphYaml: 'changed' });
    });
});
