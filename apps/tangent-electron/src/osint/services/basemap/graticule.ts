/**
 * A latitude/longitude grid, computed rather than fetched.
 *
 * This is what makes the map usable with no basemap at all — the air-gapped case, and
 * the case where a tile provider is down. A marker at 51.5/-0.1 on a blank canvas means
 * nothing; the same marker against a labelled grid is positioned. No data ships and no
 * network is touched.
 *
 * Pure functions, so the spacing and line generation are unit-testable without Leaflet.
 */

export interface GraticuleBounds {
    south: number;
    west: number;
    north: number;
    east: number;
}

export interface GraticuleLine {
    /** 'lat' runs east-west at a fixed latitude; 'lng' runs north-south. */
    axis: 'lat' | 'lng';
    /** Degrees. */
    value: number;
}

/** Degrees between grid lines at a given zoom. Chosen so ~4-10 lines are visible. */
export function graticuleSpacingForZoom(zoom: number): number {
    if (zoom <= 2) return 30;
    if (zoom <= 4) return 10;
    if (zoom <= 6) return 5;
    if (zoom <= 8) return 1;
    if (zoom <= 10) return 0.5;
    if (zoom <= 13) return 0.1;
    return 0.01;
}

/** Rounds a value down to the nearest multiple of `spacing`, avoiding float drift. */
function floorTo(value: number, spacing: number): number {
    return Math.floor(value / spacing) * spacing;
}

/** Degrees are formatted to the precision the spacing actually distinguishes. */
export function formatDegrees(value: number, axis: 'lat' | 'lng', spacing: number): string {
    const decimals = spacing >= 1 ? 0 : spacing >= 0.1 ? 1 : 2;
    const hemisphere = axis === 'lat'
        ? (value >= 0 ? 'N' : 'S')
        : (value >= 0 ? 'E' : 'W');
    return `${Math.abs(value).toFixed(decimals)}°${hemisphere}`;
}

/**
 * The grid lines crossing `bounds` at `spacing`.
 *
 * Latitudes are clamped to the Web Mercator limit. Longitudes are generated across the
 * raw range, so a viewport spanning the antimeridian (west > east after wrapping, or an
 * east beyond 180) still produces a continuous set rather than an empty one.
 */
export function graticuleLines(bounds: GraticuleBounds, spacing: number): GraticuleLine[] {
    if (!(spacing > 0)) return [];
    const lines: GraticuleLine[] = [];
    const MERCATOR_LIMIT = 85.05112878;

    const south = Math.max(bounds.south, -MERCATOR_LIMIT);
    const north = Math.min(bounds.north, MERCATOR_LIMIT);
    for (let lat = floorTo(south, spacing); lat <= north; lat += spacing) {
        if (lat < south) continue;
        lines.push({ axis: 'lat', value: Number(lat.toFixed(6)) });
    }

    // A viewport can legitimately report an east beyond 180 after panning; keep going
    // rather than returning nothing, and cap the count so a pathological range cannot
    // generate an unbounded array.
    const maxLines = 512;
    let count = 0;
    for (let lng = floorTo(bounds.west, spacing); lng <= bounds.east && count < maxLines; lng += spacing) {
        if (lng < bounds.west) continue;
        lines.push({ axis: 'lng', value: Number(lng.toFixed(6)) });
        count++;
    }

    return lines;
}
