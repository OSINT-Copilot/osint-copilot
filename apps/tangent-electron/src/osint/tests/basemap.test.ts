import { describe, it, expect, vi } from 'vitest';
import {
    basemapProblemMessage,
    isUsableTileUrl,
    normalizeBasemapTheme,
    tileUrlFromTileJson,
    rendererForTileType,
    OPEN_FREE_MAP_ATTRIBUTION,
    BASEMAP_THEMES,
} from '../services/basemap/basemap-types';
import {
    formatDegrees,
    graticuleLines,
    graticuleSpacingForZoom,
} from '../services/basemap/graticule';
import { IpcPMTilesSource } from '../services/basemap/ipc-pmtiles-source';
import type { BasemapArchive, Host } from '../host/types';

describe('basemap tile types', () => {
    it('maps the PMTiles v3 tileType byte to a renderer', () => {
        expect(rendererForTileType(1)).toBe('vector');
        for (const raster of [2, 3, 4, 5]) expect(rendererForTileType(raster)).toBe('raster');
        expect(rendererForTileType(0)).toBeNull();
        expect(rendererForTileType(99)).toBeNull();
    });
});

describe('tile URL validation', () => {
    it('requires a scheme and all three placeholders', () => {
        expect(isUsableTileUrl('https://example.com/{z}/{x}/{y}.png')).toBe(true);
        expect(isUsableTileUrl('  http://example.com/{z}/{x}/{y}.png  ')).toBe(true);
        expect(isUsableTileUrl('https://example.com/{z}/{x}.png')).toBe(false);
        expect(isUsableTileUrl('example.com/{z}/{x}/{y}.png')).toBe(false);
        expect(isUsableTileUrl('')).toBe(false);
    });
});

describe('basemap problem messages', () => {
    it('names the path so the analyst can act on it', () => {
        expect(basemapProblemMessage('missing', '/media/usb/uk.pmtiles')).toContain('/media/usb/uk.pmtiles');
        expect(basemapProblemMessage('not-configured', '')).toMatch(/coordinate grid/i);
        expect(basemapProblemMessage('not-pmtiles', '/tmp/x')).toMatch(/PMTiles marker/);
    });
});

describe('OpenFreeMap', () => {
    it('offers only the palettes this renderer can actually paint', () => {
        // Deliberately not OpenFreeMap's published style names. We consume raw vector
        // tiles and draw them with our own rules, so "positron"/"liberty" would be a
        // promise the renderer cannot keep -- and they mean nothing for an offline
        // archive, which the same palette has to cover.
        expect([...BASEMAP_THEMES]).toEqual(['auto', 'light', 'dark']);
    });

    it('falls back to following the app theme, including for the legacy style names', () => {
        // The value comes from a settings bag, so it can be anything -- including a
        // "positron" left behind by a build that offered the style dropdown.
        expect(normalizeBasemapTheme('light')).toBe('light');
        expect(normalizeBasemapTheme('dark')).toBe('dark');
        expect(normalizeBasemapTheme('positron')).toBe('auto');
        expect(normalizeBasemapTheme('liberty')).toBe('auto');
        expect(normalizeBasemapTheme(undefined)).toBe('auto');
        expect(normalizeBasemapTheme('')).toBe('auto');
    });

    it('carries the attribution OpenFreeMap requires', () => {
        // Required by their terms; the OpenFreeMap credit itself is optional but asked for.
        expect(OPEN_FREE_MAP_ATTRIBUTION).toContain('OpenMapTiles');
        expect(OPEN_FREE_MAP_ATTRIBUTION).toContain('OpenStreetMap');
        expect(OPEN_FREE_MAP_ATTRIBUTION).toContain('OpenFreeMap');
    });
});

describe('TileJSON parsing', () => {
    it('pulls the tile template out of a TileJSON document', () => {
        // OpenFreeMap's tiles sit under a dated path that rotates with each weekly build,
        // so the URL has to be read at runtime rather than hardcoded.
        const doc = { tiles: ['https://tiles.openfreemap.org/planet/20260830_080001_pt/{z}/{x}/{y}.pbf'] };
        expect(tileUrlFromTileJson(doc)).toBe(doc.tiles[0]);
    });

    it('refuses anything that is not a usable tile template', () => {
        // This is remote JSON, so it is validated rather than trusted.
        expect(tileUrlFromTileJson({ tiles: ['https://example.com/no-placeholders.pbf'] })).toBeNull();
        expect(tileUrlFromTileJson({ tiles: ['javascript:alert(1)'] })).toBeNull();
        expect(tileUrlFromTileJson({ tiles: [] })).toBeNull();
        expect(tileUrlFromTileJson({ tiles: 'not-an-array' })).toBeNull();
        expect(tileUrlFromTileJson({})).toBeNull();
        expect(tileUrlFromTileJson(null)).toBeNull();
    });

    it('skips unusable entries and takes the first good one', () => {
        expect(tileUrlFromTileJson({
            tiles: ['not a url', 'https://a.example/{z}/{x}/{y}.pbf'],
        })).toBe('https://a.example/{z}/{x}/{y}.pbf');
    });
});

