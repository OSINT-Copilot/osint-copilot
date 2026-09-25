import { describe, it, expect } from 'vitest'
import { gpuSandboxWouldFail } from './gpu'

describe('gpuSandboxWouldFail', () => {
	it('is true where there is no render node, which is what a VM looks like', () => {
		// Measured in a Fedora 43 VM: a card, no renderD*, and the GPU process dies.
		expect(gpuSandboxWouldFail('linux', () => ['by-path', 'card0'])).toBe(true)
	})

	it('is false on a desktop that has one', () => {
		expect(gpuSandboxWouldFail('linux', () => ['by-path', 'card1', 'card2', 'renderD128', 'renderD129'])).toBe(false)
	})

	it('is true when /dev/dri does not exist at all', () => {
		expect(gpuSandboxWouldFail('linux', () => { throw new Error('ENOENT') })).toBe(true)
	})

	it('leaves other platforms alone', () => {
		expect(gpuSandboxWouldFail('win32', () => [])).toBe(false)
		expect(gpuSandboxWouldFail('darwin', () => [])).toBe(false)
	})
})
