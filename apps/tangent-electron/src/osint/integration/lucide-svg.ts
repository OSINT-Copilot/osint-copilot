/**
 * Lucide icon markup by name, as a string.
 *
 * Pure, so it can run before the plugin has bootstrapped. The toolbar pill mounts with
 * Tangent's WorkspaceView, which is before bootstrap.ts has installed the Obsidian DOM
 * extensions -- and setIcon() calls `el.addClass`, which does not exist until then. The
 * old ribbon never hit this only because it polled until the plugin was up.
 *
 * The same PascalCase mapping set-icon.ts uses, so the two agree on every name.
 */
import * as lucide from 'lucide-static';

const icons = lucide as unknown as Record<string, string>;

/** lucide-static exports PascalCase keys; the codebase uses kebab-case names. */
export function lucideExportName(name: string): string {
    return name.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

/** The SVG for a kebab-case lucide name, or '' (and a console error) for a name it lacks. */
export function lucideSvg(name: string): string {
    const svg = icons[lucideExportName(name)];
    if (typeof svg === 'string') return svg;
    console.error('[osint] unknown lucide icon', name);
    return '';
}

export function hasLucideIcon(name: string): boolean {
    return typeof icons[lucideExportName(name)] === 'string';
}
