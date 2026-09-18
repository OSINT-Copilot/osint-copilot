import { describe, it, expect, vi } from 'vitest'
import * as path from 'path'
import { pathToFileURL } from 'url'

// renderArchive itself needs a real Electron; the request filter is the part that decides
// what an archived page may fetch, and it is plain logic.
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {} }))
import { isArchiveRequest } from './capture-surface'

describe('what the archive render may load', () => {
	const archive = path.resolve('/cases/My Case/.osint-inbox/pending/x/page.mhtml')
	const own = pathToFileURL(archive).href

	it('allows the archive itself and its cid: and data: parts', () => {
		expect(isArchiveRequest(own, archive)).toBe(true)
		expect(isArchiveRequest(own.replace('My%20Case', 'My Case'), archive)).toBe(true)
		expect(isArchiveRequest('cid:css-1@mhtml.blink', archive)).toBe(true)
		expect(isArchiveRequest('data:image/png;base64,AAAA', archive)).toBe(true)
	})

	it('refuses the network, other files, and every other scheme', () => {
		for (const url of [
			'https://tracker.example/pixel.gif',
			'http://127.0.0.1:23760/v1/status',
			'ws://tracker.example/',
			'blob:https://tracker.example/1',
			pathToFileURL(path.resolve('/etc/passwd')).href,
			pathToFileURL(path.resolve('/cases/My Case/.osint-inbox/pending/x/other.mhtml')).href,
			own + '?x=1',
			'file://evil-host/share/page.mhtml',
			'chrome://settings',
			'devtools://devtools/bundled/x.html',
		]) {
			expect(isArchiveRequest(url, archive), url).toBe(false)
		}
	})
})
