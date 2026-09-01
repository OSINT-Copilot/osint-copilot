import type { TreeChange } from 'common/trees'
import type { IndexData } from 'common/indexing/indexTypes'
import type { WorkspaceInitState } from 'common/workspaceState'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import type { ContextMenuTemplate } from './menus'
import type { QueryResult } from './indexing/queryResults'
import type { QueryParseResult } from '@such-n-such/tangent-query-parser'
import type { UrlData } from './urlData'
import type {
	ExecOptions, ExecResult, HttpRequest, HttpResponse, PlatformInfo, SecretRef
} from '../osint/host/types'

export interface SelectPathOptions {
	title?: string
	message?: string
	initialPath?: string
	mode?: 'file' | 'folder' | 'path'
	fileTypes?: string | string[] | RegExp
	allowExternal?: string
	selectMultiple?: boolean
}

export interface UserMessage {
	type: string
	title?: string
	message: string
}

type SelectPathResult<T extends SelectPathOptions> = T extends { selectMultiple: true } ? string[] : string

export default interface WindowAPI {
	getWorkspace(workspacePath?: string): Promise<WorkspaceInitState>
	getKnownWorkspaces(): Promise<string[]>
	forgetWorkspace(path: string)

	getWorkspaceDialog(): Promise<string>

	sendWorkspaceStatePatch(patch)
	onWorkspaceStatePatch(handler: (patch) => void)

	sendWorkspaceViewPatch(patch)
	onWorkspaceViewPatch(handler: (patch) => void)
	setWorkspaceViewState(state)

	onWorkspaceAction(handler: (actionName: string) => void)

	// Messages
	postMessage(message: UserMessage)
	onMessage(handler: (message: UserMessage) => void)

	window: {
		close()
		toggleMaximize()
		minimize()
		create()
		isAlwaysOnTop(): Promise<boolean>
		setAlwaysOnTop(value: boolean)
		isFullscreen(): Promise<boolean>
		setFullscreen(value: boolean)
		setSize(size: { width: number, height: number }): Promise<void>
	}

	system: {
		getAllFonts(): Promise<string[]>
		getAllLanguages(): Promise<string[]>
		saveImageFromClipboard(contextPath: string): Promise<string>
		copyImageToClipboard(path: string): Promise<void>
		updateImageFromClipboard(path: string): Promise<void>
		messageDialog(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue>
	}

	menus: {
		/** Called when a window is created or comes into focus. The window should do whatever it needs to ensure the menus are in the right state. */
		onRequestAllMenus(handler: () => void)
		/** Called when a command has been invoked from the system-level menus. */
		onMenuCommand(handler: (commandId: string) => void)
		/** Call with a compatible menu template to set the menu for the window. */
		setMainMenu(content: any)
		/** Call to update the checked/enabled status of any commands in the system menu. */
		updateCommandState(content: { [key: string]: { [key: string]: any }})
		/** Displays a context menu at the current cursor position based on the supplied template. */
		showContextMenu(template: ContextMenuTemplate)
	}

	file: {
		selectPath<T extends SelectPathOptions>(options: T): Promise<SelectPathResult<T>>
		onTreeChange(handler: (change: TreeChange) => void)

		createFile(path: string, options?: IndexData): Promise<void>
		createFolder(path: string): Promise<void>
		move(filepath: string, newPath: string): Promise<void>
		copy(filepath: string, newPath?: string): Promise<void>
		delete(filepath: string): Promise<void>
		
		/** Gets the contents of a file, but does not mark it as opened */
		getFileContents(filepath): Promise<string>
		/** Open a file and receive any changes via `onReceiveFileContents` */
		openFile(filepath: string)
		/** Add a handler to this to receive contents when an open file is loaded or changes. */
		onReceiveFileContents(handler: (path: string , content: string | unknown) => void)
		/** No longer watcha a file for changes. */
		closeFile(filepath: string) // Stop receiving file changes
		
		/** Update a file with new contents. */
		updateFile(filepath: string, content: string | unknown)
		/** Show the file or folder in the native file browser. */
		showInFileBrowser(path: string)
		/** Open a path in the default format */
		openPath(path: string)
	}

	edit: {
		nativeAction(action: 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll' | 'undo' | 'redo')
	}

	links: {
		/** Open a url in the default format */
		openExternal(path: string)
		getTitle(href: string): Promise<string>
		saveFromUrl(href: string, contextPath: string): Promise<string>
		getUrlData(url: string): Promise<UrlData>
	}

	query: {
		resultsForQuery(queryString: string): Promise<QueryResult>
		parseQuery(queryString: string): Promise<QueryParseResult>
	}

	settings: {
		/** Applies a patch to the system settings */
		patch(patch: any)
	}

	theme: {
		getCodeThemes(): Promise<string[]>
		getCodeTheme(name: string): Promise<{ block: string, tokens: string }>
	}

	documentation: {
		open(name: string)
		get(name: string)
		getChangelogs(): Promise<string[]>
		getRecentChanges(): Promise<string[]>
	}

	dictionary: {
		getAllWords(): Promise<string[]>,
		removeWord(string)
	}

	update: UpdateAPI

	/**
	 * OSINT Copilot's additions. Only capabilities Tangent does not already have: file
	 * I/O goes through `file` above, not here.
	 *
	 * Note what is absent: there is no way to read a secret. `net.request` takes a
	 * reference to one and main resolves and injects it, so a secret value never
	 * crosses into the renderer.
	 */
	osint: {
		/** Synchronous snapshot, fetched once in preload. Read at seven sites. */
		platform(): PlatformInfo

		secrets: {
			has(ref: SecretRef): Promise<boolean>
			setKeychain(name: string, value: string): Promise<void>
			deleteKeychain(name: string): Promise<void>
			listKeychain(): Promise<string[]>
		}

		cli: {
			resolve(configured: string | undefined, fallbackBareName: string, extraCandidates?: string[], probeTimeoutMs?: number): Promise<string>
			/** `execId` is caller-supplied so an AbortSignal can kill a pending exec. */
			exec(execId: string, binary: string, args: string[], options?: ExecOptions): Promise<ExecResult>
			kill(execId: string): void
		}

		net: {
			request(request: HttpRequest): Promise<HttpResponse>
		}

		extract: {
			pdfText(data: ArrayBuffer): Promise<string>
			docxText(data: ArrayBuffer): Promise<string>
		}
	}
}

export interface UpdateAPI {
	onChecking(handler: () => void)
	onAvailable(handler: (info: UpdateInfo) => void)
	onNotAvailable(handler: () => void)
	onProgress(handler: (progress: ProgressInfo) => void)
	onReady(handler: (info: UpdateInfo) => void)
	onError(handler: (message: string, stack: string) => void)

	checkForUpdate()
	update()
}
