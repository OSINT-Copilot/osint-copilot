import { describe, it, expect } from 'vitest'
import { x11RelaunchArgs, relaunchExecPath } from './ozone'

const EXE = '/opt/OSINT Copilot/osint-copilot'

describe('x11RelaunchArgs', () => {
	it('relaunches with X11 on a Wayland session that chose no backend', () => {
		expect(x11RelaunchArgs('linux', { XDG_SESSION_TYPE: 'wayland' }, [EXE]))
			.toEqual(['--ozone-platform=x11'])
	})

	it('keeps the arguments the user gave, so a workspace path survives the relaunch', () => {
		expect(x11RelaunchArgs('linux', { WAYLAND_DISPLAY: 'wayland-0' }, [EXE, '/cases/Northgate', '--dev-tools']))
			.toEqual(['/cases/Northgate', '--dev-tools', '--ozone-platform=x11'])
	})

	it('does nothing when a backend was already chosen, which is what stops a relaunch loop', () => {
		expect(x11RelaunchArgs('linux', { XDG_SESSION_TYPE: 'wayland' }, [EXE, '--ozone-platform=x11'])).toBeNull()
		// Including when what they chose is the one that crashes: their machine, their call.
		expect(x11RelaunchArgs('linux', { XDG_SESSION_TYPE: 'wayland' }, [EXE, '--ozone-platform=wayland'])).toBeNull()
	})

	it('does nothing on X11, on another platform, or when opted out', () => {
		expect(x11RelaunchArgs('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }, [EXE])).toBeNull()
		expect(x11RelaunchArgs('darwin', { XDG_SESSION_TYPE: 'wayland' }, [EXE])).toBeNull()
		expect(x11RelaunchArgs('win32', { WAYLAND_DISPLAY: 'wayland-0' }, [EXE])).toBeNull()
		expect(x11RelaunchArgs('linux', { XDG_SESSION_TYPE: 'wayland', OC_OZONE: 'native' }, [EXE])).toBeNull()
	})
})

describe('relaunchExecPath', () => {
	it('re-execs the AppImage file, not the mount that is about to vanish', () => {
		expect(relaunchExecPath({ APPIMAGE: '/home/a/Apps/osint-copilot.AppImage' }, '/tmp/.mount_xyz/osint-copilot'))
			.toBe('/home/a/Apps/osint-copilot.AppImage')
	})

	it('re-execs itself when it is not an AppImage', () => {
		expect(relaunchExecPath({}, EXE)).toBe(EXE)
	})
})
