import { describe, it, expect } from 'vitest';
import {
    defaultViewport, clampScale, worldToScreen, screenToWorld, zoomAbout,
    scaleFromWheel, panBy, rectContains, rectsIntersect, rectFromCorners,
    visibleWorldRect, cullToViewport, fitToRects, sideAnchor, inferSide,
    oppositeSide, edgePath, MIN_SCALE, MAX_SCALE,
    type Rect,
} from '../canvas/canvas-viewport';

describe('world <-> screen', () => {
    it('is an exact inverse at any pan and zoom', () => {
        const viewports = [
            defaultViewport(),
            { x: 0, y: 0, scale: 0.25 },
            { x: -1500, y: 320.5, scale: 2.5 },
            { x: 12, y: -7, scale: MIN_SCALE },
        ];
        for (const viewport of viewports) {
            for (const point of [{ x: 0, y: 0 }, { x: 137.5, y: -42 }, { x: -9000, y: 9000 }]) {
                const roundTrip = screenToWorld(viewport, worldToScreen(viewport, point));
                expect(roundTrip.x).toBeCloseTo(point.x, 6);
                expect(roundTrip.y).toBeCloseTo(point.y, 6);
            }
        }
    });

    it('places the origin at the pan offset scaled', () => {
        const viewport = { x: 100, y: 50, scale: 2 };
        expect(worldToScreen(viewport, { x: 0, y: 0 })).toEqual({ x: 200, y: 100 });
    });
});

describe('zoomAbout', () => {
    it('keeps the point under the cursor exactly where it was', () => {
        // Otherwise zooming feels like the board slides away from the pointer.
        const before = { x: -300, y: 120, scale: 0.8 };
        const cursor = { x: 640, y: 360 };
        const worldUnderCursor = screenToWorld(before, cursor);

        for (const nextScale of [0.1, 0.81, 1.6, 4]) {
            const after = zoomAbout(before, cursor, nextScale);
            const stillUnderCursor = screenToWorld(after, cursor);
            expect(stillUnderCursor.x).toBeCloseTo(worldUnderCursor.x, 6);
            expect(stillUnderCursor.y).toBeCloseTo(worldUnderCursor.y, 6);
        }
    });

    it('clamps rather than letting the board vanish or explode', () => {
        const viewport = defaultViewport();
        expect(zoomAbout(viewport, { x: 0, y: 0 }, 0).scale).toBe(MIN_SCALE);
        expect(zoomAbout(viewport, { x: 0, y: 0 }, 9999).scale).toBe(MAX_SCALE);
        expect(clampScale(NaN)).toBe(1);
        expect(clampScale(Infinity)).toBe(MAX_SCALE);
    });
});

describe('scaleFromWheel', () => {
    it('zooms in on negative delta and out on positive', () => {
        expect(scaleFromWheel(1, -100)).toBeGreaterThan(1);
        expect(scaleFromWheel(1, 100)).toBeLessThan(1);
    });

    it('treats a large discrete delta as a mouse wheel, not a trackpad', () => {
        // Same total delta, delivered as one big tick vs many small ones; the big tick is
        // damped hard or a single wheel click would cross the whole zoom range.
        const oneBigTick = scaleFromWheel(1, 120);
        const smallTick = scaleFromWheel(1, 10);
        expect(1 - oneBigTick).toBeLessThan((1 - smallTick) * 12);
    });

    it('never leaves the clamp', () => {
        expect(scaleFromWheel(MIN_SCALE, 5000)).toBe(MIN_SCALE);
        expect(scaleFromWheel(MAX_SCALE, -5000)).toBe(MAX_SCALE);
    });
});

describe('panBy', () => {
    it('moves the board the same screen distance at any zoom', () => {
        for (const scale of [0.25, 1, 3]) {
            const before = { x: 0, y: 0, scale };
            const after = panBy(before, 100, 0);
            const movedOnScreen = worldToScreen(after, { x: 0, y: 0 }).x
                - worldToScreen(before, { x: 0, y: 0 }).x;
            expect(movedOnScreen).toBeCloseTo(100, 6);
        }
    });
});

describe('rect helpers', () => {
    const rect: Rect = { x: 10, y: 10, width: 100, height: 50 };

    it('tests containment inclusive of the edges', () => {
        expect(rectContains(rect, { x: 50, y: 30 })).toBe(true);
        expect(rectContains(rect, { x: 10, y: 10 })).toBe(true);
        expect(rectContains(rect, { x: 110, y: 60 })).toBe(true);
        expect(rectContains(rect, { x: 9, y: 30 })).toBe(false);
        expect(rectContains(rect, { x: 50, y: 61 })).toBe(false);
    });

    it('detects overlap but not mere adjacency', () => {
        expect(rectsIntersect(rect, { x: 100, y: 50, width: 10, height: 10 })).toBe(true);
        expect(rectsIntersect(rect, { x: 110, y: 10, width: 10, height: 10 })).toBe(false);
        expect(rectsIntersect(rect, { x: 0, y: 0, width: 500, height: 500 })).toBe(true);
    });

    it('normalises a marquee dragged in any direction', () => {
        const dragged = rectFromCorners({ x: 100, y: 80 }, { x: 20, y: 10 });
        expect(dragged).toEqual({ x: 20, y: 10, width: 80, height: 70 });
    });
});

