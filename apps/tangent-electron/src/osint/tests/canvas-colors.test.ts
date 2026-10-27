import { describe, it, expect } from 'vitest';
import { CANVAS_COLOR_PRESETS, canvasColorCss } from '../canvas/canvas-colors';
import { parseCanvas, serializeCanvas } from '../canvas/canvas-format';

describe('canvasColorCss', () => {
    it('maps the presets "1".."6" to the palette', () => {
        expect(canvasColorCss('1')).toBe('#e5534b');
        expect(CANVAS_COLOR_PRESETS.map((p) => p.value)).toEqual(['1', '2', '3', '4', '5', '6']);
        for (const preset of CANVAS_COLOR_PRESETS) {
            expect(canvasColorCss(preset.value)).toBe(preset.css);
        }
    });

    it('uses a hex colour as it is', () => {
        expect(canvasColorCss('#12abef')).toBe('#12abef');
    });

    it('draws no colour for a missing or unrecognised value', () => {
        expect(canvasColorCss(undefined)).toBeUndefined();
        expect(canvasColorCss('')).toBeUndefined();
        expect(canvasColorCss('red')).toBeUndefined();
    });

    it('draws the colour a saved board carries, for every preset', () => {
        for (const preset of CANVAS_COLOR_PRESETS) {
            const saved = serializeCanvas(parseCanvas(JSON.stringify({
                nodes: [{ id: 'n', type: 'text', x: 0, y: 0, width: 100, height: 60, text: '', color: preset.value }],
                edges: [],
            })).doc);
            const parsed = parseCanvas(saved).doc;
            expect(canvasColorCss(parsed.nodes[0].color)).toBe(preset.css);
        }
    });
});
