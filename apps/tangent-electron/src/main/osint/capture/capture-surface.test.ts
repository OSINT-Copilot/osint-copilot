import { describe, it, expect, vi } from 'vitest'
import * as path from 'path'
import { pathToFileURL } from 'url'

// renderArchive itself needs a real Electron (tests-integration/capture-render.test.ts
// runs it); the request filter and the partition bookkeeping are plain logic.
const electron = vi.hoisted(() => {
	const sessions: any[] = []
	// What the next setProxy or clearStorageData does instead of succeeding.
	const faults = { setProxy: null as null | 'fail' | 'hang', clearStorageData: null as null | 'hang' }
	let handlers = 0
	const fault = (name: 'setProxy' | 'clearStorageData') => {
		const f = faults[name]
		faults[name] = null
		if (f === 'fail') return Promise.reject(new Error(`${name} failed`))
		if (f === 'hang') return new Promise<void>(() => {})
		return null
	}
	const fromPartition = (name: string, options: object) => {
		// Electron hands back the same session for the same partition name.
		const existing = sessions.find(s => s.name === name)
		if (existing) return existing
		const calls: string[] = []
		const session = {
			name, options, calls,
			beforeRequest: null as null | ((details: { url: string }, cb: (r: { cancel: boolean }) => void) => void),
			webRequest: { onBeforeRequest(listener: any) { handlers++; session.beforeRequest = listener } },
			setPermissionRequestHandler() {},
			setPermissionCheckHandler() {},
			on() {},
			setProxy: async (config: object) => { calls.push('setProxy:' + JSON.stringify(config)); await fault('setProxy') },
			clearStorageData: async () => { calls.push('clearStorageData'); await fault('clearStorageData') },
			clearCache: async () => { calls.push('clearCache') },
			clearHostResolverCache: async () => { calls.push('clearHostResolverCache') },
			closeAllConnections: async () => { calls.push('closeAllConnections') },
		}
		sessions.push(session)
		return session
	}
	return { sessions, fromPartition, faults, handlerCount: () => handlers }
})
vi.mock('electron', () => ({ BrowserWindow: class {}, session: { fromPartition: electron.fromPartition } }))
import {
	isArchiveRequest, acquireRenderSession, renderSessionStats,
	RENDER_PARTITION, DEAD_PROXY_RULES, DEAD_PROXY_BYPASS,
} from './capture-surface'

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

describe('the render partition', () => {
	it('is created once, in memory, behind the dead proxy, and emptied before every render', async () => {
		const first = await acquireRenderSession()
		const second = await acquireRenderSession()
		const third = await acquireRenderSession()

		expect(electron.sessions).toHaveLength(1)
		expect(first).toBe(second)
		expect(second).toBe(third)
		expect(renderSessionStats().partitionsCreated).toBe(1)

		const session = electron.sessions[0]
		// No 'persist:' prefix: Electron keeps it in memory only.
		expect(session.name).toBe(RENDER_PARTITION)
		expect(session.name.startsWith('persist:')).toBe(false)
		expect(session.options).toEqual({ cache: false })

		const reset = ['clearStorageData', 'clearCache', 'clearHostResolverCache', 'closeAllConnections']
		expect(session.calls).toEqual([
			'setProxy:' + JSON.stringify({ mode: 'fixed_servers', proxyRules: DEAD_PROXY_RULES, proxyBypassRules: DEAD_PROXY_BYPASS }),
			...reset, ...reset, ...reset,
		])
	})

	it('sends every scheme, loopback included, to a port nothing listens on', () => {
		for (const scheme of ['http', 'https']) {
			expect(DEAD_PROXY_RULES).toContain(`${scheme}=127.0.0.1:9`)
		}
		// SOCKS5 named outright: SOCKS4 would resolve the site's name locally.
		expect(DEAD_PROXY_RULES).toContain('socks=socks5://127.0.0.1:9')
		// Without this Chromium would still connect straight to 127.0.0.1 and localhost.
		expect(DEAD_PROXY_BYPASS).toBe('<-loopback>')
	})

	it('refuses every request while no render is in progress, even the last archive', () => {
		const session = electron.sessions[0]
		const answers: boolean[] = []
		session.beforeRequest!({ url: 'https://tracker.example/' }, r => answers.push(r.cancel))
		session.beforeRequest!({ url: pathToFileURL(path.resolve('/x/page.mhtml')).href }, r => answers.push(r.cancel))
		session.beforeRequest!({ url: 'data:text/plain,x' }, r => answers.push(r.cancel))
		expect(answers).toEqual([true, true, true])
	})

	it('runs a failed setup again without installing its handlers twice', async () => {
		vi.resetModules()
		const fresh = await vi.importActual<typeof import('./capture-surface')>('./capture-surface')
		const before = electron.handlerCount()
		electron.faults.setProxy = 'fail'
		await expect(fresh.acquireRenderSession()).rejects.toThrow('setProxy failed')
		const session = await fresh.acquireRenderSession()
		expect(session).toBe(electron.sessions[0])
		expect(electron.handlerCount() - before).toBe(1)
		expect(fresh.renderSessionStats().partitionsCreated).toBe(1)
	})

	it('gives up on a partition that never finishes emptying, and empties it again next time', async () => {
		vi.useFakeTimers()
		try {
			electron.faults.clearStorageData = 'hang'
			const stuck = acquireRenderSession()
			const settled = expect(stuck).rejects.toThrow('emptying the render partition timed out')
			await vi.advanceTimersByTimeAsync(15000)
			await settled
		} finally {
			vi.useRealTimers()
		}
		const session = electron.sessions[0]
		session.calls.length = 0
		await acquireRenderSession()
		expect(session.calls).toEqual(['clearStorageData', 'clearCache', 'clearHostResolverCache', 'closeAllConnections'])
	})

	it('gives up on a proxy setup that never finishes, and sets it up again next time', async () => {
		vi.resetModules()
		const fresh = await vi.importActual<typeof import('./capture-surface')>('./capture-surface')
		vi.useFakeTimers()
		try {
			electron.faults.setProxy = 'hang'
			const stuck = fresh.acquireRenderSession()
			const settled = expect(stuck).rejects.toThrow('setting the render proxy timed out')
			await vi.advanceTimersByTimeAsync(15000)
			await settled
		} finally {
			vi.useRealTimers()
		}
		const session = electron.sessions[0]
		session.calls.length = 0
		await fresh.acquireRenderSession()
		expect(session.calls[0]).toMatch(/^setProxy:/)
	})
})
