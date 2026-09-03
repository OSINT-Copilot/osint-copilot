/**
 * setIcon -- Obsidian uses the Lucide icon set, so `lucide-static` gives byte-identical
 * glyphs for the names already in the code (map-pin, pencil, crosshair, chevron-down,
 * file-text, lock, message-square, layout-list, git-fork, calendar).
 */
import * as lucide from 'lucide-static';
import { hasLucideIcon, lucideSvg } from '../../integration/lucide-svg';

const icons = lucide as unknown as Record<string, string>;

export function setIcon(el: HTMLElement, iconName: string): void {
    // One mapping, shared with the toolbar pill, which cannot call this function because
    // it mounts before installDomExtensions() has provided addClass.
    if (hasLucideIcon(iconName)) {
        el.innerHTML = lucideSvg(iconName);
        el.addClass('svg-icon-wrapper');
        return;
    }
    // Unknown icon: leave a labelled placeholder rather than silently rendering nothing,
    // so a typo'd icon name is visible during development.
    el.textContent = '';
    el.setAttribute('data-missing-icon', iconName);
}

export function getIconIds(): string[] {
    return Object.keys(icons);
}
