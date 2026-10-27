import { test, expect } from './tangent'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { blinkArchive } from '../src/main/osint/capture/test-archives'

/**
 * The capture render, in the real app's main process and a real Chromium.
 *
 * renderArchive screenshots an MHTML archive the browser extension sent from a page the
 * analyst is investigating. Loading it must not tell that site anything: no request, no
 * preconnected socket, not even a TCP handshake, and no DNS lookup of its names. Unit
 * tests can only check the request filter's logic; what Chromium does with a
 * <link rel=preconnect> or a dns-prefetch is only visible here. So a canary server counts
 * raw TCP connections, not HTTP requests, and Chromium's own net log is searched for the
 * names a page asks to have resolved.
 *
 * The render is reached through a global main sets only in a development build run by
 * this harness (see main/osint/index.ts).
 */

type Canary = { port: number, connections: () => number, close: () => Promise<void> }

function startCanary(): Promise<Canary> {
	return new Promise((resolve, reject) => {
		let count = 0
		const sockets = new Set<net.Socket>()
		const server = net.createServer(socket => {
			count++
			sockets.add(socket)
			socket.on('close', () => sockets.delete(socket))
			socket.on('error', () => undefined)
			// Say nothing and hang up: the count is the evidence, not the reply.
			socket.destroy()
		})
		server.on('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as net.AddressInfo).port
			resolve({
				port,
				connections: () => count,
				close: () => new Promise(done => {
					for (const s of sockets) s.destroy()
					server.close(() => done())
				}),
			})
		})
	})
}

/**
 * A page that tries every way HTML has to reach a server without JavaScript: at the
 * canary by address, and at `name` (under .invalid, so even a leak asks nobody real) by
 * name, which is what a DNS lookup would carry.
 */
