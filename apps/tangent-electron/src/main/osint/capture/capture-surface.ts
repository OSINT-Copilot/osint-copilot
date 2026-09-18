/**
 * Full-page screenshots, rendered from the archive rather than from the live page.
 *
 * It renders the MHTML the extension sent, never the URL: loading the URL again would be a
 * second request to a site under investigation, from the operator's identity, and would
 * screenshot a different page from the one that was hashed. The archive is the same bytes
 * the sha256 covers, so the image and the hash describe one instant.
 *
 * Loading an archive back is itself a hazard, and the archive here came over the loopback
 * channel from a page the analyst does not trust. So the window:
 *
 *   - has JavaScript off (MHTML holds the post-JavaScript DOM, so nothing is lost), is
 *     sandboxed, and has no node, no webview and no preload;
 *   - lives in a throwaway in-memory partition that has never held a cookie;
 *   - cancels every request except the archive's own file:// URL and the cid: and data:
 *     URLs its parts are served under, so a stylesheet, font, image or meta refresh that
 *     names the target's server fetches nothing;
 *   - cannot navigate, be redirected or open a window, and is refused every permission.
 *
 * Everything that waits has a timeout, the screenshot commands included: a page that
 * hangs the compositor must not hang the capture queue behind it.
 *
 * Electron-only; the deriver takes this as an injected function, so tests never load it.
 */
import { randomUUID } from 'crypto'
import * as nodePath from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { BrowserWindow, session as electronSession } from 'electron'

/** Wide enough to lay out a desktop site; height is replaced by the document's own. */
const RENDER_WIDTH = 1280
const RENDER_HEIGHT = 900

/** Beyond this the PNG is larger than the evidence it illustrates. */
export const MAX_RENDER_HEIGHT = 20000

/** A page that has not settled by now is not going to. */
const LOAD_TIMEOUT_MS = 15000
/** Each debugger command; a full-page screenshot of a tall page is the slow one. */
const COMMAND_TIMEOUT_MS = 20000

export interface FullPageResult {
	png?: Buffer
	reason?: string
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
		}),
	]).finally(() => clearTimeout(timer))
}

/**
 * Whether the render window may load `url`: the archive itself, and its own parts. The
 * archive is compared as a path, not as text, because Chromium re-escapes a file URL its
 * own way; any other file, any http(s), ws, blob or custom scheme is refused.
 */
export function isArchiveRequest(url: string, archivePath: string): boolean {
	const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase()
	if (scheme === 'cid:' || scheme === 'data:') return true
	if (scheme !== 'file:') return false
	try {
		const parsed = new URL(url)
		if (parsed.search || (parsed.host && parsed.host !== 'localhost')) return false
		return nodePath.resolve(fileURLToPath(parsed)) === nodePath.resolve(archivePath)
	}
	catch {
		return false
	}
}

/**
 * Renders an MHTML archive off-screen and returns a full-page PNG.
 *
 * Never throws: a screenshot is the least important thing a capture has, and losing the
 * archive because an image failed would be the wrong trade.
 */
export async function renderArchive(archivePath: string): Promise<FullPageResult> {
	let window: BrowserWindow | null = null
	try {
		const archiveUrl = pathToFileURL(nodePath.resolve(archivePath)).href
		// Never persisted ('persist:' is absent), never shared, never held a cookie.
		const session = electronSession.fromPartition(`osint-render-${randomUUID()}`, { cache: false })
		session.webRequest.onBeforeRequest((details, callback) => {
			callback({ cancel: !isArchiveRequest(details.url, archivePath) })
		})
		session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
		session.setPermissionCheckHandler(() => false)

		window = new BrowserWindow({
			show: false,
			width: RENDER_WIDTH,
			height: RENDER_HEIGHT,
			webPreferences: {
				session,
				// MHTML holds the post-JavaScript DOM, so this loses nothing and makes the
				// render deterministic.
				javascript: false,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				nodeIntegrationInSubFrames: false,
				webSecurity: true,
				webviewTag: false,
				plugins: false,
				spellcheck: false,
				offscreen: false,
			},
		})

		const contents = window.webContents
		contents.setWindowOpenHandler(() => ({ action: 'deny' }))
		contents.on('will-navigate', event => event.preventDefault())
		contents.on('will-redirect', event => event.preventDefault())

		const loaded = new Promise<void>((resolve, reject) => {
			contents.once('did-finish-load', () => resolve())
			contents.once('did-fail-load', (_e, code, description) =>
				reject(new Error(`could not load the archive (${code}: ${description})`)))
		})
		// loadURL resolves or rejects with the load; both are bounded.
		await withTimeout(Promise.all([contents.loadURL(archiveUrl), loaded]), LOAD_TIMEOUT_MS, 'loading the archive')

		const command = <T>(method: string, params?: object) =>
			withTimeout(contents.debugger.sendCommand(method, params) as Promise<T>, COMMAND_TIMEOUT_MS, method)

		contents.debugger.attach('1.3')
		try {
			// Only Page and Emulation: nothing here needs Runtime.
			const metrics = await command<{
				cssContentSize?: { width: number, height: number }
				contentSize?: { width: number, height: number }
			}>('Page.getLayoutMetrics')
			const content = metrics.cssContentSize ?? metrics.contentSize
			const height = Math.min(Math.ceil(content?.height || RENDER_HEIGHT), MAX_RENDER_HEIGHT)
			const width = Math.min(Math.ceil(content?.width || RENDER_WIDTH), RENDER_WIDTH * 4)

			await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
			const shot = await command<{ data: string }>('Page.captureScreenshot', {
				format: 'png',
				captureBeyondViewport: true,
			})
			return { png: Buffer.from(shot.data, 'base64') }
		}
		finally {
			if (contents.debugger.isAttached()) contents.debugger.detach()
		}
	}
	catch (e) {
		return { reason: String((e as Error)?.message ?? e) }
	}
	finally {
		if (window && !window.isDestroyed()) window.destroy()
	}
}
