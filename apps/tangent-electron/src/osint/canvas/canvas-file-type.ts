/**
 * The canvas file extension, on its own so both the view-state creator and the plugin can
 * import it without pulling in the Svelte component.
 *
 * `.canvas` is Obsidian's, and that is the point: the same file opens in either app. It is
 * added to `common/fileExtensions.ts` as a literal string, because `common/` is shared
 * with the main process, whose tsconfig cannot resolve `osint/*`.
 */
export const CANVAS_FILE_TYPE = '.canvas';
