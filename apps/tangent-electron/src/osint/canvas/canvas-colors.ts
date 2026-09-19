/**
 * The colours a JSON Canvas node or edge can carry, as CSS.
 *
 * One palette for both the board and the inspector's swatches, so a card, an edge and the
 * swatch that picked them always agree.
 */
import { normalizeCanvasColor, type CanvasColor } from './canvas-format';

/**
 * JSON Canvas presets "1".."6".
 *
 * The inspector writes the preset numbers rather than these hex values, because Obsidian
 * renders those with its own theme-aware palette -- writing hex would pin the colour to
 * whatever theme we happened to be in and look wrong in the other app.
 */
export const CANVAS_COLOR_PRESETS: readonly { value: CanvasColor, label: string, css: string }[] = [
    { value: '1', label: 'Red', css: '#e5534b' },
    { value: '2', label: 'Orange', css: '#e08c39' },
    { value: '3', label: 'Yellow', css: '#d9a406' },
    { value: '4', label: 'Green', css: '#4a9d5f' },
    { value: '5', label: 'Cyan', css: '#3d9fa8' },
    { value: '6', label: 'Purple', css: '#8b62c9' },
];

/**
 * A node's or edge's colour as CSS, or undefined when it has none.
 *
 * A preset becomes its palette entry and a hex value is used as it is. Anything else is
 * not a colour the spec allows, and is drawn as no colour, the same as the format layer
 * reads it.
 */
export function canvasColorCss(color?: CanvasColor): string | undefined {
    const valid = normalizeCanvasColor(color);
    if (!valid) return undefined;
    return CANVAS_COLOR_PRESETS.find((p) => p.value === valid)?.css ?? valid;
}
