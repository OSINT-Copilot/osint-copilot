import { wait } from '@such-n-such/core'
import { ipcMain } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { mode } from './environment'

import { contentsMap, saveAndCloseWorkspaces } from './workspaces'
import { subscribeToSettings } from './settings'
import Logger from 'js-logger'
import {
	configureInstallPolicy,
	configureUpdateChannel,
	isPortableInstallation,
	supportedUpdateChannel,
} from '../common/update-policy'

const log = Logger.get('updates')

const portable = isPortableInstallation(process.env)
configureInstallPolicy(autoUpdater, portable)

let lastUpdateChecked = null
let readyUpdate: UpdateInfo = null
let nextFakeUpdateResult: 'download' | 'none' | 'error' = 'download'

autoUpdater.on('checking-for-update', alertCheckingForUpdate)
function alertCheckingForUpdate() {
	for (const handle of contentsMap.values()) {
		handle.alertCheckingForUpdate()
	}
}

autoUpdater.on('update-available', alertUpdateAvailable)
function alertUpdateAvailable(info: UpdateInfo) {
	log.info('Update available', info)
	for (const handle of contentsMap.values()) {
		handle.alertUpdateAvailable(info)
	}
}

autoUpdater.on('update-not-available', alertUpdateNotAvailable)
function alertUpdateNotAvailable() {
	for (const handle of contentsMap.values()) {
		handle.alertUpdateNotAvailable()
	}
}

autoUpdater.on('download-progress', postUpdateDownloadProgress)
function postUpdateDownloadProgress(progress: ProgressInfo) {
	for (const handle of contentsMap.values()) {
		handle.postUpdateDownloadProgress(progress)
	}
}

autoUpdater.on('update-downloaded', alertUpdateReady)
function alertUpdateReady(info: UpdateInfo) {
	readyUpdate = info
	log.info('Update downloaded', info)
	for (const handle of contentsMap.values()) {
		handle.alertUpdateReady(info)
	}
}

autoUpdater.on('error', alertUpdateError)
function alertUpdateError(message, stack) {
	log.error('Update failed:', message)
	for (const handle of contentsMap.values()) {
		handle.alertUpdateError(message, stack)
	}
}

export function checkForUpdatesThrottled() {
	if (readyUpdate) {
		alertUpdateReady(readyUpdate)
		return
	}
	
	if (!lastUpdateChecked || new Date().getTime() - lastUpdateChecked.getTime() >= 1000 * 60 * 60 * 24) {
		// Check now, and don't check again for another day
		log.info('Checking for updates on automatic interval...')
		checkForUpdates()
	}
}

export function checkForUpdates() {
	if (mode === 'production') {
		log.info('Checking for updates by user request...')
		lastUpdateChecked = new Date()
		// The rejection is caught, not just reported. electron-updater rejects this promise
		// AND emits 'error' (handled above), so without a catch every failed check is an
		// unhandled rejection -- which a packaged build hits on each window focus whenever
		// the feed is unreachable (private repo, no releases yet, or simply offline), and
		// which becomes a hard crash under --unhandled-rejections=strict.
		autoUpdater.checkForUpdates().catch(e => log.info('Update check failed:', e?.message ?? e))
	}
	else if (!process.env.INTEGRATION_TEST) {
		console.trace('Checking for Updates!')
		// Fake the update loop for testing
		async function fakeUpdate() {
			alertCheckingForUpdate()
			await wait(500)

			const fakeUpdate: UpdateInfo = {
				files: [],
				releaseDate: 'Fake Update Date',
				version: 'v1.2.3',
				path: '', // Deprecated
				sha512: '' // Deprecated
			}

			switch (nextFakeUpdateResult) {
				case 'download':
					nextFakeUpdateResult = 'none'
					alertUpdateAvailable(fakeUpdate)

					for (let i = 0; i < 100; i++) {
						await wait(10)
						postUpdateDownloadProgress({
							bytesPerSecond: 500,
							delta: 10,
							percent: i,
							total: 5000,
							transferred: (i + 1) * 50
						})
					}

					await wait(100)

					alertUpdateReady(fakeUpdate)
					break
				case 'none':
					nextFakeUpdateResult = 'error'
					alertUpdateNotAvailable()
					break
				case 'error':
					nextFakeUpdateResult = 'download'
					alertUpdateError('Test download error message', 'test download stack')
					break
			}
		}

		fakeUpdate()
	}
}

ipcMain.on('update', async (event, message) => {
	switch (message) {
		case 'now':
			if (portable) {
				log.info('Ignoring automatic install request from a portable build')
				break
			}
			if (readyUpdate) {
				if (mode === 'production') {
					log.info('Quitting and installing update by user request')
					await saveAndCloseWorkspaces()
					autoUpdater.quitAndInstall(false, true)
				}
				else {
					console.log('Update would now quit and install')
				}
			}
			break
		case 'check':
			checkForUpdates()
			break
	}
})

subscribeToSettings(settings => {
	const updateChannel = supportedUpdateChannel(settings.updateChannel.value)
	if (updateChannel !== autoUpdater.channel) {
		configureUpdateChannel(autoUpdater, updateChannel)
		if (settings.automaticallyCheckForUpdates.value) {
			checkForUpdates()
		}
	}
})
