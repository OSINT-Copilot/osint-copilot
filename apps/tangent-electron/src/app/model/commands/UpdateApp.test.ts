import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WritableStore } from 'common/stores'
import type Workspace from '../Workspace'
import { UpdateAppCommand } from './UpdateApp'

function fixture(isPortable: boolean) {
	const state = {
		mode: new WritableStore<'idle' | 'available' | 'ready'>('idle'),
		nextUpdate: new WritableStore<any>(null),
		isPortable,
		checkForUpdate: vi.fn(),
		updateNow: vi.fn(),
		openManualDownload: vi.fn(),
	}
	const workspace = { updateState: state, version: '0.14.8' } as unknown as Workspace
	return { state, command: new UpdateAppCommand(workspace) }
}

describe('UpdateAppCommand', () => {
	beforeEach(() => {
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			callback(0)
			return 1
		})
	})

	it('sends portable users to the manual download instead of installing', () => {
		const { state, command } = fixture(true)
		state.nextUpdate.set({ version: '0.14.8' })
		state.mode.set('available')

		expect(command.canExecute()).toBe(true)
		expect(command.getLabel()).toBe('Download 0.14.8 Manually')
		command.execute()

		expect(state.openManualDownload).toHaveBeenCalledOnce()
		expect(state.checkForUpdate).not.toHaveBeenCalled()
		expect(state.updateNow).not.toHaveBeenCalled()
	})

	it('does not make the transient available state clickable for installed builds', () => {
		const { state, command } = fixture(false)
		state.mode.set('available')

		expect(command.canExecute()).toBe(false)
		expect(command.getLabel()).toBe('Downloading Update…')
	})

	it('installs only after the updater reports that the download is ready', () => {
		const { state, command } = fixture(false)
		state.mode.set('ready')
		command.execute()

		expect(state.updateNow).toHaveBeenCalledOnce()
		expect(state.checkForUpdate).not.toHaveBeenCalled()
	})
})
