/**
 * Choosing a display backend on Linux, from inside the app.
 *
 * Electron's Wayland backend segfaults on some systems the moment it builds its UI -- measured
 * again on Electron 42 in a clean nested compositor: the main script runs, then the process dies
 * with SIGSEGV before `ready`, and no GPU switch avoids it (--disable-gpu, --use-gl=swiftshader,
 * --disable-gpu-compositing and --in-process-gpu were all tried, all crashed).
 *
 * The platform is fixed before the main script runs, so nothing inside the app can change it:
 * `app.commandLine.appendSwitch('ozone-platform', 'x11')` and `ELECTRON_OZONE_PLATFORM_HINT=x11`
 * were both measured, and both still crash. What does work is re-exec: the main script runs early
 * enough to relaunch with the switch and exit before the crash.
 *
 * The packaged .desktop entry passes the switch already (electron-builder.json,
 * `linux.executableArgs`), so a menu launch never gets here. This is for the user who runs the
 * AppImage straight from a terminal, which is what the instructions used to tell them to do with
 * the switch typed out by hand.
 *
 * There is no relaunch loop to guard against: the child is started with --ozone-platform=x11 in
 * its arguments, which is the condition that stops this from firing again.
 */

/** Set OC_OZONE=native to keep whatever backend the session offers, crash included. */
export const OZONE_OPT_OUT = 'OC_OZONE'

export function x11RelaunchArgs(
	platform: NodeJS.Platform,
	env: Record<string, string | undefined>,
	argv: string[],
): string[] | null {
	if (platform !== 'linux') return null
	if (env[OZONE_OPT_OUT] === 'native') return null
	// Already chosen, by the desktop entry, the dev launcher or the user. Respect it, even when
	// what they chose is wayland.
	if (argv.some(arg => arg.startsWith('--ozone-platform'))) return null

	const onWayland = env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY)
	if (!onWayland) return null

	// argv[0] is this executable; everything after it is what the user asked for, and it has to
	// survive the relaunch (a workspace path, --dev-tools, and so on).
	return [...argv.slice(1), '--ozone-platform=x11']
}

/**
 * Inside an AppImage the running binary lives in a mount that disappears when this process
 * exits, so relaunching `process.execPath` would exec a path that is about to vanish. APPIMAGE
 * is the file the user actually ran.
 */
export function relaunchExecPath(env: Record<string, string | undefined>, execPath: string): string {
	return env.APPIMAGE || execPath
}
