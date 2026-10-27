
/**
 * Map View for visualizing Location entities using Leaflet.
 */

import { App, ItemView, WorkspaceLeaf, Notice, Modal, Menu, TFile, normalizePath, requestUrl } from 'obsidian';
import { iconButton, setButtonLabel } from './toolbar-button';
import { type Entity, EntityType, ENTITY_CONFIGS } from '../entities/types';
import { EntityManager } from '../services/entity-manager';
import { EntityCreationModal } from '../modals/entity-modal';
import { GeocodingService, GeocodingError, geocodingService, type GeocodingResult } from '../services/geocoding-service';
import { host } from '../host';
import { entityHasMapCoordinates } from '../ui/vault-op-previews';
import { IpcPMTilesSource } from '../services/basemap/ipc-pmtiles-source';
import {
    basemapProblemMessage,
    normalizeBasemapTheme,
    isUsableTileUrl,
    rendererForTileType,
    tileUrlFromTileJson,
    OPEN_FREE_MAP_ATTRIBUTION,
    OPEN_FREE_MAP_TILEJSON,
} from '../services/basemap/basemap-types';
import {
    DARK_PALETTE,
    LIGHT_PALETTE,
    openMapTilesLabelRules,
    openMapTilesPaintRules,
} from '../services/basemap/openmaptiles-theme';
import { formatDegrees, graticuleLines, graticuleSpacingForZoom } from '../services/basemap/graticule';

// Leaflet types (simplified for bundling)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Leaflet library types not available
// Bundled, not CDN-injected: the map must work offline, and script-src is 'self'.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as LeafletLib from 'leaflet';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const L: any = LeafletLib;

export const MAP_VIEW_TYPE = 'graph_copilot-map-view';

/** Match Location/Address/GeoLocation notes regardless of YAML casing or stray whitespace. */
/** Address specifically, matched the same case-insensitive way as isLocationEntityType. */
export function isAddressEntityType(entityType: string | undefined): boolean {
    return String(entityType ?? '').trim().toLowerCase() === 'address';
}

export function isLocationEntityType(entityType: string | undefined): boolean {
    if (typeof entityType !== 'string') return false;
    const normalized = entityType.trim().toLowerCase();
    return normalized === 'location' || normalized === 'address' || normalized === 'geolocation';
}

/** What one entity sends to the geocoder, and which schema its answer is written back with. */
export interface GeocodeFields {
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    /** Address notes carry street/full/state/postalCode; every other location type has `address`. */
    isAddress: boolean;
}

/**
 * The address fields the geocoder is sent for one entity.
 *
 * One function for both paths of the geolocate dialog, which used to decide this
 * separately: the batch matched the type with isAddressEntityType while the per-row
 * button compared `=== EntityType.Location` and `=== 'Address'` exactly. A note typed
 * `address` or `GeoLocation` -- which isLocationEntityType had just admitted into the
 * list -- fell through both of the row's branches and went to Nominatim as an empty query.
 */
export function geocodeFieldsFor(entity: Entity): GeocodeFields {
    const p = entity.properties;
    // Present means truthy, as the `||` chains this replaces had it.
    const str = (v: unknown): string | undefined => (v ? String(v) : undefined);
    if (isAddressEntityType(entity.type)) {
        return {
            address: str(p.street) || str(p.full),
            city: str(p.city),
            state: str(p.state),
            country: str(p.country),
            isAddress: true,
        };
    }
    return { address: str(p.address), city: str(p.city), country: str(p.country), isAddress: false };
}

/** The frontmatter written back after a hit: coordinates always, the rest only where the note was blank. */
export function geocodeResultUpdates(
    entity: Entity,
    fields: GeocodeFields,
    result: GeocodingResult,
): Record<string, unknown> {
    const updates: Record<string, unknown> = {
        latitude: result.latitude,
        longitude: result.longitude,
    };
    if (result.city && !fields.city) updates.city = result.city;
    if (result.state && !fields.state && fields.isAddress) updates.state = result.state;
    if (result.country && !fields.country) updates.country = result.country;
    if (result.postalCode && fields.isAddress && !entity.properties.postalCode) {
        updates.postalCode = result.postalCode;
    }
    return updates;
}

/** Class stem for the toolbar buttons; see iconButton. */
const BTN = 'graph_copilot-map-btn';

// Leaflet CSS inlined to avoid CSP issues with external stylesheets
// Leaflet CSS moved to styles.css

export interface MapLocation {
    id: string;
    label: string;
    lat: number;
    lng: number;
    address?: string;
    city?: string;
    country?: string;
}

/** Always present, always offline: the map is never blank. */
export const GRID_LAYER_NAME = 'Coordinate grid';
export const OFFLINE_LAYER_NAME = 'Offline basemap';
export const CUSTOM_LAYER_NAME = 'Online tiles';
export const ONLINE_LAYER_NAME = 'OpenFreeMap';

/** Shown only when the grid really is all there is, and phrased as a next step. */
const NO_BASEMAP_HINT = 'No basemap \u2014 showing a coordinate grid. '
    + 'Pick one in Settings \u2192 OSINT Copilot \u2192 Map.';

/** Shown while a basemap is still resolving, so the wait is never an unexplained blank. */
const LOADING_BASEMAP_HINT = 'Loading basemap\u2026';

/**
 * Which basemap wins when more than one becomes available.
 *
 * Three sources race for the map: the grid is synchronous, the online layer resolves a
 * TileJSON over the network, and the offline archive opens a file over IPC. Whichever
 * finished last used to be whichever the user got. Ranking them makes the outcome the
 * same every time: an offline archive beats an online provider because it is the one that
 * leaks nothing, and anything with imagery beats the bare grid.
 */
const BASE_LAYER_RANK: Record<string, number> = {
    [GRID_LAYER_NAME]: 0,
    [CUSTOM_LAYER_NAME]: 1,
    [ONLINE_LAYER_NAME]: 1,
    [OFFLINE_LAYER_NAME]: 2,
};

/**
 * The rule itself, separated from Leaflet so it can be tested without a map.
 *
 * `current` is the name of the layer on the map ('' before anything is added).
 */
export function shouldClaimBaseLayer(incoming: string, current: string, userPicked: boolean): boolean {
    if (userPicked) return false;
    return (BASE_LAYER_RANK[incoming] ?? 0) > (BASE_LAYER_RANK[current] ?? -1);
}


/**
 * Parse a frontmatter coordinate, or refuse it.
 *
 * Stricter than parseFloat on purpose. parseFloat("12,5") silently returns 12 --
 * dropping a comma decimal separator and moving the pin hundreds of kilometres with no
 * error -- and parseFloat("48.1 N") returns 48.1. Anything that is not cleanly a number
 * is refused rather than half-read, and the result is range-checked so a transposed
 * lat/lng cannot put a marker off the projection.
 */
export function parseCoordinate(value: string | number | undefined, axis: 'lat' | 'lng'): number | null {
    if (value === undefined || value === null || value === '') return null;

    let num: number;
    if (typeof value === 'number') {
        num = value;
    } else {
        const text = String(value).trim();
        // Only a plain signed decimal. Rejects "12,5", "48.1 N", "1e5deg".
        if (!/^[+-]?\d+(\.\d+)?$/.test(text)) {
            console.debug('[MapView] refusing an ambiguous coordinate:', value);
            return null;
        }
        num = Number(text);
    }

    if (!Number.isFinite(num)) return null;
    const limit = axis === 'lat' ? 90 : 180;
    if (num < -limit || num > limit) {
        console.debug(`[MapView] ${axis} out of range:`, num);
        return null;
    }
    return num;
}

