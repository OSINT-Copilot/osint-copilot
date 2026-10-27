import { describe, expect, it } from 'vitest'

import {
	configureInstallPolicy,
	configureUpdateChannel,
	isPortableInstallation,
	SUPPORTED_UPDATE_CHANNEL,
	supportedUpdateChannel,
} from './update-policy'

describe('update policy', () => {
	it('disables automatic download and install for a Windows portable process', () => {
		const updater = { autoDownload: true, autoInstallOnAppQuit: true }
		configureInstallPolicy(updater, isPortableInstallation({ PORTABLE_EXECUTABLE_DIR: 'C:\\OSINT' }))
		expect(updater).toEqual({ autoDownload: false, autoInstallOnAppQuit: false })
	})

	it('keeps automatic updates for installed builds', () => {
		const updater = { autoDownload: false, autoInstallOnAppQuit: false }
		configureInstallPolicy(updater, isPortableInstallation({}))
		expect(updater).toEqual({ autoDownload: true, autoInstallOnAppQuit: true })
	})

	it('turns downgrade support back off after assigning the channel', () => {
		let channel: string | null = null
		const updater = {
			allowDowngrade: false,
			get channel() { return channel },
			set channel(value: string | null) {
				channel = value
				// Mirrors electron-updater's surprising channel setter side effect.
				this.allowDowngrade = true
			},
		}

		configureUpdateChannel(updater, SUPPORTED_UPDATE_CHANNEL)
		expect(channel).toBe('latest')
		expect(updater.allowDowngrade).toBe(false)
	})

	it('migrates unsupported stored channels to stable', () => {
		expect(supportedUpdateChannel('beta')).toBe('latest')
		expect(supportedUpdateChannel('alpha')).toBe('latest')
	})
})
