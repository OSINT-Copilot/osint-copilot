/**
 * The canvas viewport: a {x, y, scale} transform between world space (the coordinates
 * stored in the .canvas file) and screen space (pixels in the panel).
 *
 * Tangent's Map has pan/zoom, but not in a form this can borrow: MapsView applies
 * `scale()` to a container and pans with native `scrollLeft`/`scrollTop`, so there is no
 * transform matrix and no world<->screen helper anywhere in the app. An infinite canvas
 * needs both — for hit-testing, for placing a dropped note under the cursor, and for
 * culling — so this module owns the maths and keeps it pure and testable.
 *
 * Convention: screen = (world + offset) * scale. `offset` is in world units, which keeps
 * panning independent of the current zoom.
 */

export interface Viewport {
    /** Pan offset in WORLD units. */
    x: number;
    y: number;
    scale: number;
}

export interface Point {
    x: number;
    y: number;
}

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Zoom bounds.
 *
 * The floor is well below Tangent's map (0.1) because a case board is far wider than a
 * thread: at 0.02 a few thousand world-pixels of cards fit on screen for orientation.
 * The ceiling is above 1 so a card's text stays readable when zoomed in on a laptop.
 */
export const MIN_SCALE = 0.02;
export const MAX_SCALE = 4;

/**
 * Below this scale a NOTE or PDF card renders as a cheap placeholder instead of a live
 * NodePreview. Each NodePreview builds a full MarkdownEditor with decorators and
 * autocompleters, which is far too expensive to mount for every card on a large board —
 * Tangent virtualizes its own Cards lens for exactly this reason.
 *
 * Images are deliberately exempt: an <img> costs nothing like an editor, and a picture is
 * most useful precisely when you have zoomed out to take in the whole board. Gating them
 * with the same number turned every photo into a filename.
 *
 * 0.35 rather than 0.5 because a whole-board view lands around there, and at 0.5 the
 * common "fit everything" zoom fell just below the line and blanked every note at once.
 */
export const LIVE_PREVIEW_MIN_SCALE = 0.35;

export function defaultViewport(): Viewport {
    return { x: 0, y: 0, scale: 1 };
}

export function clampScale(scale: number): number {
    // Only NaN resets: it has no direction, so there is nothing to clamp towards, and it
    // would otherwise poison every subsequent transform silently. +/-Infinity does have a
    // direction and clamps to the corresponding bound.
    if (Number.isNaN(scale)) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function worldToScreen(viewport: Viewport, point: Point): Point {
    return {
        x: (point.x + viewport.x) * viewport.scale,
        y: (point.y + viewport.y) * viewport.scale,
    };
}

export function screenToWorld(viewport: Viewport, point: Point): Point {
    return {
        x: point.x / viewport.scale - viewport.x,
        y: point.y / viewport.scale - viewport.y,
    };
}

/**
 * Zoom about a fixed screen point — the cursor, or the centre of the panel.
 *
 * The point under the cursor must not move, or zooming feels like the board is sliding
 * away. Solved by requiring screenToWorld to return the same world point before and
 * after, then solving for the new offset.
 */
export function zoomAbout(viewport: Viewport, screenPoint: Point, nextScale: number): Viewport {
    const scale = clampScale(nextScale);
    const anchor = screenToWorld(viewport, screenPoint);
    return {
        scale,
        x: screenPoint.x / scale - anchor.x,
        y: screenPoint.y / scale - anchor.y,
    };
}

/**
 * Wheel-to-scale, matching Tangent's own feel.
 *
 * The magnitude heuristic and the multiplicative step are lifted from
 * `common/settings/ZoomSetting.ts` so the canvas zooms at the same rate as the map rather
 * than inventing a second sensitivity the user has to learn. Kept as a pure function
 * because ZoomSetting is a Setting store, which this module has no use for.
 */
export function scaleFromWheel(scale: number, deltaY: number, sensitivity = 0.25): number {
    let change = deltaY;
    // A mouse wheel emits large discrete deltas; a trackpad emits many small ones.
    if (Math.abs(change) > 25) change *= 0.005;
    else change *= 0.1;
    return clampScale(scale - change * scale * sensitivity);
}

export function panBy(viewport: Viewport, screenDx: number, screenDy: number): Viewport {
    // Divided by scale so a given mouse movement always moves the board the same number of
    // SCREEN pixels, whatever the zoom.
    return {
        ...viewport,
        x: viewport.x + screenDx / viewport.scale,
        y: viewport.y + screenDy / viewport.scale,
    };
}

export function rectContains(rect: Rect, point: Point): boolean {
    return point.x >= rect.x && point.x <= rect.x + rect.width
        && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x
        && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Normalises a drag between two corners into a rect with positive extents. */
export function rectFromCorners(a: Point, b: Point): Rect {
    return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(a.x - b.x),
        height: Math.abs(a.y - b.y),
    };
}

/** The world-space rectangle currently on screen, for culling. */
export function visibleWorldRect(viewport: Viewport, screenWidth: number, screenHeight: number): Rect {
    const topLeft = screenToWorld(viewport, { x: 0, y: 0 });
    const bottomRight = screenToWorld(viewport, { x: screenWidth, y: screenHeight });
    return {
        x: topLeft.x,
        y: topLeft.y,
        width: bottomRight.x - topLeft.x,
        height: bottomRight.y - topLeft.y,
    };
}

/**
 * Which cards to mount.
 *
 * Padded by one screen in each direction so a card is already mounted by the time it
 * scrolls in — mounting a NoteEditor mid-pan is visible as a stutter.
 */
export function cullToViewport<T extends { rect: Rect }>(
    items: T[], visible: Rect, padScreens = 1,
): T[] {
    const padded: Rect = {
        x: visible.x - visible.width * padScreens,
        y: visible.y - visible.height * padScreens,
        width: visible.width * (1 + padScreens * 2),
        height: visible.height * (1 + padScreens * 2),
    };
    return items.filter((item) => rectsIntersect(item.rect, padded));
}

/**
 * Fit a set of rects on screen.
 *
 * Zero-area input (one card, or several stacked exactly) would otherwise divide to
 * Infinity and land at MAX_SCALE, so it falls back to scale 1 centred on the content --
 * the same class of bug that made the map snap to street level on a single marker.
 */
export function fitToRects(
    rects: Rect[], screenWidth: number, screenHeight: number, padding = 80,
): Viewport {
    if (rects.length === 0 || screenWidth <= 0 || screenHeight <= 0) return defaultViewport();

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const rect of rects) {
        minX = Math.min(minX, rect.x);
        minY = Math.min(minY, rect.y);
        maxX = Math.max(maxX, rect.x + rect.width);
        maxY = Math.max(maxY, rect.y + rect.height);
    }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const availableWidth = Math.max(1, screenWidth - padding * 2);
    const availableHeight = Math.max(1, screenHeight - padding * 2);

    const scale = contentWidth > 0 && contentHeight > 0
        ? clampScale(Math.min(availableWidth / contentWidth, availableHeight / contentHeight))
        : 1;

    // Centre the content box in the panel.
    const centreX = minX + contentWidth / 2;
    const centreY = minY + contentHeight / 2;
    return {
        scale,
        x: screenWidth / (2 * scale) - centreX,
        y: screenHeight / (2 * scale) - centreY,
    };
}

