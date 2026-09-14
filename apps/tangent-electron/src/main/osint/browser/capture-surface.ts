/**
 * Full-page screenshots, rendered from the archive rather than from the live page.
 *
 * Two constraints shape this, and together they rule out the obvious implementations.
 *
 * It cannot run on the analyst's own pane. A full-page capture needs
 * `Emulation.setDeviceMetricsOverride` to make the viewport as tall as the document, and
 * that REFLOWS the page they are reading -- the window visibly jumps, mid-investigation,
 * as a side effect of archiving.
 *
 * And it must not re-fetch. Loading the URL again in a hidden window would be a second
 * request to a site under investigation, from the operator's identity, minutes after the
 * first -- and it would screenshot a DIFFERENT page from the one that was hashed, which
 * quietly breaks the one-moment-one-hash property the whole capture path is built on.
 *
 * So it renders the MHTML that was just written. That is the same bytes the sha256 covers,
 * so the image and the hash describe one instant.
 *
 * Loading an archive back is itself a hazard: an archived page's scripts, run again, could
 * read whatever session they are loaded into. Two things stop that here -- JavaScript is
 * off entirely, and the window uses a throwaway in-memory partition that has never held a
 * cookie. Disabling scripts costs nothing, because MHTML serialises the POST-JavaScript
 * DOM: what the analyst saw is already in the file.
 */
import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import Logger from 'js-logger'

/** Wide enough to lay out a desktop site; height is replaced by the document's own. */
const RENDER_WIDTH = 1280
const RENDER_HEIGHT = 900

/** Beyond this the PNG is larger than the evidence it illustrates. */
const MAX_RENDER_HEIGHT = 20000

/** A page that has not settled by now is not going to. */
const LOAD_TIMEOUT_MS = 15000

export interface FullPageResult {
	png?: Buffer
	reason?: string
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
	])
}

/**
 * Renders an MHTML archive off-screen and returns a full-page PNG.
 *
 * Never throws: a screenshot is the least important of the three things a capture writes,
 * and losing the archive because an image failed would be the wrong trade.
 */
export async function renderArchive(archivePath: string): Promise<FullPageResult> {
	let window: BrowserWindow | null = null
	try {
		window = new BrowserWindow({
			show: false,
			width: RENDER_WIDTH,
			height: RENDER_HEIGHT,
			webPreferences: {
				// Never persisted, never shared, and it has never held a cookie: an archived
				// page's scripts would have nothing to read even if they ran.
				partition: `osint-render-${randomUUID()}`,
				// ...and they do not run. MHTML holds the post-JavaScript DOM, so this loses
				// nothing and makes the render deterministic.
				javascript: false,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				webSecurity: true,
				webviewTag: false,
				offscreen: false,
			},
		})

		const contents = window.webContents
		const loaded = new Promise<void>((resolve, reject) => {
			contents.once('did-finish-load', () => resolve())
			contents.once('did-fail-load', (_e, code, description) =>
				reject(new Error(`could not load the archive (${code}: ${description})`)))
		})

		await contents.loadFile(archivePath)
		await withTimeout(loaded, LOAD_TIMEOUT_MS, 'rendering the archive')

		contents.debugger.attach('1.3')
		try {
			// Only Page and Emulation, deliberately: Runtime.enable is what sophisticated
			// anti-bot systems watch for, and nothing here needs it.
			const metrics = await contents.debugger.sendCommand('Page.getLayoutMetrics') as {
				cssContentSize?: { width: number, height: number }
				contentSize?: { width: number, height: number }
			}
			const content = metrics.cssContentSize ?? metrics.contentSize
			const height = Math.min(Math.ceil(content?.height || RENDER_HEIGHT), MAX_RENDER_HEIGHT)
			const width = Math.ceil(content?.width || RENDER_WIDTH)

			await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
				width, height, deviceScaleFactor: 1, mobile: false,
			})

			const shot = await contents.debugger.sendCommand('Page.captureScreenshot', {
				format: 'png',
				captureBeyondViewport: true,
			}) as { data: string }

			await contents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
			return { png: Buffer.from(shot.data, 'base64') }
		}
		finally {
			if (contents.debugger.isAttached()) contents.debugger.detach()
		}
	}
	catch (e) {
		const reason = String((e as Error)?.message ?? e)
		Logger.warn('[osint] full-page render failed:', reason)
		return { reason }
	}
	finally {
		if (window && !window.isDestroyed()) window.destroy()
	}
}