/**
 * Whether the map would plot this entity: a location type (Location, Address or
 * GeoLocation, any casing) whose coordinates parseCoordinate accepts -- 0 included.
 * The exact rule of refresh() and parseLocations, exported so the graph's double
 * border, its "Show on Map" item and showEntityOnMap cannot promise a pin the map refuses.
 */
export function isMappableEntity(entity: Entity): boolean {
    const p = entity.properties;
    return isLocationEntityType(entity.type)
        && parseCoordinate(p.latitude as string | number | undefined, 'lat') !== null
        && parseCoordinate(p.longitude as string | number | undefined, 'lng') !== null;
}

export function createPopupContent(location: MapLocation): HTMLElement {
    const root = document.createElement('div');
    root.addClass('graph_copilot-map-popup');

    root.createEl('strong', { text: location.label });

    if (location.address) {
        root.createEl('br');
        root.createEl('small', { text: location.address });
    }

    const parts = [location.city, location.country].filter(Boolean) as string[];
    if (parts.length > 0) {
        root.createEl('br');
        root.createEl('small', { text: parts.join(', ') });
    }

    root.createEl('br');
    root.createEl('small', {
        text: `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`,
        cls: 'graph_copilot-map-popup-coords',
    });

    root.createEl('br');
    root.createEl('small', {
        text: 'Double-click the marker to open its note',
        cls: 'graph_copilot-map-popup-hint',
    });

    return root;
}

export class MapView extends ItemView {
    private entityManager: EntityManager;
    private vaultRefreshTimer: number | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Leaflet map instance
    private map: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Leaflet markers
    private markers: Map<string, any> = new Map();
    private container: HTMLElement | null = null;
    private onLocationClick: ((entityId: string) => void) | null = null;
    private geocodingService: GeocodingService;

