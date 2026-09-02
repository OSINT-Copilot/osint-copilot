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
