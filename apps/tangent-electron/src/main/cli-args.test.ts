import { describe, expect, it } from 'vitest'
import { userArguments } from './cli-args'

describe('userArguments', () => {
	it('keeps the path a packaged Windows build is opened with', () => {
		expect(userArguments(['C:\\Program Files\\OSINT Copilot\\OSINT Copilot.exe', 'C:\\cases\\note.md'], false))
			.toEqual(['C:\\cases\\note.md'])
	})

	it('keeps the path a packaged Linux build is opened with from a terminal', () => {
		expect(userArguments(['/opt/OSINT Copilot/osint-copilot', '/home/me/case'], false))
			.toEqual(['/home/me/case'])
	})

	it('keeps launcher switches for the argument parser to read as options', () => {
		expect(userArguments(['/opt/OSINT Copilot/osint-copilot', '--ozone-platform=x11', '/home/me/case'], false))
			.toEqual(['--ozone-platform=x11', '/home/me/case'])
	})

	it('drops electron and the app path in a development build', () => {
		expect(userArguments(['/repo/node_modules/electron/dist/electron', '.', '/home/me/case'], true))
			.toEqual(['/home/me/case'])
	})

	it('is empty when nothing was passed', () => {
		expect(userArguments(['/opt/OSINT Copilot/osint-copilot'], false)).toEqual([])
		expect(userArguments(['electron', '.'], true)).toEqual([])
	})

	it('drops the switches Chromium adds to a second instance', () => {
		expect(userArguments([
			'C:\\OSINT Copilot\\OSINT Copilot.exe',
			'--allow-file-access-from-files',
			'--original-process-start-time',
			'C:\\cases\\note.md',
		], false)).toEqual(['C:\\cases\\note.md'])
		expect(userArguments(['electron', '--require', 'hook.js', '.', '/case'], true)).toEqual(['/case'])
	})
})
