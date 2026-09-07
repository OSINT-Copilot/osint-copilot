const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '.env') })

const { notarize } = require('@electron/notarize')

exports.default = async function notarizeTheApp(context) {

	if (context.electronPlatformName !== 'darwin') {
		return
	}

	const publishIndex = process.argv.indexOf('--publish')
	if (publishIndex >= 0 && process.env.NOTARIZE !== 'force') {
		if (process.argv[publishIndex + 1] === 'never') {
			return
		}
	}

	const appName = context.packager.appInfo.productFilename

	let notarizeConfig = {
		tool: 'notarytool',
		// From the resolved app info rather than by re-reading electron-builder.json.
		// That require() had to parse the file as strict JSON, which stopped it carrying
		// comments -- and electron-builder itself reads it as JSON5, so the config could
		// not explain itself. This is also simply the more correct value: it is the appId
		// electron-builder actually used, not a second reading of the same file.
		appBundleId: context.packager.appInfo.id,
		appPath: `${context.appOutDir}/${appName}.app`,
		appleId: process.env.APPLE_ID,
		teamId: process.env.APPLE_TEAM_ID,
		appleIdPassword: process.env.APPLE_ID_PASSWORD
	}

	console.log('notarizing...')

	let start = new Date()

	await notarize(notarizeConfig)

	let end = new Date()

	console.log('Notarized in ' + ((end - start) / 1000) + ' seconds')
}