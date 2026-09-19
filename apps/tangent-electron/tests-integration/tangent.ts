import { test as base} from '@playwright/test'
import { _electron as electron } from 'playwright'

import fs from 'fs'
import path from 'path'
import TangentApp from './TangentApp'

// Using this here because playwright doesn't want to play nice with ESM imports 
export function wait(time: number = 0): Promise<void> {
	return new Promise((resolve, reject) => {
		setTimeout(resolve, time)
	})
}

export type TangentOptions = {
	workspaceInfoName: string
	workspace: string
	resetWorkspaceInfo: boolean
	// When true, will delete the entire workspace when finished
	// When a string, will delete tangents & workspaces with that prefix
	resetWorkspace: boolean | string
	// Added to the app's environment, and to its command line after the workspace, for
	// a test that needs a switch the others must not get (e.g. a throwaway userData).
	launchEnv: Record<string, string>
	launchArgs: string[]
}

type TangentFixtures = {
	tangent: TangentApp
}

/**
 * Marks the OSINT layer's first-run tour as already seen in this workspace. The tour is a
 * dialog that opens on a workspace's first launch and takes the keyboard, so a test's
 * first keystrokes (a new note, a link) would land in it instead of the editor.
 */
async function seenWelcomeGuide(workspace: string): Promise<void> {
	const dir = path.join(workspace, '.osint-copilot')
	const file = path.join(dir, 'data.json')
	let data: Record<string, unknown> = {}
	try {
		data = JSON.parse(await fs.promises.readFile(file, 'utf8'))
	}
	catch (e) {}
	if (data.hasSeenWelcomeGuide === true) return
	await fs.promises.mkdir(dir, { recursive: true })
	await fs.promises.writeFile(file, JSON.stringify({ ...data, hasSeenWelcomeGuide: true }, null, 2))
}

export const defaultWorkspace = path.resolve(path.join(
	__dirname, '../../IntegrationTestWorkspace'))

export const test = base.extend<TangentFixtures & TangentOptions>({

	workspaceInfoName: ['test_', { option: true }],
	workspace: [defaultWorkspace, { option: true }],
	resetWorkspaceInfo: [true, { option: true }],
	resetWorkspace: [true, { option: true }],
	launchEnv: [{}, { option: true }],
	launchArgs: [[], { option: true }],

	tangent: async ({
		workspaceInfoName,
		workspace,
		resetWorkspaceInfo,
		resetWorkspace,
		launchEnv,
		launchArgs
	}, use) => {
		// Set up the app

		if (workspace) {
			await fs.promises.mkdir(workspace, { recursive: true })
			await seenWelcomeGuide(workspace)
		}

		// Playwright REPLACES the environment when `env` is given rather than merging,
		// so passing only the two test variables left the child with no DISPLAY -- and on
		// Linux Electron then exits with "Missing X server or $DISPLAY" before any test
		// runs. CI never saw it because the e2e job runs on macOS.
		const childEnv: Record<string, string> = {}
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined) childEnv[key] = value
		}
		// ...and inheriting the environment means inheriting this, which silently turns
		// the Electron binary into plain Node, so no window ever opens. The README warns
		// developers not to export it; the harness should not depend on them reading it.
		delete childEnv.ELECTRON_RUN_AS_NODE

		// The packaged Linux app passes this too (electron-builder.json
		// `linux.executableArgs`): without it Electron's Wayland path segfaults the
		// moment a window opens, which the README documents for `npm run dev` as well.
		const platformArgs = process.platform === 'linux' ? ['--ozone-platform=x11'] : []

		const electronApp = await electron.launch({
			args: ['.', workspace, ...platformArgs, ...launchArgs],
			env: {
				...childEnv,
				// A development build without a licence shows the licence screen instead of
				// the workspace, so every test would be testing that screen. Only a
				// non-production build honours this; a test that is about licensing sets
				// its own environment in launchEnv.
				OSINT_SKIP_LICENSE: '1',
				...launchEnv,
				INTEGRATION_TEST: '1',
				WORKSPACE_NAME: workspaceInfoName
			}
		})

		const tangentApp = new TangentApp(electronApp, workspace)
		
		// Use the app in a test
		await use(tangentApp)

		const userDataPath = await electronApp.evaluate(async ({ app }) => {
			return app.getPath('userData')
		})

		const workspaceInfoPath = path.join(
			userDataPath,
			workspaceInfoName + 'workspaces.json')

		// Clean up test
		await tangentApp.close()

		await wait(500)

		if (resetWorkspace && workspace) {
			if (resetWorkspace === true) {
				await fs.promises.rm(workspace, { recursive: true })
			}
			else {
				try {
					const workspaceDir = path.join(workspace, '.tangent', 'workspaces')
					const workspaceFiles = await fs.promises.readdir(workspaceDir)
					for (const filename of workspaceFiles) {
						if (filename.startsWith(resetWorkspace)) {
							await fs.promises.rm(path.join(workspaceDir, filename))
						}
					}

					const tangentsDir = path.join(workspace, '.tangent', 'tangents')
					const tangentFiles = await fs.promises.readdir(tangentsDir)
					for (const filename of tangentFiles) {
						if (filename.startsWith(resetWorkspace)) {
							await fs.promises.rm(path.join(tangentsDir, filename), { recursive: true })
						}
					}
				}
				catch (e) {}
			}
		}

		if (resetWorkspaceInfo) {
			await fs.promises.rm(workspaceInfoPath)
		}
	}
})

export { expect } from '@playwright/test'
