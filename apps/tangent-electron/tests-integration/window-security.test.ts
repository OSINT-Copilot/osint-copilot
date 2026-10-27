import { test, expect } from './tangent'

/**
 * The application window's sandbox, pinned.
 *
 * These are not stylistic preferences. `src/main/windows.ts` passes only `preload` in
 * `webPreferences`, so sandbox, context isolation and the absence of node integration
 * are all Electron defaults -- which means nothing in the repo currently states that the
 * app depends on them, and nothing would fail if someone added `sandbox: false` while
 * debugging.
 *
 * The renderer depends on them: it displays LLM output, enricher output and rendered
 * markdown from hostile sources.
 *
 * Asserted through their observable effects rather than by reading the preferences back:
 * Electron 42 has no API that returns them.
 */
test('the application window runs sandboxed, isolated, and without node integration', async ({ tangent }) => {
	const window = await tangent.firstWindow()

	const observed = await window.page.evaluate(() => ({
		// nodeIntegration: false -- the page cannot pull in Node builtins.
		hasRequire: typeof (globalThis as any).require !== 'undefined',
		hasModule: typeof (globalThis as any).module !== 'undefined',
		// sandbox + contextIsolation -- the page shares no globals with the preload.
		hasProcess: typeof (globalThis as any).process !== 'undefined',
		hasBuffer: typeof (globalThis as any).Buffer !== 'undefined',
		// ...and the bridge is still the only way across, so the app still works.
		hasBridge: typeof (globalThis as any).api === 'object' && (globalThis as any).api !== null,
	}))

	expect(observed).toEqual({
		hasRequire: false,
		hasModule: false,
		hasProcess: false,
		hasBuffer: false,
		hasBridge: true,
	})
})

/**
 * The bridge hands out capabilities, never credentials. `WindowApi.ts` says so in a
 * comment and `main/osint/index.ts` says so again ("Deliberately no 'osint:secrets.get'");
 * this is the version that fails a build.
 */
test('the preload bridge exposes no way to read a secret or a licence key', async ({ tangent }) => {
	const window = await tangent.firstWindow()

	const reachable = await window.page.evaluate(() => {
		const names: string[] = []
		const walk = (value: any, path: string, depth: number) => {
			if (depth > 3 || value == null) return
			for (const key of Object.keys(value)) {
				const child = value[key]
				const here = path ? `${path}.${key}` : key
				names.push(here)
				if (typeof child === 'object') walk(child, here, depth + 1)
			}
		}
		walk((globalThis as any).api, '', 0)
		return names
	})

	// A getter for a secret value, by any of the names one would give it.
	expect(reachable.filter(n => /secrets?\.(get|read|value|reveal)/i.test(n))).toEqual([])
	expect(reachable.filter(n => /license\.(key|get)$/i.test(n))).toEqual([])
	// The capability that resolves secrets in main is still there, though.
	expect(reachable).toContain('osint.net.request')
})

/**
 * The sender guard sits in front of every `osint:*` channel, including the one sync one.
 *
 * `osint:platform` is delivered with sendSync from the preload at module scope, before
 * the page exists -- the earliest message the app sends. If the guard refused it, the
 * OSINT layer would come up with no platform information and the failure would be quiet,
 * so this asserts the guard admits the app's own first message rather than only that it
 * refuses other people's.
 */
test('the guard admits the preload\'s own startup message', async ({ tangent }) => {
	const window = await tangent.firstWindow()

	const platform = await window.page.evaluate(() => (globalThis as any).api?.osint?.platform?.())

	expect(platform, 'osint:platform was refused or never answered').toBeTruthy()
	expect(platform.os).toBeTruthy()
	expect(platform.pathSep).toBeTruthy()
	expect(typeof platform.homedir).toBe('string')
})