function hostileHtml(port: number, name: string, marker: string): string {
	const origin = `http://127.0.0.1:${port}`
	return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${origin}/refresh">
<link rel="preconnect" href="${origin}/">
<link rel="preconnect" href="${origin}/" crossorigin>
<link rel="dns-prefetch" href="${origin}/">
<link rel="preconnect" href="http://preconnect.${name}/">
<link rel="dns-prefetch" href="http://dns.${name}/">
<link rel="prefetch" href="${origin}/prefetch">
<link rel="preload" as="image" href="${origin}/preload.png">
<link rel="stylesheet" href="${origin}/style.css">
<link rel="icon" href="${origin}/favicon.ico">
<style>
	body { background: url(${origin}/background.png); font-family: sans-serif; }
	@font-face { font-family: canary; src: url(${origin}/font.woff2); }
	h1 { font-family: canary; }
</style>
</head><body>
<h1>${marker}</h1>
<p>Evidence page body.</p>
<img src="${origin}/img.png" width="40" height="40">
<img src="http://img.${name}/img.png" width="40" height="40">
<picture><source srcset="${origin}/source.webp"><img src="${origin}/picture.png"></picture>
<iframe src="${origin}/frame"></iframe>
<video poster="${origin}/poster.png"></video>
<a href="${origin}/link">a link</a>
<a href="http://anchor.${name}/">a named link</a>
</body></html>`
}

test('rendering an archive contacts nothing, and every render reuses one partition', async ({ tangent }) => {
	test.setTimeout(120_000)
	// The app's main process is up once its first window is.
	await tangent.firstWindow()

	const canary = await startCanary()
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'osint-capture-render-'))
	const name = `oc-render-canary-${process.pid}-${Date.now()}.invalid`
	const netLogPath = path.join(dir, 'net-log.json')
	try {
		// The canary does count a connection when one is made; otherwise zero proves nothing.
		await new Promise<void>((resolve, reject) => {
			const probe = net.connect(canary.port, '127.0.0.1', () => { probe.destroy(); resolve() })
			probe.on('error', reject)
		})
		await expect.poll(() => canary.connections()).toBe(1)
		const baseline = canary.connections()

		const archives: string[] = []
		for (let i = 0; i < 4; i++) {
			const file = path.join(dir, `page-${i}.mhtml`)
			await fs.promises.writeFile(file, blinkArchive({
				url: `http://127.0.0.1:${canary.port}/page-${i}`,
				html: hostileHtml(canary.port, name, `Canary page ${i}`),
			}))
			archives.push(file)
		}

		const hookState = await tangent.app.evaluate(() => {
			const hook = (globalThis as any).__osintCaptureRenderTest
			return hook ? { stats: hook.renderSessionStats(), partition: hook.RENDER_PARTITION as string } : null
		})
		expect(hookState, 'the test hook is missing: is this a development build run with INTEGRATION_TEST?').not.toBeNull()
		const before = hookState!.stats

		const results = await tangent.app.evaluate(async ({ netLog, session }, { files, logPath }) => {
			const hook = (globalThis as any).__osintCaptureRenderTest
			const preconnects: string[] = []
			const onPreconnect = (_e: unknown, url: string) => { preconnects.push(url) }
			// Not a new partition: fromPartition hands back the one the renders use.
			const renderSession = session.fromPartition(hook.RENDER_PARTITION, { cache: false })
			renderSession.on('preconnect', onPreconnect)
			await netLog.startLogging(logPath, { captureMode: 'includeSensitive' })
			const out: { png: string | null, reason: string | null }[] = []
			try {
				for (const file of files) {
					const r = await hook.renderArchive(file)
					out.push({ png: r.png ? r.png.subarray(0, 8).toString('hex') : null, reason: r.reason ?? null })
				}
				// Anything the renders set off asynchronously has time to happen.
				await new Promise(resolve => setTimeout(resolve, 3000))
			}
			finally {
				await netLog.stopLogging()
				renderSession.off('preconnect', onPreconnect)
			}
			return { out, preconnects, stats: hook.renderSessionStats() }
		}, { files: archives, logPath: netLogPath })

		for (const r of results.out) {
			expect(r.reason).toBeNull()
			// The PNG signature.
			expect(r.png).toBe('89504e470d0a1a0a')
		}

		// The archives did ask for preconnects (so that path was exercised)...
		expect(results.preconnects.length).toBeGreaterThan(0)
		// ...and not one TCP connection reached the canary.
		expect(canary.connections() - baseline).toBe(0)

		// No name the pages mention was looked up: not through dns-prefetch, which asks
		// the resolver directly and so passes neither webRequest nor the proxy, nor
		// through a preconnect, an image or a link.
		const log = await fs.promises.readFile(netLogPath, 'utf8')
		expect(log.length).toBeGreaterThan(0)
		expect(log.includes(name), `the net log mentions ${name}`).toBe(false)

		// One partition for every render this app has done, not one per render.
		expect(results.stats.rendersStarted - before.rendersStarted).toBe(archives.length)
		expect(results.stats.partitionsCreated).toBe(1)

		// The dead proxy, proven: a socket opened in the render partition goes nowhere,
		// while the same preconnect in an ordinary partition does reach the canary. Blink
		// asks for these for every <link rel=preconnect>; today Electron only reports
		// them, and this is what stands between the page and the site if that changes.
		const origin = `http://127.0.0.1:${canary.port}`
		const beforeRenderSocket = canary.connections()
		await tangent.app.evaluate(async ({ session }, { partition, url }) => {
			session.fromPartition(partition, { cache: false }).preconnect({ url, numSockets: 2 })
			await new Promise(resolve => setTimeout(resolve, 2000))
		}, { partition: hookState!.partition, url: origin })
		expect(canary.connections() - beforeRenderSocket).toBe(0)

		const beforeControl = canary.connections()
		await tangent.app.evaluate(async ({ session }, url) => {
			session.fromPartition('osint-render-test-control', { cache: false }).preconnect({ url, numSockets: 2 })
			await new Promise(resolve => setTimeout(resolve, 2000))
		}, origin)
		expect(canary.connections() - beforeControl).toBeGreaterThan(0)

		// And the net log would have shown a lookup: the same markup as a plain HTML
		// file, in an ordinary window, does get its dns-prefetch name resolved. (Blink
		// skips these hints for an MHTML archive, which is what keeps the render's names
		// out of DNS; nothing in Electron can turn them off for one session, so this is
		// the check that notices if a Chromium update changes it.)
		const plain = path.join(dir, 'plain.html')
		const controlName = `control-${name}`
		await fs.promises.writeFile(plain, hostileHtml(canary.port, controlName, 'Control page'))
		const controlLogPath = path.join(dir, 'control-net-log.json')
		await tangent.app.evaluate(async ({ BrowserWindow, netLog, session }, { file, logPath }) => {
			const ses = session.fromPartition('osint-render-test-control', { cache: false })
			await netLog.startLogging(logPath, { captureMode: 'includeSensitive' })
			const win = new BrowserWindow({ show: false, webPreferences: { session: ses, javascript: false } })
			try {
				await win.loadFile(file).catch(() => undefined)
				await new Promise(resolve => setTimeout(resolve, 3000))
			}
			finally {
				win.destroy()
				await netLog.stopLogging()
			}
		}, { file: plain, logPath: controlLogPath })
		const controlLog = await fs.promises.readFile(controlLogPath, 'utf8')
		expect(controlLog.includes(`dns.${controlName}`)).toBe(true)
	}
	finally {
		await canary.close()
		await fs.promises.rm(dir, { recursive: true, force: true })
	}
})
