import { describe, it, expect } from 'vitest';
import { OSINT_VIEWS, OSINT_FILE_TYPES } from '../integration/osint-view-types';
import { visibleFileTypeMatch } from '../../common/fileExtensions';
import { CHAT_VIEW_TYPE } from '../views/chat-view';
import { GRAPH_VIEW_TYPE } from '../views/graph-view';
import { TIMELINE_VIEW_TYPE } from '../views/timeline-view';
import { MAP_VIEW_TYPE } from '../views/map-view';
import { TOOLS_SKILLS_REGISTRY_VIEW_TYPE } from '../views/tools-skills-registry-view';

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
            MAP_VIEW_TYPE, TOOLS_SKILLS_REGISTRY_VIEW_TYPE,
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

    it('has a unique file type, view type and command key per view', () => {
        const unique = (xs: string[]) => new Set(xs).size === xs.length;
        expect(unique(OSINT_VIEWS.map(v => v.fileType))).toBe(true);
        expect(unique(OSINT_VIEWS.map(v => v.viewType))).toBe(true);
        expect(unique(OSINT_VIEWS.map(v => v.commandKey))).toBe(true);
    });
});
