/**
 * A minimal OpenMapTiles-schema theme for protomaps-leaflet.
 *
 * Why this exists rather than MapLibre GL: OpenFreeMap serves vector tiles, so something
 * has to draw them. MapLibre is the obvious choice, but it renders through WebGL and
 * offloads tile parsing to Web Workers, and in this app -- a webpack bundle served from
 * file:// -- the worker never starts. Observed directly: the style, its TileJSON and its
 * sprites all fetch, then MapLibre issues *zero* tile requests and reports no error.
 *
 * protomaps-leaflet draws on the main thread with Canvas2D. No workers, no WebGL, no
 * extra dependency (it is already here for the offline PMTiles basemap), and it is the
 * same renderer in both the online and offline paths.
 *
 * The rules are deliberately compact: this is a basemap for locating markers in an
 * investigation, not a cartographic product. Water, land cover, roads by class,
 * buildings, boundaries and place names -- enough to recognise where a pin is.
 */
import type { PaintRule, LabelRule } from 'protomaps-leaflet';
import {
    CenteredTextSymbolizer,
    LineSymbolizer,
    PolygonSymbolizer,
} from 'protomaps-leaflet';

export interface BasemapPalette {
    background: string;
    water: string;
    wood: string;
    grass: string;
    sand: string;
    urban: string;
    building: string;
    roadMajor: string;
    roadMinor: string;
    rail: string;
    boundary: string;
    label: string;
    labelHalo: string;
}

export const LIGHT_PALETTE: BasemapPalette = {
    background: '#f5f3ef',
    water: '#a8c8e0',
    wood: '#cfe0c3',
    grass: '#dbe8cd',
    sand: '#eee6d0',
    urban: '#ece9e4',
    building: '#dedad3',
    roadMajor: '#ffffff',
    roadMinor: '#f7f5f2',
    rail: '#c4bfb8',
    boundary: '#9c93a8',
    label: '#40454d',
    labelHalo: '#ffffffcc',
};

export const DARK_PALETTE: BasemapPalette = {
    background: '#22262b',
    water: '#1b3b52',
    wood: '#26332a',
    grass: '#2a3a2d',
    sand: '#33302a',
    urban: '#2b2f35',
    building: '#343941',
    roadMajor: '#4a5058',
    roadMinor: '#3a3f46',
    rail: '#4d5259',
    boundary: '#6d6478',
    label: '#c6ccd4',
    labelHalo: '#12151899',
};

/** OpenMapTiles puts every road in `transportation`, discriminated by `class`. */
const MAJOR_ROADS = ['motorway', 'trunk', 'primary'];
const MINOR_ROADS = ['secondary', 'tertiary', 'minor', 'street', 'service'];

export function openMapTilesPaintRules(p: BasemapPalette): PaintRule[] {
    return [
        {
            dataLayer: 'landcover',
            symbolizer: new PolygonSymbolizer({
                fill: (_z, f) => {
                    const cls = String(f?.props?.class ?? '');
                    if (cls === 'wood' || cls === 'forest') return p.wood;
                    if (cls === 'sand' || cls === 'desert') return p.sand;
                    return p.grass;
                },
            }),
        },
        { dataLayer: 'park', symbolizer: new PolygonSymbolizer({ fill: p.grass }) },
        { dataLayer: 'landuse', minzoom: 8, symbolizer: new PolygonSymbolizer({ fill: p.urban, opacity: 0.6 }) },
        { dataLayer: 'water', symbolizer: new PolygonSymbolizer({ fill: p.water }) },
        { dataLayer: 'waterway', symbolizer: new LineSymbolizer({ color: p.water, width: 1 }) },
        {
            dataLayer: 'building',
            minzoom: 13,
            symbolizer: new PolygonSymbolizer({ fill: p.building }),
        },
        // Minor roads first so major ones draw over them.
        {
            dataLayer: 'transportation',
            minzoom: 11,
            filter: (_z, f) => MINOR_ROADS.includes(String(f?.props?.class ?? '')),
            symbolizer: new LineSymbolizer({ color: p.roadMinor, width: 1.2 }),
        },
        {
            dataLayer: 'transportation',
            minzoom: 5,
            filter: (_z, f) => MAJOR_ROADS.includes(String(f?.props?.class ?? '')),
            symbolizer: new LineSymbolizer({
                color: p.roadMajor,
                width: (z) => (z < 9 ? 0.8 : z < 13 ? 1.6 : 2.6),
            }),
        },
        {
            dataLayer: 'transportation',
            minzoom: 9,
            filter: (_z, f) => String(f?.props?.class ?? '') === 'rail',
            symbolizer: new LineSymbolizer({ color: p.rail, width: 0.8, dash: [3, 3] }),
        },
        {
            dataLayer: 'boundary',
            filter: (_z, f) => Number(f?.props?.admin_level ?? 99) <= 2,
            symbolizer: new LineSymbolizer({ color: p.boundary, width: 1, dash: [4, 3] }),
        },
    ];
}

export function openMapTilesLabelRules(p: BasemapPalette): LabelRule[] {
    const text = (size: number) => new CenteredTextSymbolizer({
        labelProps: ['name:en', 'name'],
        fill: p.label,
        stroke: p.labelHalo,
        width: 2,
        font: `${size}px sans-serif`,
    });
    return [
        {
            dataLayer: 'place',
            minzoom: 3,
            filter: (_z, f) => ['city', 'town'].includes(String(f?.props?.class ?? '')),
            symbolizer: text(13),
        },
        {
            dataLayer: 'place',
            minzoom: 10,
            filter: (_z, f) => ['village', 'suburb', 'neighbourhood'].includes(String(f?.props?.class ?? '')),
            symbolizer: text(11),
        },
    ];
}
