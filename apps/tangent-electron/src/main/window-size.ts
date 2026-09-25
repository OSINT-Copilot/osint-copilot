/**
 * Where a new window goes, given the space the desktop actually has.
 *
 * The window was created at a fixed 2000x1200. On a screen smaller than that it opened at
 * 2016x1208 with its top-left corner at 0,0 -- measured on a 1280x752 work area, which put 736
 * pixels of width and 456 of height past the edge. The title bar sits at y=0 there, so the
 * window cannot even be dragged into view; a 1366x768 laptop is the common case, and 1920x1080
 * is already too short for 1200 once the taskbar is taken off.
 *
 * Clamping to the work area rather than the screen keeps the taskbar, dock and menu bar clear.
 * On a display with room for the preferred size nothing changes: the size is unchanged and the
 * position is the centre, which is where Electron puts a window with no position of its own.
 */

export interface Size {
	width: number
	height: number
}

export interface Bounds extends Size {
	x: number
	y: number
}

/** What the window asks for when the desktop is big enough to give it. */
export const PREFERRED_WINDOW_SIZE: Size = { width: 2000, height: 1200 }

/**
 * @param workArea the target display's work area, in screen coordinates.
 * @param preferred the size to use where the work area allows it.
 */
export function defaultWindowBounds(workArea: Bounds, preferred: Size = PREFERRED_WINDOW_SIZE): Bounds {
	const width = Math.min(preferred.width, workArea.width)
	const height = Math.min(preferred.height, workArea.height)
	return {
		width,
		height,
		// Rounded because a fractional position is not meaningful and Electron floors it anyway.
		x: workArea.x + Math.round((workArea.width - width) / 2),
		y: workArea.y + Math.round((workArea.height - height) / 2)
	}
}
