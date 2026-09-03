/**
 * Basemap description, kept free of Leaflet and pmtiles so it is unit-testable.
 */
import type { BasemapProblem } from '../../host/types';

/** PMTiles v3 header tileType. */
export type BasemapRenderer = 'vector' | 'raster';

export function rendererForTileType(tileType: number): BasemapRenderer | null {
    if (tileType === 1) return 'vector';
    if (tileType >= 2 && tileType <= 5) return 'raster';
    return null;
}

/** Human copy for a failure to open the configured archive. */
export function basemapProblemMessage(problem: BasemapProblem, path: string): string {
    switch (problem) {
        case 'not-configured':
            return 'No offline basemap configured. The map shows a coordinate grid only.';
        case 'missing':
            return `Offline basemap not found at ${path}. It may be on a drive that isn't mounted.`;
        case 'not-a-file':
            return `${path} is not a file.`;
        case 'unreadable':
            return `Can't read ${path}. Check file permissions.`;
        case 'not-pmtiles':
            return `${path} isn't a PMTiles archive — it doesn't start with the PMTiles marker.`;
        case 'unsupported-version':
            return `${path} is an unsupported PMTiles version. This build reads v3; re-convert it with \`pmtiles convert\`.`;
        default:
            return `Offline basemap unavailable: ${path}`;
    }
}

/**
 * A tile URL template is only usable if it carries the placeholders Leaflet substitutes.
 * Checked because it is user-entered free text.
 */
export function isUsableTileUrl(url: string): boolean {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) return false;
    return trimmed.includes('{z}') && trimmed.includes('{x}') && trimmed.includes('{y}');
}


/**
 * OpenFreeMap: MIT-licensed, no API key, no registration, no usage limits, and
 * commercial use explicitly permitted -- the only provider found that is all four and
 * still global and street-level. Data is OpenStreetMap via the OpenMapTiles schema.
 *
 * It serves vector tiles, so it is drawn by MapLibre GL behind Leaflet rather than as
 * plain raster. The whole stack is open source and self-hostable, so an organisation can
 * point `mapOpenFreeMapStyleUrl` at its own instance and keep the same code path.
 */
export const OPEN_FREE_MAP_STYLES = ['positron', 'bright', 'liberty', 'dark'] as const;
export type OpenFreeMapStyle = typeof OPEN_FREE_MAP_STYLES[number];

/** Required by OpenFreeMap's terms. The OpenFreeMap credit itself is optional but asked for. */
export const OPEN_FREE_MAP_ATTRIBUTION =
    '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> ' +
    'Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export function openFreeMapStyleUrl(style: string): string {
    const chosen = (OPEN_FREE_MAP_STYLES as readonly string[]).includes(style)
        ? style
        : 'positron';
    return `https://tiles.openfreemap.org/styles/${chosen}`;
}

/** OpenFreeMap's TileJSON. The tile URL inside it carries a build date that rotates. */
export const OPEN_FREE_MAP_TILEJSON = 'https://tiles.openfreemap.org/planet';

/**
 * Pulls the tile URL template out of a TileJSON document.
 *
 * Needed because OpenFreeMap's tiles live under a dated path
 * (`/planet/20260830_080001_pt/{z}/{x}/{y}.pbf`) that changes with each weekly build, so
 * it cannot be hardcoded. Validated rather than trusted: this is remote JSON.
 */
export function tileUrlFromTileJson(doc: unknown): string | null {
    const tiles = (doc as { tiles?: unknown })?.tiles;
    if (!Array.isArray(tiles)) return null;
    for (const entry of tiles) {
        if (typeof entry === 'string' && isUsableTileUrl(entry)) return entry;
    }
    return null;
}
