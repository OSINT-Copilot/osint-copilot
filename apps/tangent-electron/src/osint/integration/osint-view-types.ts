/**
 * The five OSINT views, described with literal strings and nothing else.
 *
 * Deliberately dependency-free, for two reasons:
 *   - common/fileExtensions.ts needs the extensions, and common/ is shared with the main
 *     process, whose tsconfig cannot resolve `osint/*`.
 *   - Tangent's command registry needs the titles and view types, and importing the real
 *     view modules there would pull cytoscape, leaflet and ~9,700 lines of view code into
 *     the app's startup path for users who never open an OSINT view.
 *
 * osint-view-types.test.ts asserts these literals still match the constants the view
 * modules actually export, and that fileExtensions.ts lists all of them.
 */
export interface OsintViewDescriptor {
    /** Obsidian view type, as registered by the plugin. */
    viewType: string;
    /** File extension that makes a node open as this view. */
    fileType: string;
    /**
     * Base filename under .tangent/osint, and the node name Tangent shows.
     *
     * Do not rename: nodePathFor() derives the marker path from it, and saved sessions
     * store that path -- Session.ts turns a missing path into a placeholder node that
     * cannot render. User-facing wording lives in `label` instead.
     */
    title: string;
    /** What the toolbar tooltip, command palette and shortcut editor call the view. */
    label: string;
    /** lucide-static icon name, kebab-case, as set-icon.ts already resolves it. */
    icon: string;
    /** Default shortcut in Tangent's 'Mod+...' syntax. Reassignable in Settings -> Shortcuts. */
    shortcut: string;
    /** Hidden from the toolbar, and refused by its command, while enableGraphFeatures is off. */
    requiresGraphFeatures: boolean;
    /** Key under which the open command is registered with Tangent. */
    commandKey: string;
}

/**
 * Order matters twice over: it is the toolbar order, and the shortcut digit.
 *
 * On names: Tangent's own "Map View" (Mod+G) is a node-link diagram of the thread, so
 * calling the entity graph "graph" and the geographic map "map" put three different things
 * under two overlapping words in the same strip. "Entities" and "Locations" say what the
 * views actually show and collide with nothing.
 */
export const OSINT_VIEWS: readonly OsintViewDescriptor[] = [
    {
        viewType: 'vault-ai-chat-view', fileType: '.osintchat', title: 'OSINT Chat',
        label: 'Chat', icon: 'message-square', shortcut: 'Mod+Alt+1',
        requiresGraphFeatures: false, commandKey: 'osintOpenChat',
    },
    {
        viewType: 'graph_copilot-graph-view', fileType: '.osintgraph', title: 'Entity Graph',
        label: 'Entities', icon: 'git-fork', shortcut: 'Mod+Alt+2',
        requiresGraphFeatures: true, commandKey: 'osintOpenGraph',
    },
    {
        viewType: 'graph_copilot-timeline-view', fileType: '.osinttimeline', title: 'Timeline',
        label: 'Timeline', icon: 'calendar', shortcut: 'Mod+Alt+3',
        requiresGraphFeatures: true, commandKey: 'osintOpenTimeline',
    },
    {
        viewType: 'graph_copilot-map-view', fileType: '.osintmap', title: 'Location Map',
        label: 'Locations', icon: 'map-pin', shortcut: 'Mod+Alt+4',
        requiresGraphFeatures: true, commandKey: 'osintOpenMap',
    },
    {
        viewType: 'osint-copilot-tools-skills-registry', fileType: '.osintregistry', title: 'Tools & Skills',
        label: 'Tools & Skills', icon: 'layout-list', shortcut: 'Mod+Alt+5',
        requiresGraphFeatures: false, commandKey: 'osintOpenRegistry',
    },
] as const;

export const OSINT_FILE_TYPES = OSINT_VIEWS.map(v => v.fileType);

export const OSINT_VIEW_FOLDER = '.tangent/osint';

export function viewForFileType(fileType: string): OsintViewDescriptor | undefined {
    return OSINT_VIEWS.find(v => v.fileType === fileType);
}

export function viewForViewType(viewType: string): OsintViewDescriptor | undefined {
    return OSINT_VIEWS.find(v => v.viewType === viewType);
}

/** Workspace-relative path of the marker file backing a view. */
export function nodePathFor(view: OsintViewDescriptor): string {
    return `${OSINT_VIEW_FOLDER}/${view.title}${view.fileType}`;
}
