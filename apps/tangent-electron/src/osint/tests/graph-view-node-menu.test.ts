import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Entity } from '../entities/types';
import { fakeGraphHost, makeGraphView } from './helpers/graph-view-harness';

function viewWith(entity: Entity) {
    const entityManager = {
        getEntity: vi.fn((id: string) => (id === entity.id ? entity : undefined)),
    };
    return makeGraphView(entityManager, fakeGraphHost(), { vault: {} });
}

/** Opens the node's context menu and returns its item labels. */
function menuFor(entity: Entity): string[] {
    const view = viewWith(entity);
    (view as any).showNodeContextMenu(new MouseEvent('contextmenu'), entity.id, entity.type, entity.label);
    const menu = document.querySelector('.graph_copilot-context-menu')!;
    return Array.from(menu.children).map((item) => item.textContent ?? '');
}

function entity(type: string, properties: Record<string, unknown>): Entity {
    return { id: 'e1', type, label: 'x', properties } as Entity;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('GraphView node menu: timeline', () => {
    it('offers Remove for an Event with add_to_timeline unset, which the timeline shows', () => {
        const items = menuFor(entity('Event', { start_date: '2024-03-01' }));
        expect(items).toContain('📅 Remove from Timeline');
        expect(items).not.toContain('📅 Add to Timeline');
    });

    it('offers Add only for an Event taken off the timeline', () => {
        expect(menuFor(entity('Event', { add_to_timeline: false }))).toContain('📅 Add to Timeline');
        expect(menuFor(entity('Event', { add_to_timeline: 'no' }))).toContain('📅 Add to Timeline');
    });
});

describe('GraphView node menu: map', () => {
    it('offers Show on Map for an Address with coordinates, and gives it the double border', () => {
        const address = entity('Address', { full: '1 Main St', latitude: '51.5', longitude: '-0.12' });
        const items = menuFor(address);
        expect(items).toContain('🗺️ Show on Map');
        expect(items).not.toContain('📍 Geolocate Address');
        expect((viewWith(address) as any).buildNodeData(address).hasCoordinates).toBe(true);
    });

    it('treats a GeoLocation and a Location at 0,0 as on the map', () => {
        expect(menuFor(entity('GeoLocation', { latitude: 48.85, longitude: 2.35 }))).toContain('🗺️ Show on Map');
        expect(menuFor(entity('Location', { latitude: 0, longitude: 0 }))).toContain('🗺️ Show on Map');
    });

    it('offers Geolocate for a lower-case address note with no coordinates', () => {
        const items = menuFor(entity('address', { full: '1 Main St' }));
        expect(items).toContain('📍 Geolocate Address');
        expect(items).not.toContain('🗺️ Show on Map');
    });

    it('offers neither for a Person with coordinates, which the map does not plot', () => {
        const person = entity('Person', { name: 'x', latitude: '51.5', longitude: '-0.12' });
        const items = menuFor(person);
        expect(items).not.toContain('🗺️ Show on Map');
        expect(items).not.toContain('📍 Geolocate Address');
        expect((viewWith(person) as any).buildNodeData(person).hasCoordinates).toBe(false);
    });
});