describe('graticule', () => {
    it('widens the spacing as the map zooms out', () => {
        expect(graticuleSpacingForZoom(1)).toBe(30);
        expect(graticuleSpacingForZoom(5)).toBe(5);
        expect(graticuleSpacingForZoom(14)).toBe(0.01);
        // Monotonic: zooming in never coarsens the grid.
        for (let z = 1; z < 18; z++) {
            expect(graticuleSpacingForZoom(z + 1)).toBeLessThanOrEqual(graticuleSpacingForZoom(z));
        }
    });

    it('generates the lines crossing a viewport', () => {
        const lines = graticuleLines({ south: -5, west: -5, north: 5, east: 5 }, 5);
        const lats = lines.filter(l => l.axis === 'lat').map(l => l.value);
        const lngs = lines.filter(l => l.axis === 'lng').map(l => l.value);
        expect(lats).toEqual([-5, 0, 5]);
        expect(lngs).toEqual([-5, 0, 5]);
    });

    it('clamps latitude to the Web Mercator limit', () => {
        const lines = graticuleLines({ south: -90, west: 0, north: 90, east: 10 }, 30);
        const lats = lines.filter(l => l.axis === 'lat').map(l => l.value);
        expect(Math.max(...lats)).toBeLessThanOrEqual(85.06);
        expect(Math.min(...lats)).toBeGreaterThanOrEqual(-85.06);
    });

    it('cannot generate an unbounded number of lines', () => {
        // A pathological range must not hang the renderer.
        const lines = graticuleLines({ south: 0, west: -100000, north: 1, east: 100000 }, 0.01);
        expect(lines.length).toBeLessThan(1000);
    });

    it('refuses a non-positive spacing rather than looping forever', () => {
        expect(graticuleLines({ south: 0, west: 0, north: 1, east: 1 }, 0)).toEqual([]);
        expect(graticuleLines({ south: 0, west: 0, north: 1, east: 1 }, -5)).toEqual([]);
    });

    it('labels with a hemisphere and the precision the spacing distinguishes', () => {
        expect(formatDegrees(51.5, 'lat', 1)).toBe('52°N');
        expect(formatDegrees(-0.12, 'lng', 0.01)).toBe('0.12°W');
        expect(formatDegrees(0, 'lat', 1)).toBe('0°N');
    });
});

describe('IpcPMTilesSource', () => {
    const archive: BasemapArchive = {
        handleId: 'h1', path: '/tmp/uk.pmtiles', size: 1024, etag: 'e1',
    };
    const makeHost = (read: Host['basemap']['read']): Host['basemap'] => ({
        read,
        pick: vi.fn(), open: vi.fn(), forget: vi.fn(),
    } as unknown as Host['basemap']);

    it('keys the cache on the resolved archive path', () => {
        const source = new IpcPMTilesSource(archive, makeHost(vi.fn()));
        expect(source.getKey()).toBe('/tmp/uk.pmtiles');
    });

    it('passes the offset and length straight through', async () => {
        const read = vi.fn().mockResolvedValue({ data: new ArrayBuffer(8), etag: 'e1' });
        const source = new IpcPMTilesSource(archive, makeHost(read));
        const r = await source.getBytes(64, 8);
        expect(read).toHaveBeenCalledWith('h1', 64, 8);
        expect(r.data.byteLength).toBe(8);
    });

    it('reports an etag mismatch so pmtiles re-reads the header', async () => {
        // Without this, replacing the archive mid-session serves tiles through a stale
        // directory and renders garbage instead of failing.
        const read = vi.fn().mockResolvedValue({ data: new ArrayBuffer(4), etag: 'CHANGED' });
        const source = new IpcPMTilesSource(archive, makeHost(read));
        await expect(source.getBytes(0, 4, undefined, 'e1')).rejects.toThrow();
    });

    it('does not report a mismatch when no etag was expected', async () => {
        const read = vi.fn().mockResolvedValue({ data: new ArrayBuffer(4), etag: 'whatever' });
        const source = new IpcPMTilesSource(archive, makeHost(read));
        await expect(source.getBytes(0, 4)).resolves.toBeTruthy();
    });

    it('honours an abort signal before and after the read', async () => {
        const read = vi.fn().mockResolvedValue({ data: new ArrayBuffer(4), etag: 'e1' });
        const source = new IpcPMTilesSource(archive, makeHost(read));

        const preAborted = AbortSignal.abort();
        await expect(source.getBytes(0, 4, preAborted)).rejects.toMatchObject({ name: 'AbortError' });
        expect(read).not.toHaveBeenCalled();

        const controller = new AbortController();
        const late = vi.fn().mockImplementation(async () => {
            controller.abort();
            return { data: new ArrayBuffer(4), etag: 'e1' };
        });
        const source2 = new IpcPMTilesSource(archive, makeHost(late));
        await expect(source2.getBytes(0, 4, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });
});
