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
 *   - lives in one in-memory partition kept for renders alone, emptied (storage, cache,
 *     host cache, sockets) before each render, so no render sees what another left;
 *   - cancels every request except the archive's own file:// URL and the cid: and data:
 *     URLs its parts are served under, so a stylesheet, font, image or meta refresh that
 *     names the target's server fetches nothing;
 *   - sends whatever still reaches the network stack without being a request to a proxy
 *     that is not there (see DEAD_PROXY_RULES): a <link rel=preconnect> opens no socket
 *     to the site, it would at most knock on a closed local port;
 *   - resolves no name. A <link rel=dns-prefetch> goes from Blink straight to the host
 *     resolver, past webRequest and the proxy, and Electron has no per-session switch
 *     for it (Blink's dnsPrefetchingEnabled setting is not exposed; the
 *     --dns-prefetch-disable switch is Chrome's, not Electron's). What keeps names out
 *     of DNS is that Blink sends no dns-prefetch for a document loaded from an MHTML
 *     archive (it still asks for preconnects, which the proxy answers). The integration
 *     test (tests-integration/capture-render.test.ts) searches Chromium's net log for
 *     the names an archive mentions, so a Chromium update that changes this fails there;
 *   - cannot navigate, be redirected or open a window, and is refused every permission.
 *
 * One partition, not one per render: Electron never frees an in-memory partition, so a
 * fresh one per capture is memory the app keeps until it quits. Renders therefore run
 * one at a time, which the reset between them needs anyway.
 *
 * Everything that waits has a timeout, the screenshot commands included: a page that
 * hangs the compositor must not hang the capture queue behind it.
 *
 * Electron-only; the deriver takes this as an injected function, so tests never load it.
 */
import * as nodePath from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { BrowserWindow, session as electronSession, type Session } from 'electron'

/** Wide enough to lay out a desktop site; height is replaced by the document's own. */
const RENDER_WIDTH = 1280
const RENDER_HEIGHT = 900

/** Beyond this the PNG is larger than the evidence it illustrates. */
export const MAX_RENDER_HEIGHT = 20000

/** A page that has not settled by now is not going to. */
const LOAD_TIMEOUT_MS = 15000
/** Each debugger command; a full-page screenshot of a tall page is the slow one. */
const COMMAND_TIMEOUT_MS = 20000
/**
 * Setting up and emptying the partition. Renders queue behind each other, so one that
 * waits forever here would leave every later capture without a screenshot until restart.
 */
const SESSION_TIMEOUT_MS = 15000

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

/** No 'persist:' prefix, so it lives in memory only; nothing else uses this name. */
export const RENDER_PARTITION = 'osint-render'

/**
 * Every scheme through a proxy on the discard port, where nothing listens.
 *
 * webRequest sees requests, but not everything that touches the network is one. A
 * <link rel=preconnect> asks the network stack for a bare socket (Electron itself only
 * reports it, as the session's 'preconnect' event, but that is Electron's choice today,
 * not a guarantee), and Chromium's own speculative connects never pass webRequest
 * either. With a fixed proxy, any such socket can only go to the proxy: a refused
 * connection to 127.0.0.1:9, never the site. `socks=` covers every scheme without an
 * entry of its own, and names SOCKS5 explicitly: a bare `socks=` host is SOCKS4, which
 * resolves the destination name locally once the proxy accepts, so it would be safe
 * only while the port stays closed.
 */
export const DEAD_PROXY_RULES = 'http=127.0.0.1:9;https=127.0.0.1:9;socks=socks5://127.0.0.1:9'
/**
 * Chromium bypasses the proxy for loopback addresses unless told not to, and a page may
 * name one (a local service of the investigated machine, or the extension's own port).
 * `<-loopback>` removes that implicit bypass; nothing is added in its place.
 */
export const DEAD_PROXY_BYPASS = '<-loopback>'

/** The archive the render in progress may load; null between renders, when all is refused. */
let allowedArchive: string | null = null
let renderSession: Promise<Session> | null = null
/** The partition's handlers, installed once: fromPartition hands a retried setup the same session. */
let handlersInstalled = false
let partitionsCreated = 0
let rendersStarted = 0
let renderQueue: Promise<unknown> = Promise.resolve()

/** How many partitions renders have used, and how many renders began. For tests. */
export function renderSessionStats(): { partitionsCreated: number, rendersStarted: number } {
	return { partitionsCreated, rendersStarted }
}

/** Creates and locks down the render partition. A setup that failed is run again whole. */
function configureRenderSession(): Promise<Session> {
	return (async () => {
		const session = electronSession.fromPartition(RENDER_PARTITION, { cache: false })
		if (!handlersInstalled) {
			handlersInstalled = true
			partitionsCreated++
			session.webRequest.onBeforeRequest((details, callback) => {
				callback({ cancel: allowedArchive === null || !isArchiveRequest(details.url, allowedArchive) })
			})
			session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
			session.setPermissionCheckHandler(() => false)
			session.on('will-download', (event) => event.preventDefault())
		}
		await withTimeout(
			session.setProxy({ mode: 'fixed_servers', proxyRules: DEAD_PROXY_RULES, proxyBypassRules: DEAD_PROXY_BYPASS }),
			SESSION_TIMEOUT_MS, 'setting the render proxy')
		return session
	})()
}

/**
 * The render partition, configured and emptied: storage (cookies, local storage, service
 * workers and the rest), the HTTP cache, the host cache and every open socket. The
 * archive is not a web page's own origin, but whatever the last one managed to store
 * must still not be what the next one sees.
 */
export async function acquireRenderSession(): Promise<Session> {
	if (!renderSession) {
		renderSession = configureRenderSession()
		// A failed setup is tried again by the next render rather than kept forever.
		renderSession.catch(() => { renderSession = null })
	}
	const session = await renderSession
	// Bounded as one step: a render that cannot get a clean partition fails, and the
	// next one empties it again from the start.
	await withTimeout((async () => {
		await session.clearStorageData()
		await session.clearCache()
		await session.clearHostResolverCache()
		await session.closeAllConnections()
	})(), SESSION_TIMEOUT_MS, 'emptying the render partition')
	return session
}

/**
 * Renders an MHTML archive off-screen and returns a full-page PNG. Renders queue behind
 * each other: they share one partition, which each empties first.
 *
 * Never throws: a screenshot is the least important thing a capture has, and losing the
 * archive because an image failed would be the wrong trade.
 */
export function renderArchive(archivePath: string): Promise<FullPageResult> {
	const run = renderQueue.then(() => renderOne(archivePath))
	renderQueue = run.catch(() => undefined)
	return run
}

async function renderOne(archivePath: string): Promise<FullPageResult> {
	let window: BrowserWindow | null = null
	rendersStarted++
	try {
		const archiveUrl = pathToFileURL(nodePath.resolve(archivePath)).href
		const session = await acquireRenderSession()
		allowedArchive = archivePath

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
		allowedArchive = null
		if (window && !window.isDestroyed()) window.destroy()
	}
}
