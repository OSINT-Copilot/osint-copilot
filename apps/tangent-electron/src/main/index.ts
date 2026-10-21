import {
	app,
	BrowserWindow
} from 'electron'

import dotenv from 'dotenv'
dotenv.config()

import sourceMapSupport from 'source-map-support'
sourceMapSupport.install()

import fs from 'fs'
import path from 'path'

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import { mode } from './environment'
import { relaunchExecPath, x11RelaunchArgs } from './ozone'
import { gpuSandboxWouldFail } from './gpu'
import {
	getWorkspace,
	getWindowHandle,
	workspaceMap,
	getWorkspacesInfoPath, 
	saveAndCloseWorkspaces,
	findClosestWorkspace,
	hasStartedWorkspaceShutdown
} from './workspaces'

import Logger from 'js-logger'
import { setupLogging } from './logging'

import { loadSettings, saveSettings, getSettings} from './settings'
import { initDocumentation, openDocumentation, shouldShowChangelog } from './documentation'
import { initLicense } from './license'
import { createWindow, getOrCreateWindowForWorkspace } from './windows'

import './messages'
import './osint'
import { installTextmate } from '@such-n-such/tangent-query-parser'
import { getRegistry } from './grammarLoader'
import { INITIAL } from 'vscode-textmate'
import { initializeDebugging } from './debugging'
import { addShutDownTask, isReadyToShutDown, shutDown } from './shutdown'
import { userArguments } from './cli-args'

var isInitialized = false

/******************
 * Initialization *
 ******************/
function initializeApplication() {
	// Set up Logging
	setupLogging()
	if (mode === 'production') {
		Logger.setLevel(Logger.INFO)
	}
	else {
		Logger.setLevel(Logger.DEBUG)
	}

	Logger.info(`

******************************************************
******************************************************
OSINT Copilot ${app.getVersion()} Launched With Arguments:`, process.argv)

	initializeDebugging()

	let appReady = false
	let openOverride = undefined

	function openPathInTangent(targetPath) {
		if (typeof targetPath !== 'string') return
		targetPath = path.resolve(targetPath)
		if (!appReady) {
			Logger.info('Deferring opening until setup is complete', targetPath)
			openOverride = targetPath
			return
		}

		findClosestWorkspace(targetPath).then(workspacePath => {
			if (targetPath !== workspacePath) {
				Logger.info(`Opening "${targetPath}" in the context of "${workspacePath}"`)
			}
			else {
				Logger.info(`Opening "${targetPath}"`)
			}

			const window = getOrCreateWindowForWorkspace(workspacePath)
			if (targetPath !== workspacePath) {
				const handle = getWindowHandle(window)
				handle.whenReady().then(h => {
					h.navigateTo(targetPath)
				})
			}
		})
	}

	function processArgs(argv: string[]) {
		if (process.env.INTEGRATION_TEST) {
			argv = argv.slice(2)
		}
		else {
			argv = userArguments(argv, Boolean(process.defaultApp))
		}

		Logger.log('processed args', argv)

		yargs(argv)
		.command(['open [path]', '*'],
			'Opens the specified file or workspace, or opens previously open workspaces if nothing is specified',
			args => {},
			args => openPathInTangent(args.path))
		.parse()
	}

	processArgs(process.argv)

	// This method will be called when Electron has finished
	// initialization and is ready to create browser windows.
	// Some APIs can only be used after this event occurs.
	app.on('ready', onReady);

	// This is a mac-only event that is called when a folder or file is dragged to the app
	app.on('open-file', (event, path) => {
		event.preventDefault()
		openPathInTangent(path)
	})

	app.on('second-instance', (event, args) => {
		Logger.log('Captured arguments sent to a second instance: ', args)
		processArgs(args)
	})

	async function onReady() {
		const log = Logger.get('initialization')
		log.info('OSINT Copilot Initializing...')
		let hasOpenedWindows = false
		
		try {
			// Synchronous, and before the async group: the first window's renderer asks for
			// licence status as it boots, and an unregistered handler would reject.
			initLicense()

			await Promise.all([
				loadSettings(),
				initDocumentation(),
				installTextmate({ registry: getRegistry(), initialStack: INITIAL })
			])
		}
		catch (err) {
			log.error('CRITICAL INITIALIZATION ERROR. A major subcomponent of OSINT Copilot failed to initialize.')
			log.error(err)
		}
		
		try {
			const workspacesInfoPath = getWorkspacesInfoPath()
			log.info('  Loading workspace info from: ', workspacesInfoPath)

			let workspaces = null

			try {
				let data = await fs.promises.readFile(workspacesInfoPath, 'utf8')
				workspaces = JSON.parse(data)
				log.info('  Workspaces', workspaces)
			}
			catch {
				log.info('  No workspace info found')
				workspaces = {}
			}

			// Validate the known workspaces
			if (workspaces.knownWorkspaces) {
				let results: string[] = await Promise.all(workspaces.knownWorkspaces.map(async (workspacePath:string) => {
					try {
						let stats = await fs.promises.stat(workspacePath)
						if (stats && stats.isDirectory()) {
							return workspacePath
						}
					}
					catch (err) {
						// The workspace doesn't exist
						log.warn('  A workspace could not be found and will be dropped: ', workspacePath)
					}
					
					return null
				}))

				for (let workspacePath of results) {
					if (workspacePath) {
						workspaceMap.set(workspacePath, null)
					}
				}
			}

			appReady = true

			if (openOverride) {
				openPathInTangent(openOverride)
				hasOpenedWindows = true
			}
			else if (getSettings().startupBehavior.value == 'restore' && workspaces.openWorkspaces) {
				for (let workspacePath of workspaces.openWorkspaces) {
					if (workspaceMap.get(workspacePath) !== undefined) {
						// A null (or non null) value means this workspace was previously validated
						// Start the process of loading the workspace
						getWorkspace(workspacePath)

						// Create the window with the assigned workspace
						createWindow(workspacePath)
						hasOpenedWindows = true
					}
				}
			}
			
		}
		catch (err) {
			log.error('Could not load workspace data')
			log.error(err)
			// No existing workspace area
		}

		if (!hasOpenedWindows) {
			// No windows were opened, so let's open a new one
			createWindow()
		}

		shouldShowChangelog().then(async show => {
			if (show && getSettings().showChangelogOnUpdate.value) {
				await Promise.allSettled(BrowserWindow.getAllWindows().map(w => {
					return getWindowHandle(w)?.whenReady()
				}))
				
				const focusedWindow = getWindowHandle(BrowserWindow.getFocusedWindow())
				if (focusedWindow) {
					focusedWindow.invokeCommand('openChangelog')
				}
			}
		})
	}

	/**
	 * Application Event Handlers
	 */
	// Quit when all windows are closed, except on macOS. There, it's common
	// for applications and their menu bar to stay active until the user quits
	// explicitly with Cmd + Q.
	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') {
			app.quit();
		}
	});

	app.on('activate', () => {
		// On OS X it's common to re-create a window in the app when the
		// dock icon is clicked and there are no other windows open.
		// This can happen before initialization is complete and windows can be created,
		// so check against that.
		if (isInitialized && BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});

	// Application is attempting to quite, but windows haven't been closed yet.
	app.on('before-quit', () => {
		if (!hasStartedWorkspaceShutdown()) {
			// This ensures open workspaces are retained
			addShutDownTask(saveAndCloseWorkspaces())
		}
	})

	// Windows have all been closed and the application is attempting to exit
	app.on('will-quit', (event) => {
		if (!isReadyToShutDown()) {
			event.preventDefault()
		}
		shutDown()
	})

	isInitialized = true
}

