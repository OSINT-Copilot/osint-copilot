import { describe, test, expect } from 'vitest'

import Settings from './Settings'
import Setting from './Setting'

describe('Setting serialization', () => {
	test('Setting does not send files for changes', () => {
		const setting = new Setting({
			defaultValue: 'foo'
		})

		expect(setting.value).toEqual('foo')
		expect(setting.getRawValues('file')).toBeUndefined()
	})

	test('Settings do not store default values', () => {
		const settings = new Settings()
		const raw = settings.getRawValues('file') as any
		expect(raw?.updateChannel).toBeUndefined
	})

	test('unsupported legacy update channels migrate to Stable', () => {
		const settings = new Settings()
		settings.applyPatch({ updateChannel: 'beta' })

		expect(settings.updateChannel.value).toBe('latest')
		expect(settings.updateChannel.validValues?.map(value =>
			typeof value === 'object' ? value.value : value)).toEqual(['latest'])
	})
})
