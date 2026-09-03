
/**
 * Map View for visualizing Location entities using Leaflet.
 */

import { App, ItemView, WorkspaceLeaf, Notice, Modal, Menu, TFile, normalizePath, requestUrl } from 'obsidian';
import { type Entity, EntityType, ENTITY_CONFIGS } from '../entities/types';
import { EntityManager } from '../services/entity-manager';
import { EntityCreationModal } from '../modals/entity-modal';
import { GeocodingService, GeocodingError, geocodingService } from '../services/geocoding-service';
import { host } from '../host';
import { IpcPMTilesSource } from '../services/basemap/ipc-pmtiles-source';
import {
    basemapProblemMessage,
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
export function isLocationEntityType(entityType: string | undefined): boolean {
    if (typeof entityType !== 'string') return false;
    const normalized = entityType.trim().toLowerCase();
    return normalized === 'location' || normalized === 'address' || normalized === 'geolocation';
}

// Leaflet CSS inlined to avoid CSP issues with external stylesheets
// Leaflet CSS moved to styles.css

interface MapLocation {
    id: string;
    label: string;
    lat: number;
    lng: number;
    address?: string;
    city?: string;
    country?: string;
}

/** Always present, always offline: the map is never blank. */
const GRID_LAYER_NAME = 'Coordinate grid';
const OFFLINE_LAYER_NAME = 'Offline basemap';
const CUSTOM_LAYER_NAME = 'Online tiles';
const ONLINE_LAYER_NAME = 'OpenFreeMap';

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
    private basemapStatusEl: HTMLElement | null = null;
    private offlineHandleId: string | null = null;

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

    getDisplayText(): string {
        return 'OSINTCopilot map';
    }

    getIcon(): string {
        return 'map-pin';
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('graph_copilot-map-container');

        // Create toolbar
        const toolbar = container.createDiv({ cls: 'graph_copilot-map-toolbar' });
        this.createToolbar(toolbar);

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
        try {
            // The tile URL lives inside the TileJSON under a dated path that rotates with
            // each weekly build, so it is resolved at runtime rather than hardcoded.
            // Fetched through our guarded IPC, not the renderer, so it is subject to the
            // same egress checks as every other request we control.
            const response = await requestUrl({ url: OPEN_FREE_MAP_TILEJSON, throw: false });
            if (response.status >= 400) {
                this.setBasemapStatus(`OpenFreeMap is not reachable (HTTP ${response.status}).`);
                return;
            }
            const tileUrl = tileUrlFromTileJson(response.json);
            if (!tileUrl) {
                this.setBasemapStatus('OpenFreeMap returned a tile list this build cannot use.');
                return;
            }
            if (!this.map) return;

            const protomaps = await import('protomaps-leaflet');
            const dark = document.body.classList.contains('dark');
            const palette = dark ? DARK_PALETTE : LIGHT_PALETTE;
            const layer = protomaps.leafletLayer({
                url: tileUrl,
                paintRules: openMapTilesPaintRules(palette),
                labelRules: openMapTilesLabelRules(palette),
                backgroundColor: palette.background,
                attribution: OPEN_FREE_MAP_ATTRIBUTION,
                maxDataZoom: 14,
            });

            this.baseLayers[ONLINE_LAYER_NAME] = layer;
            this.layerControl?.addBaseLayer(layer, ONLINE_LAYER_NAME);
        } catch (e) {
            console.error('[MapView] could not load the online basemap:', e);
            this.setBasemapStatus('The online basemap could not be loaded.');
        }
    }

    private async attachOfflineBasemap(): Promise<void> {
        let result;
        try {
            result = await host.basemap.open();
        } catch (e) {
            this.setBasemapStatus(`Offline basemap unavailable: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        if (!this.map) return;

        if (!result.ok) {
            this.setBasemapStatus(basemapProblemMessage(result.problem, result.path));
            return;
        }

        this.offlineHandleId = result.archive.handleId;
        try {
            const { PMTiles } = await import('pmtiles');
            const archive = new PMTiles(new IpcPMTilesSource(result.archive, host.basemap));
            const header = await archive.getHeader();
            const kind = rendererForTileType(header.tileType);
            if (!kind) {
                this.setBasemapStatus(
                    `This archive holds tile type ${header.tileType}, which this build can't draw.`,
                );
                return;
            }

            const layer = kind === 'raster'
                ? await this.createRasterPmtilesLayer(archive, header)
                : await this.createVectorPmtilesLayer(archive);
            if (!this.map || !layer) return;

            this.baseLayers[OFFLINE_LAYER_NAME] = layer;
            this.layerControl?.addBaseLayer(layer, OFFLINE_LAYER_NAME);

            // Select it: an analyst who configured an offline archive wants it, and it
            // leaks nothing.
            this.map.removeLayer(this.baseLayers[GRID_LAYER_NAME]);
            layer.addTo(this.map);
            this.activeBaseLayerName = OFFLINE_LAYER_NAME;
            this.applyZoomLimitsForActiveLayer();
            this.setBasemapStatus('');
        } catch (e) {
            console.error('[MapView] could not read the offline basemap:', e);
            this.setBasemapStatus('The offline basemap could not be read. See Settings → OSINT Copilot.');
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
        return protomaps.leafletLayer({
            attribution: 'Offline basemap',
            // The PMTiles instance directly, so tiles come through our IPC Source rather
            // than a URL. Labels are drawn with system fonts, so no glyph files ship.
            url: archive,
            flavor: 'light',
        });
    }

    /** With no basemap there is nothing meaningful past z10. */
    private applyZoomLimitsForActiveLayer(): void {
        if (!this.map) return;
        const gridOnly = this.activeBaseLayerName === GRID_LAYER_NAME;
        this.map.setMaxZoom(gridOnly ? 10 : 19);
    }

    /**
     * MapView is constructed with (leaf, entityManager, onLocationClick) and has no
     * plugin reference, so the settings come off the runtime the bootstrap publishes --
     * the same route OsintSettings.svelte uses. Every field is re-validated here because
     * this is a plain settings bag, not a typed channel.
     */
    private mapSettings(): { provider: string; url: string; attribution: string; openFreeMapStyle: string } {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- settings bag
        const s = (globalThis as any).osint?.plugin?.settings ?? {};
        return {
            provider: typeof s.mapOnlineTileProvider === 'string' ? s.mapOnlineTileProvider : 'none',
            url: typeof s.mapCustomTileUrl === 'string' ? s.mapCustomTileUrl : '',
            attribution: typeof s.mapCustomTileAttribution === 'string' ? s.mapCustomTileAttribution : '',
            openFreeMapStyle: typeof s.mapOpenFreeMapStyle === 'string' ? s.mapOpenFreeMapStyle : 'positron',
        };
    }

    /** A persistent strip in the toolbar, not a toast: this is a state, not an event. */
    private setBasemapStatus(message: string): void {
        if (!this.basemapStatusEl) return;
        this.basemapStatusEl.setText(message);
        this.basemapStatusEl.style.display = message ? '' : 'none';
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
     */
    private createToolbar(toolbar: HTMLElement): void {
        toolbar.setCssProps({
            display: 'flex',
            gap: '10px',
            padding: '10px',
            background: 'var(--background-secondary)',
            'border-bottom': '1px solid var(--background-modifier-border)'
        });

        // Add Location button
        const addBtn = toolbar.createEl('button', { text: '+ add location' });
        addBtn.addClass('graph_copilot-add-entity-btn');
        addBtn.onclick = () => this.openLocationCreator();

        // Separator
        toolbar.createDiv({ cls: 'graph_copilot-toolbar-separator' });

        // Refresh button
        const refreshBtn = toolbar.createEl('button', { text: '↻ refresh' });
        refreshBtn.onclick = () => { this.refresh(); };

        // Fit all button
        const fitBtn = toolbar.createEl('button', { text: '⊡ fit all' });
        fitBtn.onclick = () => this.fitAllMarkers();

        // Geolocate button
        const geolocateBtn = toolbar.createEl('button', { text: '📍 geolocate missing' });
        geolocateBtn.onclick = () => this.showGeolocateMissingDialog();

        // Info label
        const infoSpan = toolbar.createEl('span', {
            text: 'Map: Location and Address entities with latitude / longitude',
            cls: 'graph_copilot-map-info'
        });
        infoSpan.setCssProps({
            'margin-left': 'auto',
            color: 'var(--text-muted)',
            'font-size': '12px'
        });

        // A persistent strip, not a toast: a missing basemap is a state the analyst needs
        // to keep seeing, not an event that scrolls away.
        this.basemapStatusEl = toolbar.createEl('span', { cls: 'graph_copilot-map-basemap-status' });
        this.basemapStatusEl.style.display = 'none';
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

        // Basemaps.
        //
        // No default online provider, deliberately. There is no key-free,
        // commercially-permitted, global street-level raster basemap: OSM's tile policy
        // forbids application use, CARTO requires an API key and an Enterprise licence
        // for commercial use, and Esri's endpoint needs an ArcGIS entitlement.
        //
        // There is a second reason, specific to this product. Leaflet fetches tiles with
        // <img src> straight out of the renderer, which bypasses osint:net.request and
        // its SSRF allowlist entirely — so every tile is outbound HTTP carrying the exact
        // z/x/y of what the analyst is looking at. That is a live feed of the case's
        // bounding box to a third party. The offline archive is the primary basemap; an
        // online provider is opt-in, with the user's own account and terms.
        this.baseLayers = {};

        const grid = this.createGraticuleLayer();
        this.baseLayers[GRID_LAYER_NAME] = grid;

        const custom = this.createCustomTileLayer();
        if (custom) this.baseLayers[CUSTOM_LAYER_NAME] = custom;

        // Added asynchronously; it is a vector source and its renderer is imported lazily.
        void this.attachOpenFreeMapLayer();

        // Starts on the grid so the map is never blank while the archive opens.
        grid.addTo(this.map);
        this.activeBaseLayerName = GRID_LAYER_NAME;

        this.layerControl = L.control.layers(this.baseLayers, {}, { position: 'topright' });
        this.layerControl.addTo(this.map);

        this.map.on('baselayerchange', (e: { name: string }) => {
            this.activeBaseLayerName = e.name;
            this.applyZoomLimitsForActiveLayer();
        });

        // The offline archive opens asynchronously; it is added and selected when ready.
        void this.attachOfflineBasemap();

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
     * Two overlapping runs both clear and rebuild the shared entity store, so the second
     * can observe a half-populated one.
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
            await this.entityManager.loadEntitiesFromNotes();
        } catch (error) {
            // Stop here. This used to log and carry on into the marker rebuild, which
            // turned a transient read failure into a blanked map -- and, because
            // loadEntitiesFromNotes() clears the shared entity store first, into a
            // truncated store for the graph and timeline views too.
            console.error('[MapView] failed to reload entities; keeping the current markers:', error);
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
    }

    /**
     * Parse entities into map locations.
     */
    private parseLocations(entities: Entity[]): MapLocation[] {
        const locations: MapLocation[] = [];

        for (const entity of entities) {
            console.debug('[MapView] Parsing entity:', entity.label, 'properties:', entity.properties);
            const lat = this.parseCoordinate(entity.properties.latitude as string | number | undefined);
            const lng = this.parseCoordinate(entity.properties.longitude as string | number | undefined);
            console.debug('[MapView] Parsed coordinates - lat:', lat, 'lng:', lng);

            if (lat !== null && lng !== null) {
                // Handle both Location and Address entity types
                const address = entity.type === 'Address'
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
     * Parse a coordinate string to number.
     */
    private parseCoordinate(value: string | number | undefined): number | null {
        if (value === undefined || value === null || value === '') {
            console.debug('[MapView] parseCoordinate: value is empty/undefined:', value);
            return null;
        }

        const num = typeof value === 'number' ? value : parseFloat(value);
        if (isNaN(num)) {
            console.debug('[MapView] parseCoordinate: value is NaN:', value);
            return null;
        }

        return num;
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
                border: 2px solid white;
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
        const popupContent = this.createPopupContent(location);
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
     * Create popup content for a location.
     */
    /**
     * Built as DOM with textContent, never as an HTML string.
     *
     * label / address / city / country come straight from note frontmatter, which the
     * AI agent writes. This used to be string concatenation handed to bindPopup(), which
     * Leaflet assigns with innerHTML -- so `city: <img src=x onerror=...>` executed
     * script in a renderer that has no CSP and exposes the whole window.api IPC bridge.
     */
    private createPopupContent(location: MapLocation): HTMLElement {
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
     * Add a location to the map.
     */
    addLocation(entity: Entity): void {
        if (entity.type !== EntityType.Location) return;

        const lat = this.parseCoordinate(entity.properties.latitude as string | number | undefined);
        const lng = this.parseCoordinate(entity.properties.longitude as string | number | undefined);

        if (lat !== null && lng !== null) {
            this.addMarker({
                id: entity.id,
                label: entity.label,
                lat,
                lng,
                address: entity.properties.address as string,
                city: entity.properties.city as string,
                country: entity.properties.country as string
            });
        }
    }

    /**
     * Remove a location from the map.
     */
    removeLocation(entityId: string): void {
        const marker = this.markers.get(entityId);
        if (marker) {
            marker.remove();
            this.markers.delete(entityId);
        }
    }

    /**
     * Highlight a specific location.
     */
    highlightLocation(entityId: string): void {
        const entity = this.entityManager.getEntity(entityId);
        if (!entity || !this.map) return;

        const marker = this.markers.get(entity.id);
        if (marker) {
            marker.openPopup();
            this.map.setView(marker.getLatLng(), 15);
        }
    }

    /**
     * Focus on a specific location.
     */
    focusLocation(entityId: string): void {
        console.debug('[MapView] focusLocation called for:', entityId);
        console.debug('[MapView] Available markers:', Array.from(this.markers.keys()));
        const marker = this.markers.get(entityId);
        if (marker && this.map) {
            console.debug('[MapView] Found marker, focusing...');
            this.map.setView(marker.getLatLng(), 15);
            marker.openPopup();
        } else {
            console.debug('[MapView] Marker not found for entity:', entityId);
        }
    }

    /**
     * Show dialog to geolocate locations without coordinates.
     */
    private showGeolocateMissingDialog(): void {
        // Get all Location and Address entities
        const allEntities = this.entityManager.getAllEntities();
        const locationsWithoutCoords = allEntities.filter(entity => {
            const isLocationOrAddress = entity.type === EntityType.Location || entity.type === 'Address';
            const hasNoCoords = !entity.properties.latitude || !entity.properties.longitude;
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

/**
 * Modal to show and geolocate locations without coordinates.
 */
class GeolocateMissingModal extends Modal {
    private locations: Entity[];
    private geocodingService: GeocodingService;
    private entityManager: EntityManager;
    private onComplete: () => Promise<void>;

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

            const btn = item.createEl('button', { text: '📍 geolocate' });
            btn.onclick = async () => {
                btn.disabled = true;
                btn.textContent = 'Geocoding...';
                await this.geolocateEntity(entity, btn, item);
            };
        });

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonContainer.setCssProps({
            display: 'flex',
            'justify-content': 'flex-end',
            gap: '10px',
            'margin-top': '20px'
        });

        const geolocateAllBtn = buttonContainer.createEl('button', { text: 'Geolocate all' });
        geolocateAllBtn.onclick = async () => {
            geolocateAllBtn.disabled = true;
            await this.geolocateAll();
            geolocateAllBtn.disabled = false;
        };

        const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
        closeBtn.onclick = () => this.close();
    }

    private async geolocateEntity(entity: Entity, btn: HTMLButtonElement, item: HTMLElement): Promise<void> {
        try {
            // Extract address components
            let address: string | undefined;
            let city: string | undefined;
            let state: string | undefined;
            let country: string | undefined;

            if (entity.type === EntityType.Location) {
                address = entity.properties.address as string;
                city = entity.properties.city as string;
                country = entity.properties.country as string;
            } else if (entity.type === 'Address') {
                address = entity.properties.street as string || entity.properties.full as string;
                city = entity.properties.city as string;
                state = entity.properties.state as string;
                country = entity.properties.country as string;
            }

            const result = await this.geocodingService.geocodeAddressWithRetry(
                address,
                city,
                state,
                country,
                (attempt, maxAttempts, delaySeconds) => {
                    new Notice(`Network error, retrying in ${delaySeconds}s... (attempt ${attempt}/${maxAttempts})`);
                }
            );

            // Update entity
            const updates: Record<string, unknown> = {
                latitude: result.latitude,
                longitude: result.longitude
            };

            if (result.city && !city) updates.city = result.city;
            if (result.state && !state && entity.type === 'Address') updates.state = result.state;
            if (result.country && !country) updates.country = result.country;
            if (result.postalCode && entity.type === 'Address' && !entity.properties.postalCode) {
                updates.postalCode = result.postalCode;
            }

            await this.entityManager.updateEntity(entity.id, updates);

            // Update UI
            btn.textContent = '✓ done';
            btn.setCssProps({ color: 'var(--text-success)' });
            item.setCssProps({ 'border-color': 'var(--text-success)' });

        } catch (error) {
            btn.textContent = '✗ failed';
            btn.setCssProps({ color: 'var(--text-error)' });
            if (error instanceof GeocodingError) {
                new Notice(`Failed to geocode ${entity.label}: ${error.message}`);
            } else {
                new Notice(`Failed to geocode ${entity.label}`);
            }
            btn.disabled = false;
        }
    }

    private async geolocateAll(): Promise<void> {
        let success = 0;
        let failed = 0;

        for (const entity of this.locations) {
            try {
                let address: string | undefined;
                let city: string | undefined;
                let state: string | undefined;
                let country: string | undefined;

                if (entity.type === EntityType.Location) {
                    address = entity.properties.address as string;
                    city = entity.properties.city as string;
                    country = entity.properties.country as string;
                } else if (entity.type === 'Address') {
                    address = entity.properties.street as string || entity.properties.full as string;
                    city = entity.properties.city as string;
                    state = entity.properties.state as string;
                    country = entity.properties.country as string;
                }

                const result = await this.geocodingService.geocodeAddressWithRetry(
                    address,
                    city,
                    state,
                    country,
                    (attempt, maxAttempts, delaySeconds) => {
                        new Notice(`Network error, retrying in ${delaySeconds}s... (attempt ${attempt}/${maxAttempts})`);
                    }
                );

                const updates: Record<string, unknown> = {
                    latitude: result.latitude,
                    longitude: result.longitude
                };

                if (result.city && !city) updates.city = result.city;
                if (result.state && !state && entity.type === 'Address') updates.state = result.state;
                if (result.country && !country) updates.country = result.country;
                if (result.postalCode && entity.type === 'Address' && !entity.properties.postalCode) {
                    updates.postalCode = result.postalCode;
                }

                await this.entityManager.updateEntity(entity.id, updates);
                success++;

            } catch (error) {
                console.error(`Failed to geocode ${entity.label}:`, error);
                failed++;
            }
        }

        new Notice(`Geocoded ${success} location(s). ${failed} failed.`);
        await this.onComplete();
        this.close();
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

