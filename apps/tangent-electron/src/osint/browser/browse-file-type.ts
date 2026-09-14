/**
 * The browsing pane's file extension, on its own so the view-state creator and the
 * commands can import it without pulling in the Svelte component.
 *
 * Like `.canvas`, a browsing pane is a DOCUMENT and not a singleton view: a thread can
 * hold several at once, which is the point of tiling them. That rules out the marker-file
 * pattern the six OSINT views use.
 *
 * The extension is repeated as a literal in common/fileExtensions.ts, because common/ is
 * compiled by the main process's tsconfig, which cannot resolve `osint/*`.
 * osint-view-types.test.ts asserts the two stay in step.
 */
export const BROWSE_FILE_TYPE = '.osintbrowse';
