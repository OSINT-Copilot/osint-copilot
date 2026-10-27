import { describe, it, expect } from 'vitest';
import { geocodeFieldsFor, geocodeResultUpdates } from '../views/map-view';
import type { GeocodingResult } from '../services/geocoding-service';

const entity = (type: string, properties: Record<string, unknown>) =>
    ({ id: 'e1', type, label: 'Somewhere', properties }) as any;

const hit: GeocodingResult = {
    latitude: 51.5, longitude: -0.12, displayName: 'x',
    city: 'London', state: 'Greater London', country: 'UK', postalCode: 'SW1A', confidence: 'high',
};

describe('geocodeFieldsFor', () => {
    it('reads the Address schema case-insensitively', () => {
        // The per-row button compared `=== 'Address'` exactly while the list feeding it
        // was built case-insensitively, so this note reached the geocoder with no address.
        const f = geocodeFieldsFor(entity('address', {
            street: '10 Downing St', city: 'London', state: 'GL', country: 'UK',
        }));
        expect(f).toEqual({ address: '10 Downing St', city: 'London', state: 'GL', country: 'UK', isAddress: true });
    });

    it('falls back from street to full for an Address', () => {
        const f = geocodeFieldsFor(entity('Address', { full: '10 Downing St, London' }));
        expect(f.address).toBe('10 Downing St, London');
        expect(f.isAddress).toBe(true);
    });

    it('treats GeoLocation and a lowercase location like Location', () => {
        for (const type of ['GeoLocation', 'location', 'Location']) {
            const f = geocodeFieldsFor(entity(type, { address: 'Trafalgar Square', city: 'London' }));
            expect(f.address).toBe('Trafalgar Square');
            expect(f.city).toBe('London');
            expect(f.state).toBeUndefined();
            expect(f.isAddress).toBe(false);
        }
    });

    it('sends nothing for blank fields rather than the string "undefined"', () => {
        const f = geocodeFieldsFor(entity('Location', { address: '', city: undefined }));
        expect(f.address).toBeUndefined();
        expect(f.city).toBeUndefined();
        expect(f.country).toBeUndefined();
    });
});

describe('geocodeResultUpdates', () => {
    it('always writes coordinates and fills only the blanks', () => {
        const e = entity('Location', { address: 'x', city: 'Paris' });
        const u = geocodeResultUpdates(e, geocodeFieldsFor(e), hit);
        // city was on the note and is kept; state and postal code are Address-only fields.
        expect(u).toEqual({ latitude: 51.5, longitude: -0.12, country: 'UK' });
    });

    it('writes state and postal code for an Address, never over an existing postal code', () => {
        const blank = entity('address', { street: 'x' });
        expect(geocodeResultUpdates(blank, geocodeFieldsFor(blank), hit)).toEqual({
            latitude: 51.5, longitude: -0.12, city: 'London', state: 'Greater London', country: 'UK', postalCode: 'SW1A',
        });
        const withPostal = entity('Address', { street: 'x', postalCode: 'E1' });
        expect(geocodeResultUpdates(withPostal, geocodeFieldsFor(withPostal), hit)).not.toHaveProperty('postalCode');
    });
});
