import { describe, test, expect } from 'vitest'
import { defaultWindowBounds, PREFERRED_WINDOW_SIZE } from './window-size'

describe('defaultWindowBounds', () => {
	test('keeps the preferred size on a display with room for it', () => {
		const bounds = defaultWindowBounds({ x: 0, y: 0, width: 2560, height: 1400 })
		expect(bounds.width).toEqual(PREFERRED_WINDOW_SIZE.width)
		expect(bounds.height).toEqual(PREFERRED_WINDOW_SIZE.height)
	})

	test('centres the window in the work area', () => {
		const bounds = defaultWindowBounds({ x: 0, y: 0, width: 2560, height: 1400 })
		expect(bounds.x).toEqual(280)
		expect(bounds.y).toEqual(100)
	})

	test('fits a laptop that is smaller than the preferred size in both directions', () => {
		// The 1366x768 case, minus a 48px taskbar.
		const bounds = defaultWindowBounds({ x: 0, y: 0, width: 1366, height: 720 })
		expect(bounds).toEqual({ x: 0, y: 0, width: 1366, height: 720 })
	})

	test('fits a display that is wide enough but not tall enough', () => {
		// 1920x1080 is the common desktop, and 1080 minus the taskbar is under 1200.
		const bounds = defaultWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 })
		expect(bounds.width).toEqual(1920)
		expect(bounds.height).toEqual(1040)
	})

	test('never puts any edge outside the work area', () => {
		// The measured Windows VM case, which opened at 2016x1208 on this work area.
		const workArea = { x: 0, y: 0, width: 1280, height: 752 }
		const bounds = defaultWindowBounds(workArea)
		expect(bounds.x).toBeGreaterThanOrEqual(workArea.x)
		expect(bounds.y).toBeGreaterThanOrEqual(workArea.y)
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width)
		expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height)
	})

	test('respects a work area that does not start at the origin', () => {
		// A second monitor to the right, with a menu bar or dock taking the top.
		const bounds = defaultWindowBounds({ x: 1920, y: 40, width: 1280, height: 712 })
		expect(bounds).toEqual({ x: 1920, y: 40, width: 1280, height: 712 })
	})
})
