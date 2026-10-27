import { describe, it, expect, vi, afterEach } from 'vitest';
import cytoscape from 'cytoscape';
import { Notice } from 'obsidian';
import type { Entity } from '../entities/types';
import { fakeGraphHost, makeGraphView } from './helpers/graph-view-harness';

// A spy Notice, so the tests can see what the view told the analyst.
vi.mock('obsidian', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Notice: vi.fn(),
}));

/** `updated` is what updateEntity answers: null when it wrote nothing. */
function viewWith(entity: Entity, updated: Entity | null = entity) {
    const entityManager = {
        getEntity: vi.fn((id: string) => (id === entity.id ? entity : undefined)),
        updateEntity: vi.fn(async () => updated),
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
    vi.mocked(Notice).mockClear();
});

/** Clicks the item of the node's context menu labelled `label`. */
function clickMenuItem(view: ReturnType<typeof viewWith>, entity: Entity, label: string): void {
    (view as any).showNodeContextMenu(new MouseEvent('contextmenu'), entity.id, entity.type, entity.label);
    const menu = document.querySelector('.graph_copilot-context-menu')!;
    const item = Array.from(menu.children).find((i) => i.textContent === label) as HTMLElement;
    item.click();
}

function notices(): unknown[] {
    return vi.mocked(Notice).mock.calls.map((call) => call[0]);
}

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

/**
 * updateEntity answers null when it wrote nothing -- the note is locked, or the entity is
 * gone -- and these said the change was made.
 */
describe('GraphView: a change the note did not take', () => {
    it('the timeline toggle says it failed, not that it was done', async () => {
        const event = entity('Event', { start_date: '2024-03-01' });
        clickMenuItem(viewWith(event, null), event, '📅 Remove from Timeline');
        await vi.waitFor(() => expect(notices()).toContain('Failed to update timeline status'));
        expect(notices()).not.toContain('Removed from Timeline');
    });

    it('the timeline toggle still reports a change that was made', async () => {
        const event = entity('Event', { start_date: '2024-03-01' });
        clickMenuItem(viewWith(event), event, '📅 Remove from Timeline');
        await vi.waitFor(() => expect(notices()).toContain('Removed from Timeline'));
    });

    it('a dropped picture says it was not set', async () => {
        const person = entity('Person', { name: 'x' });
        const handled = await (viewWith(person, null) as any).setEntityImage(person, 'Evidence/p.png');
        // Handled all the same: the drop was a picture, not a file to add to the graph.
        expect(handled).toBe(true);
        expect(notices()).toEqual(['Could not set that picture.']);
    });

    it('geolocate says the coordinates were not saved', async () => {
        const address = entity('Address', { full: '1 Main St' });
        const view = viewWith(address, null) as any;
        view.geocodingService = {
            geocodeAddressWithRetry: vi.fn(async () => ({ latitude: 51.5, longitude: -0.12, displayName: '1 Main St', confidence: 0.9 })),
        };
        await view.geolocateEntity(address.id);
        expect(notices()).toContain('Could not save the coordinates of x.');
        expect(notices().some((n) => String(n).startsWith('✓ Geocoded'))).toBe(false);
    });
});

describe('GraphView location tooltip', () => {
    /** The tooltip's text on hovering this entity's node, or null when none is shown. */
    function tooltipFor(subject: Entity): string | null {
        const view = viewWith(subject) as any;
        view.cy = cytoscape({ headless: true, elements: [{ data: { id: subject.id } }] });
        view.showLocationTooltip(view.cy.getElementById(subject.id));
        return document.getElementById('graph_copilot-location-tooltip')?.textContent ?? null;
    }

    it('shows for any location type the map plots, 0 included, with its address', () => {
        expect(tooltipFor(entity('Address', { street: '1 Main St', latitude: 0, longitude: '0' })))
            .toContain('1 Main StLat: 0.0000, Lng: 0.0000');
        document.body.innerHTML = '';
        expect(tooltipFor(entity('GeoLocation', { latitude: 48.85, longitude: 2.35 }))).toContain('Lat: 48.8500, Lng: 2.3500');
    });

    it('does not show for what the map does not plot', () => {
        expect(tooltipFor(entity('Person', { latitude: '51.5', longitude: '-0.12' }))).toBeNull();
        // parseFloat read this as 12.
        expect(tooltipFor(entity('Location', { latitude: '12,5', longitude: '3' }))).toBeNull();
    });
});
