import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// after-pack is Electron Builder's CommonJS hook. Exporting the generator lets this test
// exercise the exact shell script shipped in the AppImage rather than a second model of it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { launcher } = require('../../build/after-pack.js') as {
	launcher(name: string, version: string): string
}

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('AppImage sandbox launcher', () => {
	it('carries an approved sandbox helper into an updated unpacked app', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-appimage-'))
		roots.push(root)
		const mounted = path.join(root, 'mounted')
		const cache = path.join(root, 'cache')
		const app = path.join(cache, 'osint-copilot', 'app')
		fs.mkdirSync(mounted, { recursive: true })
		fs.mkdirSync(app, { recursive: true })

		const executable = 'osint-copilot'
		const marker = path.join(root, 'started-version')
		fs.writeFileSync(path.join(mounted, executable), launcher(executable, '2.0.0'), { mode: 0o755 })
		fs.writeFileSync(path.join(mounted, `${executable}.bin`),
			`#!/bin/sh\nprintf '%s' '2.0.0' > "${marker}"\n`, { mode: 0o755 })
		fs.writeFileSync(path.join(mounted, 'chrome-sandbox'), 'approved helper', { mode: 0o755 })

		fs.writeFileSync(path.join(app, `${executable}.bin`), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
		fs.writeFileSync(path.join(app, '.version'), '1.0.0')
		const helper = path.join(app, 'chrome-sandbox')
		fs.writeFileSync(helper, 'approved helper', { mode: 0o4755 })
		fs.chmodSync(helper, 0o4755)

		const denied = path.join(root, 'userns-denied')
		fs.writeFileSync(denied, '1')
		execFileSync(path.join(mounted, executable), [], {
			env: {
				...process.env,
				APPIMAGE: path.join(root, 'OSINT-Copilot.AppImage'),
				XDG_CACHE_HOME: cache,
				OC_USERNS_SWITCH: denied,
				OC_USERNS_LEGACY_SWITCH: path.join(root, 'missing-legacy-switch'),
				OC_SANDBOX_OWNER_UID: String(process.getuid?.() ?? 0),
			},
		})

		expect(fs.readFileSync(path.join(app, '.version'), 'utf8')).toBe('2.0.0')
		expect(fs.readFileSync(helper, 'utf8')).toBe('approved helper')
		expect(fs.statSync(helper).mode & 0o7777).toBe(0o4755)
		expect(fs.readFileSync(marker, 'utf8')).toBe('2.0.0')
	})

	it('does not reuse a helper whose bytes changed with the Electron update', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-appimage-'))
		roots.push(root)
		const mounted = path.join(root, 'mounted')
		const cache = path.join(root, 'cache')
		const app = path.join(cache, 'osint-copilot', 'app')
		fs.mkdirSync(mounted, { recursive: true })
		fs.mkdirSync(app, { recursive: true })

		const executable = 'osint-copilot'
		fs.writeFileSync(path.join(mounted, executable), launcher(executable, '2.0.0'), { mode: 0o755 })
		fs.writeFileSync(path.join(mounted, `${executable}.bin`), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
		fs.writeFileSync(path.join(mounted, 'chrome-sandbox'), 'new helper', { mode: 0o755 })

		fs.writeFileSync(path.join(app, `${executable}.bin`), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
		fs.writeFileSync(path.join(app, '.version'), '1.0.0')
		const helper = path.join(app, 'chrome-sandbox')
		fs.writeFileSync(helper, 'old helper', { mode: 0o4755 })
		fs.chmodSync(helper, 0o4755)

		const denied = path.join(root, 'userns-denied')
		fs.writeFileSync(denied, '1')
		expect(() => execFileSync(path.join(mounted, executable), [], {
			env: {
				...process.env,
				APPIMAGE: path.join(root, 'OSINT-Copilot.AppImage'),
				XDG_CACHE_HOME: cache,
				OC_USERNS_SWITCH: denied,
				OC_USERNS_LEGACY_SWITCH: path.join(root, 'missing-legacy-switch'),
				OC_SANDBOX_OWNER_UID: String(process.getuid?.() ?? 0),
			},
			stdio: 'pipe',
		})).toThrow()

		expect(fs.readFileSync(helper, 'utf8')).toBe('new helper')
		expect(fs.statSync(helper).mode & 0o7777).toBe(0o755)
	})
})
