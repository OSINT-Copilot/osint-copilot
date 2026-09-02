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
    /** Base filename, and what the panel is called. */
    title: string;
    /** Key under which the open command is registered with Tangent. */
    commandKey: string;
}

export const OSINT_VIEWS: readonly OsintViewDescriptor[] = [
    { viewType: 'vault-ai-chat-view', fileType: '.osintchat', title: 'OSINT Chat', commandKey: 'osintOpenChat' },
    { viewType: 'graph_copilot-graph-view', fileType: '.osintgraph', title: 'Entity Graph', commandKey: 'osintOpenGraph' },
    { viewType: 'graph_copilot-timeline-view', fileType: '.osinttimeline', title: 'Timeline', commandKey: 'osintOpenTimeline' },
    { viewType: 'graph_copilot-map-view', fileType: '.osintmap', title: 'Location Map', commandKey: 'osintOpenMap' },
    { viewType: 'osint-copilot-tools-skills-registry', fileType: '.osintregistry', title: 'Tools & Skills', commandKey: 'osintOpenRegistry' },
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
