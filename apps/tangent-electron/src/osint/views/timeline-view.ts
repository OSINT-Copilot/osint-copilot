
/**
 * Timeline View for visualizing Event entities with dates.
 */

import { App, ItemView, TFile, WorkspaceLeaf, Menu, Notice, normalizePath, setIcon } from 'obsidian';
import { type Entity, EntityType, ENTITY_CONFIGS } from '../entities/types';
import { EntityManager } from '../services/entity-manager';
import { EntityCreationModal } from '../modals/entity-modal';

export const TIMELINE_VIEW_TYPE = 'graph_copilot-timeline-view';

/** Match Event notes regardless of YAML casing (`event` vs `Event`). */
export function isEventEntityType(entityType: string | undefined): boolean {
    return typeof entityType === 'string' && entityType.trim().toLowerCase() === 'event';
}

function isExplicitlyOffTimeline(value: unknown): boolean {
    if (value === false || value === 0) return true;
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        return s === 'false' || s === 'no' || s === '0' || s === '';
    }
    return false;
}

export function pickFirstTimelineDateProperty(properties: Record<string, unknown>): string | undefined {
    const keys = ['start_date', 'first_seen', 'first_seen_precise', 'date', 'published', 'first_observed', 'modified'];
    for (const k of keys) {
        const v = properties[k];
        if (typeof v === 'string' && v.trim() && !['unknown', 'n/a'].includes(v.trim().toLowerCase())) {
            return v.trim();
        }
    }
    return undefined;
}

export interface TimelineEvent {
    id: string;
    label: string;
    start: Date | null;
    end?: Date;
    color: string;
}

/**
 * Order timeline events for display: entities with no parseable date come first, in their
 * original (entity-load) order, followed by dated events sorted ascending (oldest first) --
 * preserving the existing sort behavior for dated events exactly. Exported for direct unit
 * testing (see tests/timeline-view.test.ts).
 */
export function sortTimelineEventsForDisplay(events: TimelineEvent[]): TimelineEvent[] {
    const undated = events.filter((e) => e.start === null);
    const dated = events.filter((e): e is TimelineEvent & { start: Date } => e.start !== null);
    dated.sort((a, b) => a.start.getTime() - b.start.getTime());
    return [...undated, ...dated];
}

/**
 * A toolbar button with a lucide glyph and a text label, in place of the emoji that used
 * to stand in for icons. The label is a span of its own so a busy state can relabel the
 * button without discarding the icon.
 */
function iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const btn = parent.createEl('button');
    setIcon(btn.createSpan({ cls: 'graph_copilot-timeline-btn-icon' }), icon);
    btn.createSpan({ cls: 'graph_copilot-timeline-btn-label', text: label });
    return btn;
}

function setButtonLabel(btn: HTMLButtonElement, label: string): void {
    const labelEl = btn.querySelector('.graph_copilot-timeline-btn-label');
    if (labelEl) labelEl.textContent = label;
}

