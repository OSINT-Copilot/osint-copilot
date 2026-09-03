import { describe, it, expect } from 'vitest';
import {
    createPopupContent,
    isAddressEntityType,
    isLocationEntityType,
    parseCoordinate,
    shouldClaimBaseLayer,
    GRID_LAYER_NAME,
    ONLINE_LAYER_NAME,
    CUSTOM_LAYER_NAME,
    OFFLINE_LAYER_NAME,
} from '../views/map-view';
import { entityHasMapCoordinates } from '../ui/vault-op-previews';

describe('isLocationEntityType', () => {
    it('matches Location, Address, and GeoLocation regardless of casing or whitespace', () => {
        expect(isLocationEntityType('Location')).toBe(true);
        expect(isLocationEntityType('location')).toBe(true);
        expect(isLocationEntityType('LOCATION')).toBe(true);
        expect(isLocationEntityType('  Location  ')).toBe(true);
        expect(isLocationEntityType('Address')).toBe(true);
        expect(isLocationEntityType('address')).toBe(true);
        expect(isLocationEntityType('GeoLocation')).toBe(true);
        expect(isLocationEntityType('geolocation')).toBe(true);
    });

    it('rejects unrelated entity types and non-string/undefined values', () => {
        expect(isLocationEntityType('Person')).toBe(false);
        expect(isLocationEntityType('Event')).toBe(false);
        expect(isLocationEntityType('')).toBe(false);
        expect(isLocationEntityType(undefined)).toBe(false);
    });
});

describe('isAddressEntityType', () => {
    it('matches only Address, and does so case-insensitively', () => {
        expect(isAddressEntityType('Address')).toBe(true);
        expect(isAddressEntityType('address')).toBe(true);
        expect(isAddressEntityType('  ADDRESS ')).toBe(true);
        // A GeoLocation is a location but not an address, so it must not pick up the
        // street/city/country composition path.
        expect(isAddressEntityType('GeoLocation')).toBe(false);
        expect(isAddressEntityType('Location')).toBe(false);
        expect(isAddressEntityType(undefined)).toBe(false);
    });
});

describe('parseCoordinate', () => {
    it('accepts plain signed decimals, including zero', () => {
        expect(parseCoordinate(0, 'lat')).toBe(0);
        // Zero is a real coordinate. A falsy check here put anything on the equator or
        // the prime meridian into the "missing" bucket.
        expect(parseCoordinate('0', 'lng')).toBe(0);
        expect(parseCoordinate('51.5074', 'lat')).toBeCloseTo(51.5074);
        expect(parseCoordinate('-0.1278', 'lng')).toBeCloseTo(-0.1278);
        expect(parseCoordinate('+45', 'lat')).toBe(45);
        expect(parseCoordinate('  12.5  ', 'lat')).toBe(12.5);
    });

    it('refuses ambiguous text rather than half-reading it', () => {
        // parseFloat would return 12 here and move the pin ~55km.
        expect(parseCoordinate('12,5', 'lat')).toBeNull();
        expect(parseCoordinate('48.1 N', 'lat')).toBeNull();
        expect(parseCoordinate('1e5deg', 'lng')).toBeNull();
        expect(parseCoordinate('N/A', 'lat')).toBeNull();
        expect(parseCoordinate('', 'lat')).toBeNull();
        expect(parseCoordinate(undefined, 'lat')).toBeNull();
        expect(parseCoordinate(NaN, 'lat')).toBeNull();
        expect(parseCoordinate(Infinity, 'lng')).toBeNull();
    });

    it('range-checks each axis separately', () => {
        expect(parseCoordinate('90', 'lat')).toBe(90);
        expect(parseCoordinate('-90', 'lat')).toBe(-90);
        expect(parseCoordinate('90.1', 'lat')).toBeNull();
        expect(parseCoordinate('180', 'lng')).toBe(180);
        expect(parseCoordinate('180.1', 'lng')).toBeNull();
        // A transposed pair: a valid longitude is not a valid latitude.
        expect(parseCoordinate('120', 'lat')).toBeNull();
        expect(parseCoordinate('120', 'lng')).toBe(120);
    });
});

