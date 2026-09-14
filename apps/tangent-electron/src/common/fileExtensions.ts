import { queryFileType } from './dataTypes/QueryInfo'

export function getExtensionRegex(extensions: string[]) {
	let matchString = '\\.('
	for (let i = 0; i < extensions.length; i++){
		const extension = extensions[i]
		const extensionName = extension.startsWith('.') ? extension.substring(1) : extension
		if (i > 0) {
			matchString += '|'
		}
		matchString += `${extensionName}`
	}

	matchString += ')$'

	return new RegExp(matchString, 'i')
}

export function getFileTypeRegex(fileTypes: string[]) {
	let matchString = '('
	for (let i = 0; i < fileTypes.length; i++){
		const fileType = fileTypes[i]
		const fileTypeMatch = fileType.startsWith('.') ? '\\' + fileType : fileType
		if (i > 0) {
			matchString += '|'
		}
		matchString += `${fileTypeMatch}`
	}

	matchString += ')$'

	return new RegExp(matchString, 'i')
}

export const noteFileExtensions = [
	'.md', '.mdx'
]
export const noteExtensionMatch = getExtensionRegex(noteFileExtensions)

export const imageFileExtensions = [
	'.png',
	'.jpeg',
	'.jpg',
	'.gif',
	'.bmp',
	'.svg',
	'.webp'
]
export const imageExtensionMatch = getExtensionRegex(imageFileExtensions)

export const audioFileExtensions = [
	'.mp3',
	'.m4a',
	'.wav',
	'.ogg',
	'.flac'
]
export const audioExtensionMatch = getExtensionRegex(audioFileExtensions)

export const videoFileExtensions = [
	'.mov',
	'.mp4',
	'.mkv',
	'.avi',
	'.webm'
]
export const videoExtensionMatch = getExtensionRegex(videoFileExtensions)

export const pdfFileExtensions = ['.pdf']
export const pdfExtensionMatch = getExtensionRegex(pdfFileExtensions)

export const styleFileExtensions = ['.css']
export const styleExtensionMatch = getExtensionRegex(styleFileExtensions)

// TODO: Criminally incomplete
export const codeExtensions = [
	'.js', '.jsx', '.ts', '.tsx',
	'.h', '.cpp',
	'.cs', '.py', '.java',
	'.rs',

	'.json', '.html', '.css'
]

// Split this off to other places when appropriate
export const mscExtensions = [
	'.txt', '.csv',
	'.json'
]

export const knownExtensions = [
	...noteFileExtensions,
	...imageFileExtensions,
	...audioFileExtensions,
	...videoFileExtensions,
	...pdfFileExtensions,
	...codeExtensions,
	...mscExtensions,
	// So [[Board.canvas]] resolves to the board rather than having '.md' appended and
	// creating a virtual note. Same literal-string constraint as visibleFileTypeMatch.
	'.canvas',
	// Browsing panes, for the same reason.
	'.osintbrowse'
]

export const knownExtensionsMatch = getExtensionRegex(knownExtensions)

/**
 * These are the file types that users can interact with
 */
export const visibleFileTypeMatch = getFileTypeRegex([
	...noteFileExtensions, ...imageFileExtensions,
	...audioFileExtensions, ...videoFileExtensions,
	...pdfFileExtensions,
	queryFileType, 'folder', 'tag',
	// OSINT Copilot's view files, so they appear in the file tree and quick-open.
	// Spelled out rather than imported: common/ is shared with the main process, whose
	// tsconfig cannot resolve `osint/*`. osint-view-types.test.ts asserts the two lists
	// stay in step.
	'.osintchat', '.osintgraph', '.osinttimeline', '.osintmap', '.osintregistry',
	'.osintdocs',
	// Canvas boards. Obsidian's extension, deliberately: the same file opens in either app.
	'.canvas',
	// Browsing panes. A document rather than a view, so it is not in OSINT_VIEWS.
	'.osintbrowse'
])

/**
 * These are extensions that do not need to be shown
 */
export const implicitExtensionsMatch = getExtensionRegex([
	'.md', queryFileType
])