describe('culling', () => {
    it('reports the world rect on screen', () => {
        const visible = visibleWorldRect({ x: 0, y: 0, scale: 2 }, 800, 600);
        expect(visible).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    });

    it('keeps offscreen cards mounted one screen out, and drops the rest', () => {
        // Mounting a NoteEditor mid-pan is a visible stutter, so cards are mounted before
        // they arrive; but a large board must not mount everything.
        const visible: Rect = { x: 0, y: 0, width: 1000, height: 1000 };
        const items = [
            { id: 'onscreen', rect: { x: 100, y: 100, width: 50, height: 50 } },
            { id: 'just-off', rect: { x: 1200, y: 100, width: 50, height: 50 } },
            { id: 'far-away', rect: { x: 50000, y: 0, width: 50, height: 50 } },
        ];
        const kept = cullToViewport(items, visible).map((i) => i.id);
        expect(kept).toContain('onscreen');
        expect(kept).toContain('just-off');
        expect(kept).not.toContain('far-away');
    });
});

describe('fitToRects', () => {
    it('centres the content and scales it to fit', () => {
        const viewport = fitToRects(
            [{ x: 0, y: 0, width: 1000, height: 500 }], 1000, 1000, 0,
        );
        expect(viewport.scale).toBeCloseTo(1, 6);
        const topLeft = worldToScreen(viewport, { x: 0, y: 0 });
        expect(topLeft.x).toBeCloseTo(0, 6);
        expect(topLeft.y).toBeCloseTo(250, 6);
    });

    it('does not snap to max zoom on a single point', () => {
        // Zero-area bounds divide to Infinity. The map had exactly this bug: one marker
        // fit to street level with no context.
        const viewport = fitToRects([{ x: 5, y: 5, width: 0, height: 0 }], 800, 600);
        expect(viewport.scale).toBe(1);
        const onScreen = worldToScreen(viewport, { x: 5, y: 5 });
        expect(onScreen.x).toBeCloseTo(400, 6);
        expect(onScreen.y).toBeCloseTo(300, 6);
    });

    it('falls back safely on no content or an unmeasured panel', () => {
        expect(fitToRects([], 800, 600)).toEqual(defaultViewport());
        // 0x0 is what the panel measures as before layout runs.
        expect(fitToRects([{ x: 0, y: 0, width: 10, height: 10 }], 0, 0)).toEqual(defaultViewport());
    });
});

describe('edge anchoring', () => {
    const rect: Rect = { x: 0, y: 0, width: 100, height: 60 };

    it('anchors to the middle of each side', () => {
        expect(sideAnchor(rect, 'top')).toEqual({ x: 50, y: 0 });
        expect(sideAnchor(rect, 'bottom')).toEqual({ x: 50, y: 60 });
        expect(sideAnchor(rect, 'left')).toEqual({ x: 0, y: 30 });
        expect(sideAnchor(rect, 'right')).toEqual({ x: 100, y: 30 });
    });

    it('infers the obvious side when the file omits one', () => {
        // fromSide/toSide are optional in JSON Canvas, so another tool may not write them.
        const from: Rect = { x: 0, y: 0, width: 100, height: 100 };
        expect(inferSide(from, { x: 500, y: 0, width: 100, height: 100 })).toBe('right');
        expect(inferSide(from, { x: -500, y: 0, width: 100, height: 100 })).toBe('left');
        expect(inferSide(from, { x: 0, y: 500, width: 100, height: 100 })).toBe('bottom');
        expect(inferSide(from, { x: 0, y: -500, width: 100, height: 100 })).toBe('top');
    });

    it('pairs an inferred side with its opposite', () => {
        expect(oppositeSide('top')).toBe('bottom');
        expect(oppositeSide('left')).toBe('right');
        expect(oppositeSide(oppositeSide('right'))).toBe('right');
    });

    it('draws a bezier that leaves each card perpendicular to its side', () => {
        const path = edgePath({ x: 0, y: 0 }, 'right', { x: 200, y: 0 }, 'left');
        expect(path).toMatch(/^M 0 0 C /);
        const [, c1x, c1y, c2x, c2y] = path.match(
            /C ([\d.-]+) ([\d.-]+), ([\d.-]+) ([\d.-]+),/,
        ) as RegExpMatchArray;
        // Control points push straight out sideways, so the curve does not cut the corner.
        expect(Number(c1x)).toBeGreaterThan(0);
        expect(Number(c1y)).toBe(0);
        expect(Number(c2x)).toBeLessThan(200);
        expect(Number(c2y)).toBe(0);
    });

    it('caps the control distance so long edges do not balloon', () => {
        const long = edgePath({ x: 0, y: 0 }, 'right', { x: 100000, y: 0 }, 'left');
        const [, c1x] = long.match(/C ([\d.-]+) /) as RegExpMatchArray;
        expect(Number(c1x)).toBeLessThanOrEqual(150);
    });
});