export class TimelineView extends ItemView {
    private entityManager: EntityManager;
    private container: HTMLElement | null = null;
    private timelineContainer: HTMLElement | null = null;
    private events: TimelineEvent[] = [];
    private onEventClick: ((entityId: string) => void) | null = null;
    /** Debounce vault edits (browser `setTimeout` id is numeric). */
    private vaultRefreshTimer: number | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        entityManager: EntityManager,
        onEventClick?: (entityId: string) => void
    ) {
        super(leaf);
        this.entityManager = entityManager;
        this.onEventClick = onEventClick || null;
    }

    getViewType(): string {
        return TIMELINE_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'OSINTCopilot timeline';
    }

    getIcon(): string {
        // The name OSINT_VIEWS gives this view (integration/osint-view-types.ts), so the
        // pane header and the toolbar pill show one glyph rather than two.
        return 'calendar';
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('graph_copilot-timeline-container');

        // Create toolbar
        const toolbar = container.createDiv({ cls: 'graph_copilot-timeline-toolbar' });
        this.createToolbar(toolbar);

        // A line of its own under the toolbar, not a flex item inside it: a 200-character
        // sentence in a toolbar that could not wrap was the first thing squeezed, and in a
        // narrow pane it pushed the buttons off the edge.
        container.createDiv({
            cls: 'graph_copilot-timeline-hint',
            text: 'Event entities, dated or not; set add_to_timeline: false on a note to hide it. Updates as notes change.',
        });

        // The canvas. No inline height: styles.css gives it `flex: 1` inside the column
        // container, and the `calc(100% - 50px)` that used to be set here was a hardcoded
        // guess at the toolbar height that fought it -- the same one map-view.ts removed.
        this.timelineContainer = container.createDiv({ cls: 'graph_copilot-timeline-canvas' });

        // Load entities from disk and refresh the timeline
        await this.refresh();

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
    }

    async onClose(): Promise<void> {
        if (this.vaultRefreshTimer !== null) {
            window.clearTimeout(this.vaultRefreshTimer);
            this.vaultRefreshTimer = null;
        }
        this.events = [];
    }

    /**
     * Create the toolbar.
     *
     * Layout lives in styles.css (.graph_copilot-timeline-toolbar). The inline copy that
     * used to sit here beat the stylesheet, so nothing there -- flex-wrap included --
     * could take effect.
     */
    private createToolbar(toolbar: HTMLElement): void {
        const addBtn = iconButton(toolbar, 'plus', 'Add event');
        addBtn.addClass('graph_copilot-add-entity-btn');
        addBtn.onclick = () => this.openEventCreator();

        toolbar.createDiv({ cls: 'graph_copilot-toolbar-separator' });

        const trailing = toolbar.createDiv({ cls: 'graph_copilot-timeline-toolbar-trailing' });
        const refreshBtn = iconButton(trailing, 'refresh-cw', 'Refresh');
        refreshBtn.onclick = () => {
            void (async () => {
                if (refreshBtn.disabled) return;
                refreshBtn.disabled = true;
                setButtonLabel(refreshBtn, 'Refreshing\u2026');
                try {
                    await this.refresh();
                } finally {
                    refreshBtn.disabled = false;
                    setButtonLabel(refreshBtn, 'Refresh');
                }
            })();
        };
    }

    /**
     * Open the event creation modal.
     */
    private openEventCreator(): void {
        const modal = new EntityCreationModal(
            this.app,
            this.entityManager,
            EntityType.Event,
            (entityId) => {
                // Refresh the timeline after event creation
                this.refresh();
            }
        );
        modal.open();
    }

    /**
     * Refresh the timeline with current data.
     * Reloads entities from disk to ensure persistence across Obsidian restarts.
     */
    async refresh(): Promise<void> {
        if (!this.timelineContainer) return;

        // Reload entities from disk to ensure we have the latest data
        try {
            await this.entityManager.loadEntitiesFromNotes();
        } catch (error) {
            // Stop here, as the map does. This used to fall through into the render with
            // whatever the failed load left in the store -- usually nothing, since
            // loadEntitiesFromNotes() clears it first -- so a transient read failure
            // showed the "no events yet" empty state over a vault full of them.
            console.error('[TimelineView] Failed to reload entities from notes:', error);
            new Notice('Could not reload events; showing the last known timeline.');
            return;
        }

        // All Event-* entities (case-insensitive YAML type); graph may index "event"
        const entities = this.entityManager.getAllEntities().filter((e) => isEventEntityType(e.type));
        this.events = this.parseEvents(entities);

        // Render the timeline
        this.renderTimeline();
    }

    /**
     * Parse entities into timeline events.
     * Events are included unless add_to_timeline is explicitly set to false.
     */
    private parseEvents(entities: Entity[]): TimelineEvent[] {
        const events: TimelineEvent[] = [];

        for (const entity of entities) {
            if (isExplicitlyOffTimeline(entity.properties.add_to_timeline)) continue;

            const startRaw = pickFirstTimelineDateProperty(entity.properties as Record<string, unknown>);
            const startDate = this.parseDate(startRaw); // null is kept (shown as undated), not dropped

            const endRaw =
                typeof entity.properties.end_date === 'string' ? entity.properties.end_date : entity.properties.last_seen;
            const endDate = this.parseDate(typeof endRaw === 'string' ? endRaw : undefined);

            events.push({
                id: entity.id,
                label: entity.label,
                start: startDate,
                end: endDate || undefined,
                color: ENTITY_CONFIGS[EntityType.Event].color
            });
        }

        return sortTimelineEventsForDisplay(events);
    }

    /**
     * Parse a date string. Supports YYYY-MM-DD HH:mm, YYYY-MM-DD, and standard Date formats.
     */
    private parseDate(dateStr: string | undefined): Date | null {
        if (!dateStr || dateStr.toLowerCase() === 'unknown' || dateStr.toLowerCase() === 'n/a') return null;

        try {
            const withTimeMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
            if (withTimeMatch) {
                return new Date(
                    parseInt(withTimeMatch[1]),
                    parseInt(withTimeMatch[2]) - 1,
                    parseInt(withTimeMatch[3]),
                    parseInt(withTimeMatch[4]),
                    parseInt(withTimeMatch[5])
                );
            }

            const dateOnlyMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (dateOnlyMatch) {
                return new Date(
                    parseInt(dateOnlyMatch[1]),
                    parseInt(dateOnlyMatch[2]) - 1,
                    parseInt(dateOnlyMatch[3])
                );
            }

            // ISO-8601 / STIX-style: 2026-05-07T14:30:00Z
            if (/^\d{4}-\d{2}-\d{2}T/.test(dateStr.trim())) {
                const iso = new Date(dateStr.trim());
                if (!isNaN(iso.getTime())) return iso;
            }

            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
                return date;
            }
        } catch (e) {
            console.error('Failed to parse date:', dateStr);
        }

        return null;
    }

    /**
     * Render the timeline visualization.
     */
    private renderTimeline(): void {
        if (!this.timelineContainer) return;
        this.timelineContainer.empty();

        if (this.events.length === 0) {
            const emptyEl = this.timelineContainer.createDiv({ cls: 'graph_copilot-timeline-empty' });
            emptyEl.createEl('p', { text: 'No events added to the timeline yet.' });
            emptyEl.createEl('p', {
                cls: 'graph_copilot-timeline-empty-hint',
                text: 'Create an entity with type Event and a start_date (or first_seen / date). '
                    + 'Use Refresh if you just edited notes. '
                    + 'Set add_to_timeline: false to hide a note from this view.',
            });
            return;
        }

        // Layout -- the 200px date gutter and the line -- is in styles.css, where a
        // container query can collapse it in a narrow pane. Set inline it could not be
        // overridden, so the gutter stayed 200px wide in a 300px pane and the cards had
        // no room left.
        const wrapper = this.timelineContainer.createDiv({ cls: 'graph_copilot-timeline-wrapper' });
        wrapper.createDiv({ cls: 'graph_copilot-timeline-line' });

        // sortTimelineEventsForDisplay() guarantees all undated events occupy indices
        // [0, undatedCount) at the front of this.events, followed by the dated, sorted group.
        const undatedCount = this.events.filter((e) => e.start === null).length;
        const datedCount = this.events.length - undatedCount;

        if (undatedCount > 0) {
            this.renderSectionHeader(wrapper, `Undated (${undatedCount})`);
        }

        // Render each event
        this.events.forEach((event, index) => {
            if (undatedCount > 0 && datedCount > 0 && index === undatedCount) {
                this.renderSectionDivider(wrapper);
            }
            this.renderEvent(wrapper, event, index);
        });
    }

    /** Render a section header (e.g. "Undated (3)") above a group of timeline cards. */
    private renderSectionHeader(container: HTMLElement, text: string): void {
        const header = container.createDiv({ cls: 'graph_copilot-timeline-section-header' });
        header.setCssProps({
            margin: '0 0 15px 0',
            'font-size': '12px',
            'font-weight': '600',
            'text-transform': 'uppercase',
            'letter-spacing': '0.5px',
            color: 'var(--text-muted)'
        });
        header.textContent = text;
    }

    /** Divider marking the boundary between the undated group and the dated list below it. */
    private renderSectionDivider(container: HTMLElement): void {
        const divider = container.createDiv({ cls: 'graph_copilot-timeline-section-divider' });
        divider.setCssProps({
            margin: '10px 0 25px 0',
            'border-top': '1px dashed var(--background-modifier-border)'
        });
    }

    /**
     * Render a single event on the timeline.
     */
    private renderEvent(container: HTMLElement, event: TimelineEvent, index: number): void {
        // Only the per-event colour is set inline; the geometry is in styles.css so the
        // container query there can restack the date above the card in a narrow pane.
        const eventEl = container.createDiv({ cls: 'graph_copilot-timeline-event' });

        // Event dot
        const dot = eventEl.createDiv({ cls: 'graph_copilot-timeline-dot' });
        dot.setCssProps({
            background: event.color,
            'box-shadow': `0 0 0 2px ${event.color}`
        });

        // Date label. Before the card in the DOM, so that when the gutter collapses the
        // date reads as a heading above the card rather than a footer beneath it.
        const dateLabel = eventEl.createDiv({ cls: 'graph_copilot-timeline-date' });
        dateLabel.textContent = event.start ? this.formatDate(event.start) : 'No date';

        // Event card
        const card = eventEl.createDiv({ cls: 'graph_copilot-timeline-card' });
        card.setCssProps({ 'border-left': `4px solid ${event.color}` });

        // Card header with title and remove button
        const cardHeader = card.createDiv({ cls: 'graph_copilot-timeline-card-header' });
        cardHeader.setCssProps({
            display: 'flex',
            'justify-content': 'space-between',
            'align-items': 'flex-start',
            gap: '10px'
        });

        // Event title
        const title = cardHeader.createEl('h4', { text: event.label });
        title.setCssProps({
            margin: '0',
            color: 'var(--text-normal)',
            flex: '1'
        });

        // Remove from Timeline button. Styled, hover included, in styles.css: the
        // mouseenter handler that used to live here painted white text over
        // --background-modifier-error, which is a tint rather than a fill, so the label
        // disappeared on hover in the light theme.
        const removeBtn = cardHeader.createEl('button', {
            text: 'Remove',
            cls: 'graph_copilot-timeline-remove-btn'
        });
        removeBtn.title = 'Remove from timeline';

        // Remove button click handler
        removeBtn.onclick = async (e) => {
            e.stopPropagation(); // Prevent card click
            await this.toggleEventTimeline(event.id, false);
        };

        // Time range
        const timeRange = card.createDiv({ cls: 'graph_copilot-timeline-time' });
        timeRange.setCssProps({
            'font-size': '12px',
            color: 'var(--text-muted)',
            'margin-top': '5px'
        });

        let timeText = event.start ? this.formatTime(event.start) : 'No date';
        if (event.end) {
            timeText += ` → ${this.formatTime(event.end)}`;
        }
        timeRange.textContent = timeText;

        // Click handler for card (opens entity note)
        card.onclick = (e) => {
            // Don't trigger if clicking the remove button
            if ((e.target as HTMLElement).closest('.graph_copilot-timeline-remove-btn')) return;

            if (this.onEventClick) {
                this.onEventClick(event.id);
            } else {
                this.entityManager.openEntityNote(event.id);
            }
        };

        // Context menu handler
        card.addEventListener('contextmenu', (e: MouseEvent) => {
            // First, before anything else: Tangent's own context menu listens at the
            // window and opens for any right-click nobody has claimed, so without this
            // both menus appeared, one on top of the other.
            e.preventDefault();
            e.stopPropagation();
            const menu = new Menu();

            menu.addItem((item) => {
                item
                    .setTitle('Edit')
                    .setIcon('pencil')
                    .onClick(() => {
                        const entity = this.entityManager.getEntity(event.id);
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

            menu.showAtPosition({ x: e.clientX, y: e.clientY });
        });
    }

    /**
     * Toggle an event's timeline inclusion status.
     */
    private async toggleEventTimeline(entityId: string, addToTimeline: boolean): Promise<void> {
        try {
            await this.entityManager.updateEntity(entityId, { add_to_timeline: addToTimeline });
            await this.refresh();
        } catch (error) {
            console.error('[TimelineView] Failed to toggle event timeline status:', error);
            // The card is still there, and the analyst needs to hear why the click they
            // just made had no effect.
            new Notice(addToTimeline
                ? 'Could not add the event to the timeline.'
                : 'Could not remove the event from the timeline.');
        }
    }

    /**
     * Format a date for display.
     */
    private formatDate(date: Date): string {
        const options: Intl.DateTimeFormatOptions = {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        };
        return date.toLocaleDateString(undefined, options);
    }

    /**
     * Format a time for display.
     */
    private formatTime(date: Date): string {
        const options: Intl.DateTimeFormatOptions = {
            hour: '2-digit',
            minute: '2-digit'
        };
        return date.toLocaleTimeString(undefined, options);
    }

    /**
     * Add an event to the timeline.
     */
    addEvent(entity: Entity): void {
        if (entity.type !== EntityType.Event) return;
        this.refresh();
    }

    /**
     * Remove an event from the timeline.
     */
    removeEvent(entityId: string): void {
        this.events = this.events.filter(e => e.id !== entityId);
        this.renderTimeline();
    }
}