export type Side = 'top' | 'right' | 'bottom' | 'left';

/** The anchor point on one side of a rect, where an edge attaches. */
export function sideAnchor(rect: Rect, side: Side): Point {
    switch (side) {
        case 'top': return { x: rect.x + rect.width / 2, y: rect.y };
        case 'bottom': return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
        case 'left': return { x: rect.x, y: rect.y + rect.height / 2 };
        case 'right': return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
    }
}

/**
 * The side an edge should leave from when the file did not say.
 *
 * `fromSide`/`toSide` are optional in JSON Canvas, so a document written by another tool
 * may omit them. Chooses the axis with the greater separation, which is what reads as
 * "the obvious way round" between two boxes.
 */
export function inferSide(from: Rect, to: Rect): Side {
    const fromCentre = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const toCentre = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    const dx = toCentre.x - fromCentre.x;
    const dy = toCentre.y - fromCentre.y;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
    return dy >= 0 ? 'bottom' : 'top';
}

/** The opposite side, used for the far end of an inferred edge. */
export function oppositeSide(side: Side): Side {
    switch (side) {
        case 'top': return 'bottom';
        case 'bottom': return 'top';
        case 'left': return 'right';
        case 'right': return 'left';
    }
}

/**
 * A cubic bezier between two side anchors, as an SVG path.
 *
 * Control points push straight out of each side before curving, so an edge leaves a card
 * perpendicular to its edge rather than cutting the corner -- the same shape Tangent's
 * MapConnectionView draws. The control distance grows with separation but is capped, so
 * edges across a large board do not balloon into circles.
 */
/** Where an arrowhead points, as a rotation in degrees, given the side it arrives at. */
export function arrowAngle(side: Side): number {
    // The head sits ON the anchor and points INTO the card, so an edge meeting the left
    // side points right.
    switch (side) {
        case 'left': return 0;
        case 'right': return 180;
        case 'top': return 90;
        case 'bottom': return 270;
    }
}

/**
 * The point halfway along the curve, for placing a label.
 *
 * The midpoint of the straight line between the anchors is not on the curve, and for the
 * strongly-pulled shape below it can sit well outside it -- so the label would float away
 * from its own edge. This evaluates the cubic at t=0.5, which is (P0 + 3C1 + 3C2 + P3) / 8.
 */
export function edgeMidpoint(start: Point, startSide: Side, end: Point, endSide: Side): Point {
    const { c1, c2 } = edgeControlPoints(start, startSide, end, endSide);
    return {
        x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
        y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
    };
}

function edgeControlPoints(start: Point, startSide: Side, end: Point, endSide: Side) {
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const pull = Math.min(150, Math.max(30, distance * 0.4));
    const control = (point: Point, side: Side): Point => {
        switch (side) {
            case 'top': return { x: point.x, y: point.y - pull };
            case 'bottom': return { x: point.x, y: point.y + pull };
            case 'left': return { x: point.x - pull, y: point.y };
            case 'right': return { x: point.x + pull, y: point.y };
        }
    };
    return { c1: control(start, startSide), c2: control(end, endSide) };
}

export function edgePath(start: Point, startSide: Side, end: Point, endSide: Side): string {
    const { c1, c2 } = edgeControlPoints(start, startSide, end, endSide);
    return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}
