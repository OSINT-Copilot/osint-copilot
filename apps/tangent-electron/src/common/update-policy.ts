/** The only update channel currently published by the GitHub release feed. */
export const SUPPORTED_UPDATE_CHANNEL = 'latest'

export const UPDATE_DOWNLOAD_URL =
	'https://github.com/OSINT-Copilot/osint-copilot-releases/releases/latest'

interface UpdaterPolicyTarget {
	autoDownload: boolean
	autoInstallOnAppQuit: boolean
	channel: string | null
	allowDowngrade: boolean
}

export function isPortableInstallation(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.PORTABLE_EXECUTABLE_DIR)
}

/** Portable Windows builds must never download and run the NSIS installer. */
export function configureInstallPolicy(
	updater: Pick<UpdaterPolicyTarget, 'autoDownload' | 'autoInstallOnAppQuit'>,
	portable: boolean,
): void {
	updater.autoDownload = !portable
	updater.autoInstallOnAppQuit = !portable
}

/**
 * `electron-updater` enables downgrades as a side effect of assigning `channel`.
 * Put the guard immediately after that assignment every time.
 */
export function configureUpdateChannel(
	updater: Pick<UpdaterPolicyTarget, 'channel' | 'allowDowngrade'>,
	channel: string,
): void {
	updater.channel = channel
	updater.allowDowngrade = false
}

/** Old beta/alpha settings migrate to the only feed that actually exists. */
export function supportedUpdateChannel(_storedChannel?: string): string {
	return SUPPORTED_UPDATE_CHANNEL
}
