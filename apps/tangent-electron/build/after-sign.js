// electron-builder's afterSign hook: notarize a macOS build, but only when Apple's
// credentials are there.
//
// Upstream's build/notarize.js is left as it is and called from here when it can work. On
// its own it runs whenever a build is published, and with no credentials @electron/notarize
// fails the whole build -- so a fork without an Apple Developer account could not produce a
// macOS build at all, signed or not.
//
// Set all three to notarize:
//
//   APPLE_ID            the Apple ID of the Developer Program account
//   APPLE_TEAM_ID       its team id
//   APPLE_ID_PASSWORD   an app-specific password for that Apple ID
//
// An unnotarized build still installs, but Gatekeeper refuses to open it without the user
// going through Privacy & Security by hand, and electron-updater cannot update it.

const REQUIRED = ['APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_ID_PASSWORD']

exports.default = async function afterSign(context) {
	if (context.electronPlatformName !== 'darwin') return

	const missing = REQUIRED.filter(name => !process.env[name])
	if (missing.length > 0) {
		console.warn(`  • not notarizing: ${missing.join(', ')} not set`)
		return
	}

	return require('./notarize').default(context)
}