// A machine with no DRM render node cannot start the GPU process under its sandbox, and
// Chromium aborts the whole application rather than carry on. Unlike the display backend, this
// switch is read when the GPU process launches, which is long after this line runs.
if (gpuSandboxWouldFail(process.platform)) {
	Logger.get('gpu').info('No DRM render node; starting the GPU process without its sandbox')
	app.commandLine.appendSwitch('disable-gpu-sandbox')
}

let shouldInit = true

// Only for a build that is run from source. A packaged Linux build goes through the launcher
// from build/after-pack.js, which picks the backend before Chromium starts; re-execing here as
// well would detach a child whose output goes nowhere, which is how a failure to start turned
// into a silent exit with no window and no message.
const ozoneRelaunch = app.isPackaged
	? null
	: x11RelaunchArgs(process.platform, process.env, process.argv)
if (ozoneRelaunch) {
	Logger.get('ozone').info('Relaunching with the X11 backend: Electron cannot build its UI on this Wayland session')
	app.relaunch({ execPath: relaunchExecPath(process.env, process.execPath), args: ozoneRelaunch })
	app.exit(0)
	shouldInit = false
}

if (shouldInit && mode === 'production') {
	const hasLock = app.requestSingleInstanceLock()
	if (!hasLock) {
		app.quit()
		shouldInit = false
	}
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) { // eslint-disable-line global-require
	app.quit()
	shouldInit = false
}

if (process.env.PORTABLE_EXECUTABLE_DIR) {
	// user data should be stored relative to the exe
	const userDataPath = path.join(process.env.PORTABLE_EXECUTABLE_DIR, '.tangent_config')
	fs.mkdirSync(userDataPath, { recursive: true })
	app.setPath('userData', userDataPath)

	// Redirect chromium session data back to its default location
	app.setPath('sessionData', app.getPath('appData'))
}

if (shouldInit) initializeApplication()

