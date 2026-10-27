/**
 * The arguments someone -- or the operating system, opening a file association -- passed to
 * OSINT Copilot, without the launcher's own.
 *
 * A packaged build is started as `<executable> [args]`; a development build as
 * `electron . [args]`, where Electron sets `process.defaultApp`. Dropping two leading
 * arguments in both cases, as this used to, threw away the first real argument of every
 * packaged launch: `osint-copilot ~/case` opened nothing, and neither did a file
 * double-clicked on Windows. It only worked from the Linux menu entry because that one
 * happens to pass `--ozone-platform=x11` first.
 */
export function userArguments(argv: readonly string[], defaultApp: boolean): string[] {
	const leading = defaultApp ? 2 : 1
	const args: string[] = []
	let skippedLeading = 0
	for (let i = 0; i < argv.length; i++) {
		const width = chromiumSwitchWidth(argv[i])
		if (width) {
			i += width - 1
		}
		else if (skippedLeading < leading) {
			skippedLeading++
		}
		else {
			args.push(argv[i])
		}
	}
	return args
}

/** Switches Chromium or Electron add to a relaunch or a second instance, and how many slots each takes. */
function chromiumSwitchWidth(arg: string): number {
	switch (arg) {
		case '--allow-file-access-from-files':
		case '--original-process-start-time':
			return 1
		// Consumes the next argument as well.
		case '--require':
			return 2
		default:
			return 0
	}
}