    /**
     * Leaflet installs nothing of its own -- no ResizeObserver, no ancestor
     * transitionend/animationend listeners -- so every size change has to be pushed in
     * with invalidateSize(). The host detaches and re-attaches our DOM across panel
     * remounts, Tangent animates panels and the thread width, and extraTop/extraBottom
     * change at runtime. Hence an observer for the steady state and an attach hook for
     * the ordering; both call the same idempotent invalidate.
     */
    private resizeObserver: ResizeObserver | null = null;
    private invalidateTimer: number | null = null;
    private lastSize = { width: 0, height: 0 };
    /** A fit deferred because the map had no usable size when it was asked. */
    private fitPending = false;
    /** Fit once when markers first arrive; never again, or refresh steals the viewport. */
    private hasFitOnce = false;
    /** refresh() is reachable from eight places, three of them floating promises. */
    private refreshInFlight: Promise<void> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Leaflet control
    private layerControl: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Leaflet layers by name
    private baseLayers: Record<string, any> = {};
    private activeBaseLayerName = '';
    /** Set once the user picks a layer by hand; after that nothing auto-selects over them. */
    private userPickedBaseLayer = false;
    /**
     * True while claimBaseLayer() is doing its own addTo().
     *
     * L.Control.Layers binds 'baselayerchange' to the LAYER's own add event
     * (leaflet-src.js:5264 `layer.on('add remove', this._onLayerChange, this)`), not to the
     * radio click -- its doc comment says otherwise. So a programmatic addTo() is
     * indistinguishable from a user click unless we say so, and our first auto-claim would
     * otherwise mark itself as a manual pick and freeze every later claim: an offline
     * archive resolving after the online layer could never take precedence.
     */
    private claimingBaseLayer = false;
    /** Basemap sources still resolving. The strip stays quiet until they have all landed. */
    private basemapPending = 0;
    /** A real failure (not merely "unconfigured"), shown only if nothing else arrives. */
    private deferredBasemapProblem = '';
    /** A *configured* offline archive that failed. Always surfaced, whatever else loads. */
    private offlineBasemapProblem = '';
    private basemapStatusEl: HTMLElement | null = null;
    private refreshBtn: HTMLButtonElement | null = null;
    /** The "nothing has coordinates yet" overlay, present only while that is true. */
    private emptyStateEl: HTMLElement | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        entityManager: EntityManager,
        onLocationClick?: (entityId: string) => void
    ) {
        super(leaf);
        this.entityManager = entityManager;
        this.onLocationClick = onLocationClick || null;
        // The exported singleton, not a new instance: rate limiting is per-instance, so
        // two open map views would otherwise double Nominatim's 1 req/s allowance.
        this.geocodingService = geocodingService;
    }

    getViewType(): string {
        return MAP_VIEW_TYPE;
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('graph_copilot-map-container');

        // Create toolbar
        const toolbar = container.createDiv({ cls: 'graph_copilot-map-toolbar' });
        this.createToolbar(toolbar);

        // A line of its own under the toolbar, not a flex item inside it: as a toolbar
        // item the sentence could not wrap and was the first thing squeezed.
        container.createDiv({
            cls: 'graph_copilot-map-hint',
            text: 'Shows Location and Address entities that have latitude / longitude.',
        });

        // Create map container
        // No id, and no inline height. The id was the old way of finding this element
        // (see initializeMap) and the inline `height: calc(100% - 50px)` was a hardcoded
        // guess at the toolbar height that fought the `flex: 1` in styles.css.
        this.container = container.createDiv({ cls: 'graph_copilot-map-canvas' });

        const basePrefix = normalizePath(this.entityManager.getBasePath()).toLowerCase() + '/';

        const scheduleRefreshFromPath = (path: string): void => {
            if (!path.replace(/\\/g, '/').toLowerCase().startsWith(basePrefix)) return;
            if (this.vaultRefreshTimer !== null) {
                window.clearTimeout(this.vaultRefreshTimer);
            }
            this.vaultRefreshTimer = window.setTimeout(() => {
                this.vaultRefreshTimer = null;
                void this.refresh();
            }, 400);
        };

        this.registerEvent(
            this.app.vault.on('modify', (f) => {
                if (f instanceof TFile && f.extension === 'md') scheduleRefreshFromPath(f.path);
            }),
        );
        this.registerEvent(
            this.app.vault.on('create', (f) => {
                if (f instanceof TFile && f.extension === 'md') scheduleRefreshFromPath(f.path);
            }),
        );
        this.registerEvent(
            this.app.vault.on('delete', (f) => {
                if (f instanceof TFile && f.extension === 'md') scheduleRefreshFromPath(f.path);
            }),
        );
        this.registerEvent(
            this.app.vault.on('rename', (f, oldPath) => {
                if (f instanceof TFile && f.extension === 'md') scheduleRefreshFromPath(f.path);
                if (typeof oldPath === 'string') scheduleRefreshFromPath(oldPath);
            }),
        );

        // The map is built last, and deliberately after the vault subscriptions above:
        // when this threw, it took the whole rest of onOpen() with it and left the view
        // silently deaf to every note change as well as mapless.
        await this.loadLeaflet();
        this.initializeMap();

        void this.refresh();
    }

    // ---------------------------------------------------------------- attachment

    protected onAttached(): void {
        this.observeCanvas();
        // One-shot, because a ResizeObserver that has only ever seen 0x0 may have
        // nothing to report a change *from*, and under jsdom it is a stub that never
        // fires at all.
        requestAnimationFrame(() => this.invalidateNow());
    }

    protected onDetached(): void {
        this.unobserveCanvas();
    }

    private observeCanvas(): void {
        if (this.resizeObserver || !this.container) return;
        if (typeof ResizeObserver === 'undefined') return;
        this.resizeObserver = new ResizeObserver((entries) => {
            const box = entries[entries.length - 1]?.contentRect;
            if (!box) return;
            // 0x0 means detached, hidden, or mid-collapse. lastSize is deliberately NOT
            // updated, so a detach-and-reattach at the same size stays a no-op.
            if (box.width < 1 || box.height < 1) return;
            if (Math.abs(box.width - this.lastSize.width) < 1
                && Math.abs(box.height - this.lastSize.height) < 1) return;
            this.lastSize = { width: box.width, height: box.height };
            this.scheduleInvalidate();
        });
        this.resizeObserver.observe(this.container);
    }

    private unobserveCanvas(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.invalidateTimer !== null) {
            window.clearTimeout(this.invalidateTimer);
            this.invalidateTimer = null;
        }
    }

    /**
     * Trailing debounce. Tangent's width transition emits a record per frame for 300ms,
     * and invalidateSize relays every pane and marker, so running it eighteen times is
     * visible.
     */
    private scheduleInvalidate(): void {
        if (this.invalidateTimer !== null) window.clearTimeout(this.invalidateTimer);
        this.invalidateTimer = window.setTimeout(() => {
            this.invalidateTimer = null;
            this.invalidateNow();
        }, 120);
    }

    private invalidateNow(): void {
        const canvas = this.container;
        if (!this.map || !canvas?.isConnected) return;
        if (canvas.clientWidth < 1 || canvas.clientHeight < 1) return;
        this.lastSize = { width: canvas.clientWidth, height: canvas.clientHeight };
        // pan:true (the default) is mandatory here, not cosmetic. invalidateSize computes
        // offset = oldSize/2 - newSize/2 and only applies it when pan is true; going from
        // the 0x0 the map was created at to a real viewport, pan:false would leave every
        // layer displaced by half a screen.
        this.map.invalidateSize({ animate: false, pan: true, debounceMoveend: true });
        if (this.fitPending) {
            this.fitPending = false;
            this.fitAllMarkers();
        }
    }

    async onClose(): Promise<void> {
        if (this.vaultRefreshTimer !== null) {
            window.clearTimeout(this.vaultRefreshTimer);
            this.vaultRefreshTimer = null;
        }
        // Initialize handlers
        if (this.map && this.map._handlers) {
            // (Removed: a loop that re-enabled Leaflet's internal _handlers immediately
            // before destroying the map.)
        }
        if (this.map) {
            this.map.remove();
            this.map = null;
        }
        this.markers.clear();
        this.emptyStateEl = null;
    }

    // ------------------------------------------------------------------ basemaps

    /**
     * A latitude/longitude grid drawn from computed lines. Zero data, zero network, so
     * it works air-gapped and can never fail — which is what makes it safe to use as the
     * layer the map starts on and falls back to.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Leaflet layer
    private createGraticuleLayer(): any {
        const group = L.layerGroup();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const self = this;

        const redraw = (): void => {
            if (!self.map) return;
            group.clearLayers();
            const zoom = self.map.getZoom();
            const spacing = graticuleSpacingForZoom(zoom);
            const b = self.map.getBounds();
            const lines = graticuleLines({
                south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast(),
            }, spacing);

            for (const line of lines) {
                const coords = line.axis === 'lat'
                    ? [[line.value, b.getWest()], [line.value, b.getEast()]]
                    : [[b.getSouth(), line.value], [b.getNorth(), line.value]];
                L.polyline(coords, {
                    className: 'osint-map-graticule',
                    interactive: false,
                }).addTo(group);

                const at = line.axis === 'lat'
                    ? [line.value, b.getWest()]
                    : [b.getSouth(), line.value];
                L.marker(at, {
                    interactive: false,
                    icon: L.divIcon({
                        className: 'osint-map-graticule-label',
                        html: '',
                    }),
                }).addTo(group).bindTooltip(formatDegrees(line.value, line.axis, spacing), {
                    permanent: true,
                    direction: line.axis === 'lat' ? 'right' : 'top',
                    className: 'osint-map-graticule-tooltip',
                });
            }
        };

        group.on('add', () => {
            redraw();
            self.map?.on('moveend zoomend', redraw);
        });
        group.on('remove', () => {
            self.map?.off('moveend zoomend', redraw);
            group.clearLayers();
        });

        return group;
    }

    /**
     * A raster tile layer from the user's own provider, under their own account and
     * terms. Synchronous, so it can be added while the map is being built.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Leaflet layer
    private createCustomTileLayer(): any | null {
        const settings = this.mapSettings();
        if (settings.provider !== 'custom') return null;
        if (!isUsableTileUrl(settings.url)) return null;
        return L.tileLayer(settings.url.trim(), {
            attribution: settings.attribution || '',
            maxZoom: 19,
            crossOrigin: 'anonymous',
        });
    }

    /**
     * OpenFreeMap, drawn by MapLibre GL underneath Leaflet.
     *
     * OpenFreeMap serves vector tiles, so there is no raster URL to hand L.tileLayer.
     * They are drawn by protomaps-leaflet on a 2D canvas, with the OpenMapTiles rule set
     * in openmaptiles-theme.ts. MapLibre would be the obvious renderer, but its tile
     * parsing runs in a Web Worker that never starts in this webpack/file:// renderer --
     * style, TileJSON and sprites all fetch, then zero tile requests and no error.
     *
     * The renderer is imported dynamically, and it is the same one the offline PMTiles
     * basemap uses -- so an online basemap costs no extra dependency at all.
     */
    private async attachOpenFreeMapLayer(): Promise<void> {
        const settings = this.mapSettings();
        if (settings.provider !== 'openfreemap') return;
        this.basemapPending++;
        try {
            // The tile URL lives inside the TileJSON under a dated path that rotates with
            // each weekly build, so it is resolved at runtime rather than hardcoded.
            // Fetched through our guarded IPC, not the renderer, so it is subject to the
            // same egress checks as every other request we control.
            const response = await requestUrl({ url: OPEN_FREE_MAP_TILEJSON, throw: false });
            if (response.status >= 400) {
                this.deferredBasemapProblem = `OpenFreeMap is not reachable (HTTP ${response.status}). `
                    + 'Check the network, or set an offline basemap in Settings \u2192 OSINT Copilot \u2192 Map.';
                return;
            }
            const tileUrl = tileUrlFromTileJson(response.json);
            if (!tileUrl) {
                this.deferredBasemapProblem = 'OpenFreeMap returned a tile list this build cannot use.';
                return;
            }
            if (!this.map) return;

            const protomaps = await import('protomaps-leaflet');
            const palette = this.basemapPalette();
            const layer = protomaps.leafletLayer({
                url: tileUrl,
                paintRules: openMapTilesPaintRules(palette),
                labelRules: openMapTilesLabelRules(palette),
                backgroundColor: palette.background,
                attribution: OPEN_FREE_MAP_ATTRIBUTION,
                maxDataZoom: 14,
            });

            this.claimBaseLayer(ONLINE_LAYER_NAME, layer);
        } catch (e) {
            console.error('[MapView] could not load the online basemap:', e);
            this.deferredBasemapProblem = 'The online basemap could not be loaded \u2014 '
                + 'usually no network. Showing a coordinate grid; an offline basemap works air-gapped.';
        } finally {
            this.basemapPending--;
            this.refreshBasemapStatus();
        }
    }

    private async attachOfflineBasemap(): Promise<void> {
        this.basemapPending++;
        try {
            await this.openOfflineBasemap();
        } finally {
            this.basemapPending--;
            this.refreshBasemapStatus();
        }
    }

    private async openOfflineBasemap(): Promise<void> {
        let result;
        try {
            result = await host.basemap.open();
        } catch (e) {
            this.offlineBasemapProblem = `Offline basemap unavailable: ${e instanceof Error ? e.message : String(e)}`;
            return;
        }
        if (!this.map) return;

        if (!result.ok) {
            // Not an error when nothing was ever configured -- that is the default state,
            // and an online basemap may well be painting. Only a *configured* archive that
            // failed is worth saying out loud.
            if (result.problem !== 'not-configured') {
                this.offlineBasemapProblem = basemapProblemMessage(result.problem, result.path);
            }
            return;
        }

        try {
            const { PMTiles } = await import('pmtiles');
            const archive = new PMTiles(new IpcPMTilesSource(result.archive, host.basemap));
            const header = await archive.getHeader();
            const kind = rendererForTileType(header.tileType);
            if (!kind) {
                this.offlineBasemapProblem =
                    `This archive holds tile type ${header.tileType}, which this build can't draw.`;
                return;
            }

            const layer = kind === 'raster'
                ? await this.createRasterPmtilesLayer(archive, header)
                : await this.createVectorPmtilesLayer(archive);
            if (!this.map || !layer) return;

            // Outranks every other source: an analyst who configured an archive wants it,
            // and it is the only basemap that leaks nothing.
            this.claimBaseLayer(OFFLINE_LAYER_NAME, layer);
        } catch (e) {
            console.error('[MapView] could not read the offline basemap:', e);
            this.offlineBasemapProblem = 'The offline basemap could not be read. '
                + 'See Settings \u2192 OSINT Copilot \u2192 Map.';
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async createRasterPmtilesLayer(archive: any, header: any): Promise<any> {
        const { leafletRasterLayer } = await import('pmtiles');
        return leafletRasterLayer(archive, {
            maxNativeZoom: header.maxZoom,
            maxZoom: 19,
            attribution: 'Offline basemap',
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async createVectorPmtilesLayer(archive: any): Promise<any> {
        const protomaps = await import('protomaps-leaflet');
        // `flavor`, NOT our openMapTiles* rules -- the two are mutually exclusive
        // (protomaps-leaflet/src/frontends/leaflet.ts:82-91) and they target different
        // schemas. Our rules name OpenMapTiles layers (transportation, boundary), which is
        // right for OpenFreeMap; a .pmtiles extract from build.protomaps.com uses the
        // Protomaps schema (roads, boundaries), where those rules would match nothing and
        // the archive would draw as a blank sheet. `flavor` selects @protomaps/basemaps'
        // own rules, which do match it.
        //
        // The theme is still honoured -- that part of the hardcoded `flavor: 'light'` was
        // a real bug, painting a light basemap under a dark app.
        return protomaps.leafletLayer({
            attribution: 'Offline basemap',
            // The PMTiles instance directly, so tiles come through our IPC Source rather
            // than a URL. Labels are drawn with system fonts, so no glyph files ship.
            url: archive,
            flavor: this.basemapPalette() === DARK_PALETTE ? 'dark' : 'light',
        });
    }

    /**
     * The palette our vector rules paint with.
     *
     * Tangent themes by putting a class on <body>, so "auto" is read from there rather
     * than from a media query, which would report the OS preference and disagree with the
     * app whenever the user has overridden it.
     */
    private basemapPalette(): typeof LIGHT_PALETTE {
        const theme = this.mapSettings().theme;
        if (theme === 'light') return LIGHT_PALETTE;
        if (theme === 'dark') return DARK_PALETTE;
        return document.body.classList.contains('dark') ? DARK_PALETTE : LIGHT_PALETTE;
    }

    /**
     * Register a basemap and take the map if it outranks whatever is on it.
     *
     * Every basemap goes through here so registration and selection cannot drift apart.
     * They used to: the offline path added itself to the map, while the online path only
     * put itself in the layer control -- so a user who switched the provider to
     * OpenFreeMap in settings saw no change at all, and could only get imagery by finding
     * the unlabelled layers button and clicking a radio.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Leaflet layer
    private claimBaseLayer(name: string, layer: any): void {
        if (!this.map || !layer) return;

        this.baseLayers[name] = layer;
        this.layerControl?.addBaseLayer(layer, name);

        // A hand-picked layer is the user's decision; a slow archive or TileJSON landing
        // afterwards must not yank the map out from under them.
        if (!shouldClaimBaseLayer(name, this.activeBaseLayerName, this.userPickedBaseLayer)) return;

        const previous = this.baseLayers[this.activeBaseLayerName];
        // A base layer's 'remove' maps to no event (leaflet-src.js:5333), so only the add
        // needs guarding -- but the flag spans both so an exception cannot strand it set.
        this.claimingBaseLayer = true;
        try {
            // Add first, remove second. The other order leaves the map with NO base layer
            // if addTo() throws -- the exact blank canvas this change exists to prevent.
            layer.addTo(this.map);
            if (previous && previous !== layer) this.map.removeLayer(previous);
        } finally {
            this.claimingBaseLayer = false;
        }
        this.activeBaseLayerName = name;
        this.applyZoomLimitsForActiveLayer();
        this.markNoBasemapSurface();
        this.refreshBasemapStatus();
    }

    /** Marks the canvas when the grid is all there is, so CSS can give it a map surface. */
    private markNoBasemapSurface(): void {
        const canvas = this.container?.querySelector('.leaflet-container')
            ?? this.container?.closest('.leaflet-container');
        canvas?.classList.toggle('osint-map-no-basemap', this.activeBaseLayerName === GRID_LAYER_NAME);
    }

    /**
     * The status strip reflects the map's current state, not the last thing that failed.
     *
     * attachOfflineBasemap() runs unconditionally, so on a default install it reported
     * "No offline basemap configured" even when OpenFreeMap was painting perfectly --
     * a red warning sitting over a working map. The strip now says something only while
     * the grid is genuinely all there is.
     */
    private refreshBasemapStatus(): void {
        // Ahead of every early return below, or an offline failure would keep the deferred
        // grid cap from ever being applied.
        if (this.basemapPending === 0) this.applyZoomLimitsForActiveLayer();

        // A configured archive that failed is reported even when an online basemap is
        // painting happily. Staying quiet there would be the worse bug of the two: an
        // analyst who set up an offline basemap precisely so they could work air-gapped
        // would be silently served online tiles instead, and only find out in the field.
        if (this.offlineBasemapProblem) {
            this.setBasemapStatus(this.offlineBasemapProblem);
            return;
        }
        if (this.activeBaseLayerName !== GRID_LAYER_NAME) {
            this.setBasemapStatus('');
            return;
        }
        if (this.basemapPending > 0) {
            this.setBasemapStatus(LOADING_BASEMAP_HINT);
            return;
        }
        // Nagging someone to pick a basemap they just deliberately picked away from is the
        // same species of wrong message this whole change is about.
        if (this.userPickedBaseLayer) {
            this.setBasemapStatus('');
            return;
        }
        this.setBasemapStatus(this.deferredBasemapProblem || NO_BASEMAP_HINT);
    }

    /**
     * With no basemap there is nothing meaningful past z10.
     *
     * Not applied while a basemap is still resolving, though: capping at 10 during startup
     * clamps the one fitAllMarkers() the view ever performs, and nothing re-fits once
     * imagery arrives and the ceiling goes back up -- so a tight cluster of markers would
     * open zoomed out and stay there.
     */
    private applyZoomLimitsForActiveLayer(): void {
        if (!this.map) return;
        const gridOnly = this.activeBaseLayerName === GRID_LAYER_NAME && this.basemapPending === 0;
        this.map.setMaxZoom(gridOnly ? 10 : 19);
    }

    /**
     * MapView is constructed with (leaf, entityManager, onLocationClick) and has no
     * plugin reference, so the settings come off the runtime the bootstrap publishes --
     * the same route OsintSettings.svelte uses. Every field is re-validated here because
     * this is a plain settings bag, not a typed channel.
     */
    private mapSettings(): { provider: string; url: string; attribution: string; theme: string } {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- settings bag
        const s = (globalThis as any).osint?.plugin?.settings ?? {};
        return {
            provider: typeof s.mapOnlineTileProvider === 'string' ? s.mapOnlineTileProvider : 'none',
            url: typeof s.mapCustomTileUrl === 'string' ? s.mapCustomTileUrl : '',
            attribution: typeof s.mapCustomTileAttribution === 'string' ? s.mapCustomTileAttribution : '',
            theme: normalizeBasemapTheme(s.mapBasemapTheme),
        };
    }

    /** A persistent strip in the toolbar, not a toast: this is a state, not an event. */
    private setBasemapStatus(message: string): void {
        if (!this.basemapStatusEl) return;
        this.basemapStatusEl.setText(message);
        // The strip is narrow and the message is a full sentence, so the text was being
        // clipped mid-word -- and the clipped half was the half telling the user what to
        // do about it. The title makes the whole thing reachable on hover regardless.
        this.basemapStatusEl.title = message;
        this.basemapStatusEl.style.display = message ? '' : 'none';
        // Red is for something broken. A map with no basemap configured is a default, not
        // a fault, and colouring it as one is what made a working map look broken.
        const benign = message === NO_BASEMAP_HINT || message === LOADING_BASEMAP_HINT;
        this.basemapStatusEl.classList.toggle('is-problem', !benign);
    }

    /**
     * Load Leaflet library and CSS.
     */
    /** Leaflet is bundled; kept async so callers need no change. */
    private async loadLeaflet(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * Create the toolbar.
     *
     * Layout lives in styles.css (.graph_copilot-map-toolbar). The inline copy that used
     * to sit here beat the stylesheet, so nothing there -- flex-wrap included -- could
     * take effect, and any pane under ~700px grew a horizontal scrollbar.
     */
    private createToolbar(toolbar: HTMLElement): void {
        const addBtn = iconButton(toolbar, 'plus', 'Add location', BTN);
        addBtn.addClass('graph_copilot-add-entity-btn');
        addBtn.onclick = () => this.openLocationCreator();

        toolbar.createDiv({ cls: 'graph_copilot-toolbar-separator' });

        const geolocateBtn = iconButton(toolbar, 'map-pin', 'Geolocate missing', BTN);
        geolocateBtn.onclick = () => this.showGeolocateMissingDialog();

        // A persistent strip, not a toast: a missing basemap is a state the analyst needs
        // to keep seeing, not an event that scrolls away. It sits between the actions and
        // the trailing group and takes the slack (flex: 1 1 auto in styles.css); it used
        // to follow the info span's margin-left:auto, which made it the first thing
        // squeezed to nothing.
        this.basemapStatusEl = toolbar.createEl('span', { cls: 'graph_copilot-map-basemap-status' });
        this.basemapStatusEl.style.display = 'none';

        const trailing = toolbar.createDiv({ cls: 'graph_copilot-map-toolbar-trailing' });
        this.refreshBtn = iconButton(trailing, 'refresh-cw', 'Refresh', BTN);
        this.refreshBtn.onclick = () => { void this.refreshFromToolbar(); };

        const fitBtn = iconButton(trailing, 'maximize', 'Fit all', BTN);
        fitBtn.onclick = () => this.fitAllMarkers();
    }

    /**
     * The toolbar's refresh, with a busy state. refresh() itself is single-flight and
     * silent, so the click did nothing visible for the whole reload -- which is exactly
     * what invites a second click.
     */
    private async refreshFromToolbar(): Promise<void> {
        const btn = this.refreshBtn;
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        setButtonLabel(btn, 'Refreshing\u2026', BTN);
        try {
            await this.refresh();
        } finally {
            btn.disabled = false;
            setButtonLabel(btn, 'Refresh', BTN);
        }
    }

    /**
     * Open the location creation modal.
     */
    private openLocationCreator(): void {
        const modal = new EntityCreationModal(
            this.app,
            this.entityManager,
            EntityType.Location,
            (entityId) => {
                // Refresh the map after location creation
                this.refresh();
            }
        );
        modal.open();
    }

    /**
     * Initialize the Leaflet map.
     */
    private initializeMap(): void {
        if (!this.container) return;
        try {
            this.buildMap();
        } catch (e) {
            // This used to throw into the void: onOpen() is invoked as `void this.onOpen()`,
            // so the failure surfaced only as an unhandled rejection and the user saw a
            // toolbar above an empty box.
            console.error('[MapView] could not initialise the map:', e);
            this.showMapError(e instanceof Error ? e.message : String(e));
        }
    }

    /** Renders an initialisation failure where the map would have been. */
    private showMapError(message: string): void {
        if (!this.container) return;
        this.container.empty();
        const box = this.container.createDiv({ cls: 'graph_copilot-map-error' });
        box.createEl('strong', { text: 'The map could not be created.' });
        box.createEl('p', { text: message });
    }

    private buildMap(): void {
        // The ELEMENT, not its id.
        //
        // onOpen() always runs while containerEl is a detached orphan -- the shim creates
        // it and never inserts it; OsintViewHost adopts it later -- so the old
        // `L.map(this.container.id, ...)` resolved through document.getElementById, got
        // null, and threw "Map container not found." every single time. graph-view.ts
        // already passes the element to cytoscape for the same reason.
        this.map = L.map(this.container as HTMLElement, {
            center: [20, 0],
            zoom: 2,
            zoomControl: true,
        });

        // Basemaps, in precedence order: offline archive > online provider > grid.
        //
        // OpenFreeMap is the shipped default because it is MIT, key-free, unmetered and
        // permitted commercially -- the constraint that ruled out OSM's own tiles (policy
        // forbids application use), CARTO (API key, Enterprise licence for commercial
        // use) and Esri (ArcGIS entitlement).
        //
        // The offline archive stays the basemap of record: it is the only one that leaks
        // nothing, since tiles are fetched from the renderer and so sit outside
        // osint:net.request and its allowlist. Analysts who must emit no tile traffic set
        // the provider to "none" and get the grid.
        this.baseLayers = {};

        // The grid is synchronous and cannot fail, so the map is never blank while the
        // other sources resolve. Everything else outranks it and takes over on arrival.
        const grid = this.createGraticuleLayer();
        this.baseLayers[GRID_LAYER_NAME] = grid;
        grid.addTo(this.map);
        this.activeBaseLayerName = GRID_LAYER_NAME;
        // Called here as well as on every layer change: the cap exists for exactly the
        // grid-only user, and skipping it on the initial layer let that user zoom
        // indefinitely into blank space.
        this.applyZoomLimitsForActiveLayer();
        this.markNoBasemapSurface();

        this.layerControl = L.control.layers(this.baseLayers, {}, { position: 'topright' });
        this.layerControl.addTo(this.map);

        this.map.on('baselayerchange', (e: { name: string }) => {
            // Only a real click is a decision; our own claim is not.
            if (!this.claimingBaseLayer) this.userPickedBaseLayer = true;
            this.activeBaseLayerName = e.name;
            this.applyZoomLimitsForActiveLayer();
            this.markNoBasemapSurface();
            this.refreshBasemapStatus();
        });

        // Synchronous, but claimed through the same path so precedence is decided in one
        // place regardless of when each source becomes available.
        const custom = this.createCustomTileLayer();
        if (custom) this.claimBaseLayer(CUSTOM_LAYER_NAME, custom);

        // Both resolve asynchronously -- one over the network, one over IPC. Whichever
        // lands first no longer decides the outcome; BASE_LAYER_RANK does.
        void this.attachOpenFreeMapLayer();
        void this.attachOfflineBasemap();
        this.refreshBasemapStatus();

        L.control.scale({ imperial: false }).addTo(this.map);

        this.observeCanvas();
        this.invalidateNow();

        // Add context menu for the map
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.map.on('contextmenu', (e: any) => {
            const menu = new Menu();

            menu.addItem((item) => {
                item
                    .setTitle('Create location here')
                    .setIcon('map-pin')
                    .onClick(() => {
                        const modal = new EntityCreationModal(
                            this.app,
                            this.entityManager,
                            EntityType.Location,
                            (entityId) => {
                                void this.refresh();
                            },
                            {
                                latitude: e.latlng.lat,
                                longitude: e.latlng.lng
                            }
                        );
                        modal.open();
                    });
            });



            menu.showAtPosition({ x: e.originalEvent.clientX, y: e.originalEvent.clientY });
        });
    }

    /**
     * Refresh the map with current data.
     */
    /**
     * Single-flight. refresh() is reachable from eight places -- the debounced vault
     * watcher, the toolbar, two modal callbacks, the edit menu, the geocoder, and the
     * workspace controller for *background* views -- three of them floating promises.
     * Two overlapping runs would read every note twice for one result.
     */
    async refresh(): Promise<void> {
        if (!this.map) return;
        if (this.refreshInFlight) return this.refreshInFlight;
        this.refreshInFlight = this.doRefresh().finally(() => {
            this.refreshInFlight = null;
        });
        return this.refreshInFlight;
    }

    private async doRefresh(): Promise<void> {
        try {
            await this.entityManager.loadEntitiesFromNotes({ graphYaml: 'changed' });
        } catch (error) {
            // Stop here. This used to log and carry on into the marker rebuild, which
            // turned a transient read failure into a blanked map -- and, because
            // loadEntitiesFromNotes() cleared the shared entity store first, into a
            // truncated store for the graph and timeline views too.
            console.error('[MapView] failed to reload entities; keeping the current markers:', error);
            // Say so. A console line is invisible from the map, and a pane that quietly
            // keeps yesterday's pins looks exactly like one that is up to date.
            new Notice('Could not reload locations; showing the last known markers.');
            return;
        }

        if (!this.map) return;

        this.markers.forEach((marker) => marker.remove());
        this.markers.clear();

        const entities = this.entityManager.getAllEntities().filter((e) => isLocationEntityType(e.type));
        const locations = this.parseLocations(entities);
        locations.forEach((location) => this.addMarker(location));

        // Fit once, when markers first appear. This used to run on every refresh, so any
        // note save reset the analyst's pan and zoom -- pinning a location and editing a
        // note was impossible.
        if (locations.length > 0 && !this.hasFitOnce) {
            this.hasFitOnce = true;
            this.fitAllMarkers();
        }

        this.updateEmptyState();
    }

    /**
     * A hint over the canvas while no entity has coordinates. A map with no pins looked
     * exactly like a map that had failed to load them, and the one action that fixes it
     * -- geolocating the notes that only carry an address -- was a toolbar button with
     * nothing pointing at it. Only reached after a successful reload, so a failed one
     * (which keeps the old markers) never claims the vault is empty.
     */
    private updateEmptyState(): void {
        if (!this.container) return;
        if (this.markers.size > 0) {
            this.emptyStateEl?.remove();
            this.emptyStateEl = null;
            return;
        }
        if (this.emptyStateEl?.isConnected) return;
        // Inside the Leaflet element, which positions itself `relative`, so the overlay
        // covers the canvas exactly. Pointer events are off in styles.css, so the map
        // underneath still pans and the layer control still clicks.
        const el = this.container.createDiv({ cls: 'graph_copilot-map-empty' });
        el.createEl('p', { text: 'No locations with coordinates yet.' });
        el.createEl('p', {
            cls: 'graph_copilot-map-empty-hint',
            text: 'Add a Location or Address entity with latitude / longitude, '
                + 'or use "Geolocate missing" to look up the ones that only have an address.',
        });
        this.emptyStateEl = el;
    }

    /**
     * Parse entities into map locations.
     */
    private parseLocations(entities: Entity[]): MapLocation[] {
        const locations: MapLocation[] = [];

        for (const entity of entities) {
            console.debug('[MapView] Parsing entity:', entity.label, 'properties:', entity.properties);
            const lat = parseCoordinate(entity.properties.latitude as string | number | undefined, 'lat');
            const lng = parseCoordinate(entity.properties.longitude as string | number | undefined, 'lng');
            console.debug('[MapView] Parsed coordinates - lat:', lat, 'lng:', lng);

            if (lat !== null && lng !== null) {
                // Handle both Location and Address entity types
                // isAddressEntityType, not `=== 'Address'`: the filter that selected these
                // entities is case-insensitive, so an `address`-typed note reached here and
                // silently lost its street.
                const address = isAddressEntityType(entity.type)
                    ? ((entity.properties.street || entity.properties.full) as string)
                    : (entity.properties.address as string);

                locations.push({
                    id: entity.id,
                    label: entity.label,
                    lat,
                    lng,
                    address: address,
                    city: entity.properties.city as string,
                    country: entity.properties.country as string
                });
            } else {
                console.debug('[MapView] Skipping entity - missing coordinates');
            }
        }

        return locations;
    }

    /**
     * Add a marker to the map.
     */
    private addMarker(location: MapLocation): void {
        if (!this.map || typeof L === 'undefined') return;

        const color = ENTITY_CONFIGS[EntityType.Location].color;

        // Create custom icon
        const icon = L.divIcon({
            className: 'graph_copilot-map-marker',
            html: `<div style="
                background: ${color};
                width: 24px;
                height: 24px;
                border-radius: 50% 50% 50% 0;
                transform: rotate(-45deg);
                border: 2px solid var(--background-primary);
                box-shadow: 0 2px 5px rgba(0,0,0,0.3);
            "></div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 24],
            popupAnchor: [0, -24]
        });

        // Create marker
        const marker = L.marker([location.lat, location.lng], { icon })
            .addTo(this.map);

        // Create popup content
        const popupContent = createPopupContent(location);
        marker.bindPopup(popupContent);

        // Click handler
        marker.on('click', () => {
            if (this.onLocationClick) {
                this.onLocationClick(location.id);
            }
        });

        // Context menu handler
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        marker.on('contextmenu', (e: any) => {
            const menu = new Menu();

            menu.addItem((item) => {
                item
                    .setTitle('Open note')
                    .setIcon('file-text')
                    .onClick(() => {
                        this.entityManager.openEntityNote(location.id);
                    });
            });

            menu.addItem((item) => {
                item
                    .setTitle('Edit')
                    .setIcon('pencil')
                    .onClick(() => {
                        const entity = this.entityManager.getEntity(location.id);
                        if (entity) {
                            new EntityCreationModal(
                                this.app,
                                this.entityManager,
                                entity.type as EntityType,
                                () => {
                                    this.refresh();
                                },
                                entity.properties,
                                entity.id
                            ).open();
                        } else {
                            new Notice('Entity not found');
                        }
                    });
            });

            menu.addItem((item) => {
                item
                    .setTitle('Focus')
                    .setIcon('crosshair')
                    .onClick(() => {
                        this.map.setView(marker.getLatLng(), 16);
                    });
            });

            menu.showAtPosition({ x: e.originalEvent.clientX, y: e.originalEvent.clientY });

            // Prevent map context menu from firing
            L.DomEvent.stopPropagation(e);
        });


        // Double-click to open note
        marker.on('dblclick', () => {
            this.entityManager.openEntityNote(location.id);
        });

        // Remove any marker already registered under this id before overwriting the
        // entry, or the old one stays on the map with nothing referencing it -- one
        // orphan per refresh, forever.
        this.markers.get(location.id)?.remove();
        this.markers.set(location.id, marker);
    }


    /**
     * Fit the map to show all markers.
     */
    fitAllMarkers(): void {
        if (!this.map || this.markers.size === 0) return;

        // fitBounds derives a zoom from the viewport size. On a 0x0 map -- which is what
        // it is until the host attaches our DOM -- it returns maxZoom and lands fully
        // zoomed in on the bounds centre. Defer to the next successful invalidate.
        if (!this.container?.isConnected || this.container.clientHeight < 1) {
            this.fitPending = true;
            return;
        }

        const bounds = L.latLngBounds([]);
        this.markers.forEach((marker) => bounds.extend(marker.getLatLng()));

        // A single marker gives zero-area bounds, which otherwise snap to the layer's
        // maxZoom -- a street-level view of one pin, with no context.
        this.map.fitBounds(bounds, {
            padding: [50, 50],
            maxZoom: this.markers.size === 1 ? 13 : undefined,
        });
    }

    /**
     * Focus on a specific location.
     *
     * Returns whether it found a marker, so the caller can say something rather than
     * leaving the user staring at an unchanged map after picking "Show on map".
     */
    focusLocation(entityId: string): boolean {
        const marker = this.markers.get(entityId);
        if (!marker || !this.map) return false;
        // The viewport moves only because the user asked for it by name, so this is one
        // of the two places allowed to move it (the other is the Fit button).
        this.map.setView(marker.getLatLng(), 15);
        marker.openPopup();
        this.hasFitOnce = true;
        // Drop any fit deferred from a 0x0 container. "Show on map" arrives before the
        // host has sized the view, so the fit that refresh() queued would otherwise land
        // on the next invalidate and pull the viewport straight back off the entity the
        // user asked for.
        this.fitPending = false;
        return true;
    }

    /**
     * Show dialog to geolocate locations without coordinates.
     */
    private showGeolocateMissingDialog(): void {
        // Get all Location and Address entities
        const allEntities = this.entityManager.getAllEntities();
        const locationsWithoutCoords = allEntities.filter(entity => {
            // isLocationEntityType, not two exact comparisons: GeoLocation entities render
            // on the map but were invisible to the geocoder.
            const isLocationOrAddress = isLocationEntityType(entity.type);
            // entityHasMapCoordinates, not a falsy test: `!0` is true, so anything on the
            // equator or the prime meridian counted as missing and was re-geocoded and
            // overwritten.
            const hasNoCoords = !entityHasMapCoordinates(entity);
            const hasAddress = entity.properties.address || entity.properties.street ||
                entity.properties.full || entity.properties.city || entity.properties.country;
            return isLocationOrAddress && hasNoCoords && hasAddress;
        });

        if (locationsWithoutCoords.length === 0) {
            new Notice('No locations found that need geocoding');
            return;
        }

        // Create a simple modal to show the list
        const modal = new GeolocateMissingModal(
            this.app,
            locationsWithoutCoords,
            this.geocodingService,
            this.entityManager,
            async () => {
                // Refresh the map after geocoding
                await this.refresh();
            }
        );
        modal.open();
    }
}

/** One row's button, shared by the single-row click and the batch. */
type GeolocateRowState = 'idle' | 'busy' | 'done' | 'failed';

/**
 * Modal to show and geolocate locations without coordinates.
 */
/** A place was found, but updateEntity wrote nothing: the note is locked or the entity is gone. */
class GeocodeNotSavedError extends Error {}

class GeolocateMissingModal extends Modal {
    private locations: Entity[];
    private geocodingService: GeocodingService;
    private entityManager: EntityManager;
    private onComplete: () => Promise<void>;
    /** One entry per listed entity, so the batch can mark rows the way a single click does. */
    private rows = new Map<string, { btn: HTMLButtonElement; item: HTMLElement }>();
    /** Set when the user cancels or closes; checked between entities. */
    private cancelled = false;
    private batchProgressEl: HTMLElement | null = null;

    constructor(
        app: App,
        locations: Entity[],
        geocodingService: GeocodingService,
        entityManager: EntityManager,
        onComplete: () => Promise<void>
    ) {
        super(app);
        this.locations = locations;
        this.geocodingService = geocodingService;
        this.entityManager = entityManager;
        this.onComplete = onComplete;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.rows.clear();

        contentEl.createEl('h2', { text: 'Geolocate locations' });
        contentEl.createEl('p', {
            text: `Found ${this.locations.length} location(s) without coordinates that can be geocoded.`
        });

        // Create a list of locations
        const listContainer = contentEl.createDiv({ cls: 'geolocate-list' });
        listContainer.setCssProps({
            'max-height': '400px',
            'overflow-y': 'auto',
            margin: '20px 0'
        });

        this.locations.forEach(entity => {
            const item = listContainer.createDiv({ cls: 'geolocate-item' });
            item.setCssProps({
                padding: '10px',
                margin: '5px 0',
                border: '1px solid var(--background-modifier-border)',
                'border-radius': '4px',
                display: 'flex',
                'justify-content': 'space-between',
                'align-items': 'center'
            });

            const info = item.createDiv();
            info.createEl('strong', { text: entity.label });
            info.createEl('br');

            const address = entity.properties.address || entity.properties.street ||
                entity.properties.full || entity.properties.city || entity.properties.country;
            info.createEl('small', {
                text: String(address),
                cls: 'text-muted'
            });

            const btn = item.createEl('button', { text: 'Geolocate' });
            this.rows.set(entity.id, { btn, item });
            btn.onclick = () => { void this.geolocateEntity(entity); };
        });

        // Above the buttons, not below them. It was created after the button container,
        // so the one line saying what the batch was doing rendered underneath the buttons
        // it was describing.
        this.batchProgressEl = contentEl.createEl('p', { cls: 'setting-item-description' });
        this.batchProgressEl.style.display = 'none';

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonContainer.setCssProps({
            display: 'flex',
            'justify-content': 'flex-end',
            gap: '10px',
            'margin-top': '20px'
        });

        const geolocateAllBtn = buttonContainer.createEl('button', { text: 'Geolocate all' });
        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.style.display = 'none';

        geolocateAllBtn.onclick = async () => {
            this.cancelled = false;
            geolocateAllBtn.disabled = true;
            cancelBtn.style.display = '';
            try {
                await this.geolocateAll();
            } finally {
                geolocateAllBtn.disabled = false;
                cancelBtn.style.display = 'none';
            }
        };

        // Each entity can take 15s+ offline (five retries with exponential backoff), so a
        // batch has to be stoppable without closing the modal.
        cancelBtn.onclick = () => {
            this.cancelled = true;
            this.setBatchProgress('Finishing the current location, then stopping\u2026');
        };

        const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
        closeBtn.onclick = () => this.close();
    }

    /**
     * The same treatment for a row whichever path geocoded it. The batch used to leave
     * every row's button untouched, so "Geolocate all" finished with a list that still
     * invited the user to geolocate each entry again, one by one.
     */
    private setRowState(entityId: string, state: GeolocateRowState): void {
        const row = this.rows.get(entityId);
        if (!row) return;
        const labels: Record<GeolocateRowState, string> = {
            idle: 'Geolocate', busy: 'Geocoding\u2026', done: 'Done', failed: 'Failed',
        };
        row.btn.textContent = labels[state];
        // Done stays disabled: there is nothing left to do for that row. Failed re-enables
        // so a transient error can be retried without reopening the dialog.
        row.btn.disabled = state === 'busy' || state === 'done';
        row.btn.style.color = state === 'done' ? 'var(--text-success)'
            : state === 'failed' ? 'var(--text-error)' : '';
        row.item.style.borderColor = state === 'done' ? 'var(--text-success)' : '';
    }

    private async geolocateEntity(entity: Entity): Promise<void> {
        this.setRowState(entity.id, 'busy');
        try {
            const fields = geocodeFieldsFor(entity);
            const result = await this.geocodingService.geocodeAddressWithRetry(
                fields.address,
                fields.city,
                fields.state,
                fields.country,
                (attempt, maxAttempts, delaySeconds) => {
                    new Notice(`Network error, retrying in ${delaySeconds}s... (attempt ${attempt}/${maxAttempts})`);
                }
            );

            await this.saveGeocodeResult(entity, fields, result);
            this.setRowState(entity.id, 'done');
        } catch (error) {
            this.setRowState(entity.id, 'failed');
            if (error instanceof GeocodeNotSavedError) {
                // Found, but not written: the graph's geolocate says the same.
                new Notice(`Could not save the coordinates of ${entity.label}.`);
            } else if (error instanceof GeocodingError) {
                new Notice(`Failed to geocode ${entity.label}: ${error.message}`);
            } else {
                new Notice(`Failed to geocode ${entity.label}`);
            }
        }
    }

    /**
     * Write a geocoding result to the note, or throw. updateEntity answers null when it
     * wrote nothing (the note is locked, or the entity is gone), and the row said Done.
     */
    private async saveGeocodeResult(entity: Entity, fields: GeocodeFields, result: GeocodingResult): Promise<void> {
        const updated = await this.entityManager.updateEntity(entity.id, geocodeResultUpdates(entity, fields, result));
        if (!updated) throw new GeocodeNotSavedError(`${entity.label} was not updated`);
    }

    private async geolocateAll(): Promise<void> {
        let success = 0;
        let failed = 0;
        let processed = 0;
        const total = this.locations.length;

        for (const entity of this.locations) {
            // Cancellation. Without this the loop ran to completion after the modal was
            // closed, still writing entity notes -- and offline, with five retries and
            // exponential backoff per entity, that is 15s+ each: a hundred rows is well
            // over twenty minutes of work nobody can stop.
            if (this.cancelled) break;
            processed++;
            this.setBatchProgress(`Geocoding ${processed} of ${total}: ${entity.label}\u2026`);
            this.setRowState(entity.id, 'busy');

            try {
                const fields = geocodeFieldsFor(entity);
                const result = await this.geocodingService.geocodeAddressWithRetry(
                    fields.address,
                    fields.city,
                    fields.state,
                    fields.country,
                    // Progress in the modal, not a Notice per retry per entity: offline
                    // that was four toasts times every row.
                    (attempt, maxAttempts, delaySeconds) => {
                        this.setBatchProgress(
                            `Geocoding ${processed} of ${total}: ${entity.label} \u2014 retry ${attempt}/${maxAttempts} in ${delaySeconds}s`,
                        );
                    },
                );

                if (this.cancelled) {
                    // Nothing was written, so the row is exactly as it started.
                    this.setRowState(entity.id, 'idle');
                    break;
                }

                await this.saveGeocodeResult(entity, fields, result);
                this.setRowState(entity.id, 'done');
                success++;
            } catch (error) {
                console.error(`Failed to geocode ${entity.label}:`, error);
                this.setRowState(entity.id, 'failed');
                failed++;
            }
        }

        const skipped = total - processed;
        const parts = [`Geocoded ${success} location(s)`];
        if (failed) parts.push(`${failed} failed`);
        if (this.cancelled && skipped > 0) parts.push(`${skipped} not attempted (cancelled)`);
        new Notice(`${parts.join('. ')}.`);

        this.setBatchProgress('');
        if (!this.cancelled) {
            await this.onComplete();
            this.close();
        }
    }

    /** One line in the modal rather than a stream of toasts. */
    private setBatchProgress(message: string): void {
        if (!this.batchProgressEl) return;
        this.batchProgressEl.setText(message);
        this.batchProgressEl.style.display = message ? '' : 'none';
    }

    onClose(): void {
        // Closing the modal cancels the batch. It used to keep running invisibly,
        // writing notes and calling back into a view that might be gone.
        this.cancelled = true;
        this.rows.clear();
        const { contentEl } = this;
        contentEl.empty();
    }
}
