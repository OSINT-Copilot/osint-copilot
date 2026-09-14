import { describe, it, expect } from 'vitest';
import { OSINT_VIEWS, OSINT_FILE_TYPES } from '../integration/osint-view-types';
import { knownExtensions, visibleFileTypeMatch } from '../../common/fileExtensions';
import { BROWSE_FILE_TYPE } from '../browser/browse-file-type';
import { CHAT_VIEW_TYPE } from '../views/chat-view';
import { GRAPH_VIEW_TYPE } from '../views/graph-view';
import { TIMELINE_VIEW_TYPE } from '../views/timeline-view';
import { MAP_VIEW_TYPE } from '../views/map-view';
import { TOOLS_SKILLS_REGISTRY_VIEW_TYPE } from '../views/tools-skills-registry-view';
import { DOCS_VIEW_TYPE } from '../views/docs-view';
import { CANVAS_FILE_TYPE } from '../canvas/canvas-file-type';
import { hasLucideIcon } from '../integration/lucide-svg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * osint-view-types.ts spells its view types out as literals so that Tangent's command
 * registry and common/fileExtensions.ts can use it without pulling in the view layer
 * (cytoscape, leaflet, ~9,700 lines) or hitting a module path main's tsconfig cannot
 * resolve. These are the guards against those copies drifting.
 */
describe('OSINT view descriptors', () => {
    it('use the same view types the view modules actually register', () => {
        const declared = OSINT_VIEWS.map(v => v.viewType).sort();
        const actual = [
            CHAT_VIEW_TYPE, GRAPH_VIEW_TYPE, TIMELINE_VIEW_TYPE,
            MAP_VIEW_TYPE, TOOLS_SKILLS_REGISTRY_VIEW_TYPE, DOCS_VIEW_TYPE,
        ].sort();
        expect(declared).toEqual(actual);
    });

    it('are all registered as visible file types in Tangent', () => {
        for (const fileType of OSINT_FILE_TYPES) {
            expect(fileType, `${fileType} is missing from visibleFileTypeMatch`)
                .toMatch(visibleFileTypeMatch);
        }
    });

    it('does not match an unrelated extension', () => {
        expect('.osintnope').not.toMatch(visibleFileTypeMatch);
    });

    it('registers the canvas extension so boards appear in the tree and quick-open', () => {
        // Same literal-string constraint as the view types: common/ is shared with the
        // main process and cannot import from osint/, so the two lists must be kept in
        // step by hand -- which is what this asserts.
        expect(CANVAS_FILE_TYPE).toMatch(visibleFileTypeMatch);
        // And in knownExtensions, or [[Board.canvas]] gets '.md' appended and resolves to
        // a virtual note instead of the board.
        expect(knownExtensions).toContain(CANVAS_FILE_TYPE);
    });

    it('registers the browsing extension, on the same hand-kept list', () => {
        // A browsing pane is a document like a board, not a singleton view, so it is not
        // in OSINT_VIEWS -- but it has the same problem: common/ cannot import from
        // osint/, so the literal has to be repeated and can drift.
        expect(BROWSE_FILE_TYPE).toMatch(visibleFileTypeMatch);
        expect(knownExtensions).toContain(BROWSE_FILE_TYPE);
    });

    it('does not collide with a view file type', () => {
        expect(OSINT_VIEWS.map(v => v.fileType)).not.toContain(BROWSE_FILE_TYPE);
    });

    it('has a unique file type, view type and command key per view', () => {
        const unique = (xs: string[]) => new Set(xs).size === xs.length;
        expect(unique(OSINT_VIEWS.map(v => v.fileType))).toBe(true);
        expect(unique(OSINT_VIEWS.map(v => v.viewType))).toBe(true);
        expect(unique(OSINT_VIEWS.map(v => v.commandKey))).toBe(true);
        expect(unique(OSINT_VIEWS.map(v => v.label))).toBe(true);
        expect(unique(OSINT_VIEWS.map(v => v.icon))).toBe(true);
        expect(unique(OSINT_VIEWS.map(v => v.shortcut))).toBe(true);
    });

    it('names an icon lucide actually ships, for every view', () => {
        // A typo here used to surface only as an empty toolbar button at runtime.
        for (const view of OSINT_VIEWS) {
            expect(hasLucideIcon(view.icon), `${view.label}: ${view.icon}`).toBe(true);
        }
    });

    it('numbers its shortcuts in toolbar order', () => {
        // The digit is the position in the pill, so a user can learn them left to right.
        OSINT_VIEWS.forEach((view, index) => {
            expect(view.shortcut, view.label).toBe(`Mod+Alt+${index + 1}`);
        });
    });

    it('does not take a shortcut Tangent already uses', () => {
        // Read as text rather than importing the registry, which would construct the
        // whole Workspace model. Tangent spells shortcuts as string literals there.
        const registry = readFileSync(
            resolve(__dirname, '../../app/model/commands/index.ts'), 'utf8');
        for (const view of OSINT_VIEWS) {
            expect(registry, `${view.shortcut} is already bound in Tangent`)
                .not.toContain(`'${view.shortcut}'`);
        }
    });

    it('gates exactly the graph-backed views', () => {
        const gated = OSINT_VIEWS.filter(v => v.requiresGraphFeatures).map(v => v.label);
        expect(gated).toEqual(['Entities', 'Timeline', 'Locations']);
    });

    it('never renames a marker file', () => {
        // `title` is the filename under .tangent/osint and saved sessions store that path.
        // Wording changes belong in `label`; this pins the titles so a well-meant rename
        // cannot orphan every existing vault's markers.
        expect(OSINT_VIEWS.map(v => v.title)).toEqual([
            'OSINT Chat', 'Entity Graph', 'Timeline', 'Location Map', 'Tools & Skills',
            'Documentation',
        ]);
    });
});
