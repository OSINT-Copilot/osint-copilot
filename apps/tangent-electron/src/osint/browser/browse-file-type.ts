/**
 * The browsing pane's file extension, on its own so the view-state creator and the
 * commands can import it without pulling in the Svelte component.
 *
 * Like `.canvas`, a browsing pane is a DOCUMENT and not a singleton view: a thread can
 * hold several at once, which is the whole point of tiling them. That rules out the
 * marker-file pattern the six OSINT views use.
 *
 * The extension is also listed as a literal in common/fileExtensions.ts, because common/
 * is compiled by the main process's tsconfig, which cannot resolve `osint/*`.
 */
export const BROWSE_FILE_TYPE = '.osintbrowse'

/** Where new browsing panes are created. Visible analyst content, like boards/. */
export const BROWSE_FOLDER_NAME = 'browsing'

/**
 * What a `.osintbrowse` file holds.
 *
 * Deliberately minimal while the rendering approach is still being proven: a pane that
 * remembers one address is enough to exercise the pane lifecycle, and settling the real
 * schema (history, profile binding, capture index) before knowing whether a guest
 * survives the thread's animations would be settling it twice.
 */
export interface BrowseDocument {
	url?: string
}

export function parseBrowseDocument(text: string): BrowseDocument {
	try {
		const parsed = JSON.parse(text)
		return parsed && typeof parsed === 'object' ? parsed as BrowseDocument : {}
	}
	catch {
		return {}
	}
}
