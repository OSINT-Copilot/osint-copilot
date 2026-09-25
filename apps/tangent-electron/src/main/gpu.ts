/**
 * Whether Chromium's GPU sandbox has to be turned off for the GPU process to start at all.
 *
 * On a machine with no DRM render node -- a virtual machine, a container, some remote desktops --
 * the GPU process fails its sandbox initialisation, Chromium retries three times and then aborts
 * the whole application with "GPU process isn't usable. Goodbye." The application never opens a
 * window, and nothing in the message says why.
 *
 * Measured in a Fedora 43 VM: /dev/dri holds `card0` and no `renderD*`, and the GPU process dies.
 * Of the flags tried there, only --disable-gpu-sandbox helped: --disable-gpu, --use-gl=swiftshader,
 * --disable-accelerated-video-decode and disabling the VA-API features all still aborted. The same
 * machine runs Fedora's own Chromium fine, so this is ours to handle.
 *
 * The switch is applied only where the render node is missing. A normal desktop has one
 * (/dev/dri/renderD128), keeps its GPU sandbox, and never reaches this code.
 */
import fs from 'fs'

export const DRI_PATH = '/dev/dri'

/** @param readDri lists /dev/dri; injected so the decision can be tested without one. */
export function gpuSandboxWouldFail(
	platform: NodeJS.Platform,
	readDri: () => string[] = () => fs.readdirSync(DRI_PATH),
): boolean {
	if (platform !== 'linux') return false
	let entries: string[]
	try {
		entries = readDri()
	}
	catch {
		// No /dev/dri at all: a container or a headless server, and the same failure.
		return true
	}
	return !entries.some(name => name.startsWith('renderD'))
}