describe('createPopupContent', () => {
    const base = { id: 'e1', label: 'Site', lat: 51.5074, lng: -0.1278, entityId: 'e1' };

    it('renders frontmatter as text, never as markup', () => {
        // Every one of these fields is written by the AI agent into note frontmatter, and
        // Leaflet assigns popup content with innerHTML. The renderer has no CSP and
        // exposes window.api, so an executing payload here reaches the IPC bridge.
        const payload = '<img src=x onerror="window.__pwned = true">';
        const popup = createPopupContent({
            ...base,
            label: payload,
            address: payload,
            city: payload,
            country: payload,
        } as any);

        expect(popup.querySelectorAll('img').length).toBe(0);
        expect(popup.querySelectorAll('script').length).toBe(0);
        expect(popup.innerHTML).not.toContain('<img');
        expect(popup.innerHTML).toContain('&lt;img');
        expect(popup.textContent).toContain(payload);
    });

    it('shows coordinates and omits the fields that are absent', () => {
        const popup = createPopupContent({ ...base, label: 'Embassy' } as any);
        expect(popup.textContent).toContain('Embassy');
        expect(popup.textContent).toContain('51.507400, -0.127800');
    });

    it('joins city and country, and drops the line when both are missing', () => {
        const withBoth = createPopupContent({ ...base, city: 'London', country: 'UK' } as any);
        expect(withBoth.textContent).toContain('London, UK');
        const withOne = createPopupContent({ ...base, city: 'London' } as any);
        expect(withOne.textContent).toContain('London');
        expect(withOne.textContent).not.toContain(', ,');
    });
});

describe('entityHasMapCoordinates', () => {
    const at = (latitude: unknown, longitude: unknown) =>
        ({ id: 'e', type: 'Location', properties: { latitude, longitude } }) as any;

    it('counts zero as present', () => {
        // Null Island is a coordinate. `!entity.properties.latitude` sent it to the
        // geocoder, which overwrote it.
        expect(entityHasMapCoordinates(at(0, 0))).toBe(true);
        expect(entityHasMapCoordinates(at('0', '0'))).toBe(true);
    });

    it('rejects a partial or absent pair', () => {
        expect(entityHasMapCoordinates(at(51.5, undefined))).toBe(false);
        expect(entityHasMapCoordinates(at(undefined, -0.12))).toBe(false);
        expect(entityHasMapCoordinates(at('', ''))).toBe(false);
        expect(entityHasMapCoordinates(at(undefined, undefined))).toBe(false);
    });
});

describe('shouldClaimBaseLayer', () => {
    it('lets any imagery source take the map from the bare grid', () => {
        // The grid is a placeholder while the real sources resolve, not a choice.
        expect(shouldClaimBaseLayer(ONLINE_LAYER_NAME, GRID_LAYER_NAME, false)).toBe(true);
        expect(shouldClaimBaseLayer(CUSTOM_LAYER_NAME, GRID_LAYER_NAME, false)).toBe(true);
        expect(shouldClaimBaseLayer(OFFLINE_LAYER_NAME, GRID_LAYER_NAME, false)).toBe(true);
    });

    it('ranks the offline archive above every online provider', () => {
        // It is the only basemap that emits no tile requests, so a configured archive
        // wins regardless of which source happened to resolve first.
        expect(shouldClaimBaseLayer(OFFLINE_LAYER_NAME, ONLINE_LAYER_NAME, false)).toBe(true);
        expect(shouldClaimBaseLayer(OFFLINE_LAYER_NAME, CUSTOM_LAYER_NAME, false)).toBe(true);
        expect(shouldClaimBaseLayer(ONLINE_LAYER_NAME, OFFLINE_LAYER_NAME, false)).toBe(false);
        expect(shouldClaimBaseLayer(CUSTOM_LAYER_NAME, OFFLINE_LAYER_NAME, false)).toBe(false);
    });

    it('makes arrival order irrelevant between equally ranked online sources', () => {
        // Whichever lands first keeps the map; the later one does not thrash it.
        expect(shouldClaimBaseLayer(CUSTOM_LAYER_NAME, ONLINE_LAYER_NAME, false)).toBe(false);
        expect(shouldClaimBaseLayer(ONLINE_LAYER_NAME, CUSTOM_LAYER_NAME, false)).toBe(false);
    });

    it('never overrides a layer the user picked by hand', () => {
        // A slow archive resolving after the user chose the grid must not yank it back.
        expect(shouldClaimBaseLayer(OFFLINE_LAYER_NAME, GRID_LAYER_NAME, true)).toBe(false);
        expect(shouldClaimBaseLayer(ONLINE_LAYER_NAME, GRID_LAYER_NAME, true)).toBe(false);
    });

    it('claims onto an empty map and never re-claims the same layer', () => {
        expect(shouldClaimBaseLayer(GRID_LAYER_NAME, '', false)).toBe(true);
        expect(shouldClaimBaseLayer(OFFLINE_LAYER_NAME, OFFLINE_LAYER_NAME, false)).toBe(false);
        expect(shouldClaimBaseLayer(GRID_LAYER_NAME, GRID_LAYER_NAME, false)).toBe(false);
    });
});
