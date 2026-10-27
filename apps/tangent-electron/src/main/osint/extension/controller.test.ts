import { describe, it, expect, afterAll, afterEach } from 'vitest'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { ExtensionController } from './controller'

/**
 * The port is open only while the licence carries osint AND the switch is on. Anything
 * else must close it, not merely answer "no".
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-ext-controller-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

let n = 0
const opened: ExtensionController[] = []
afterEach(async () => {
	for (const c of opened.splice(0)) await c.stop()
})

async function open(licence: { osint: boolean }) {
	const userDataDir = path.join(dir, String(n++))
	const controller = await ExtensionController.open({
		userDataDir,
		encryptor: null,
		confirm: async () => true,
		licensed: async () => licence.osint,
		host: { knownRoots: () => [], openRoots: () => [], documentationPath: () => null, notify: () => undefined },
		appVersion: '0.0.0-test',
		ports: [0],
	})
	opened.push(controller)
	return { controller, userDataDir }
}

function connects(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const s = net.connect(port, '127.0.0.1')
		s.on('connect', () => { s.destroy(); resolve(true) })
		s.on('error', () => resolve(false))
	})
}

describe('reconcile', () => {
	it('stays closed until the user switches it on, and is off by default', async () => {
		const { controller } = await open({ osint: true })
		await controller.reconcile()
		expect(await controller.status()).toMatchObject({ enabled: false, running: false, port: null, licensed: true })
		await expect(controller.pairBegin()).rejects.toThrow(/Turn on/)
	})

	it('opens when enabled and licensed, and closes the port when the licence goes', async () => {
		const licence = { osint: true }
		const { controller } = await open(licence)
		const status = await controller.setEnabled(true)
		expect(status).toMatchObject({ enabled: true, running: true, licensed: true })
		const port = status.port!
		expect(await connects(port)).toBe(true)
		const pairing = await controller.pairBegin()
		expect(pairing.pairingString).toMatch(new RegExp(`^ocpair1\\.${port}\\.`))

		licence.osint = false
		await controller.reconcile()
		expect(await controller.status()).toMatchObject({ enabled: true, running: false, port: null, licensed: false })
		expect(await connects(port)).toBe(false)
		// The string on screen named a port that is now closed.
		expect(controller.pairing.hasActivePairing()).toBe(false)

		licence.osint = true
		await controller.reconcile()
		expect((await controller.status()).running).toBe(true)
	})

	it('persists the switch, and switching off closes the port', async () => {
		const { controller, userDataDir } = await open({ osint: true })
		const { port } = await controller.setEnabled(true)
		expect(JSON.parse(fs.readFileSync(path.join(userDataDir, 'osint-extension.json'), 'utf8')).enabled).toBe(true)
		await controller.setEnabled(false)
		expect(await connects(port!)).toBe(false)
		expect(JSON.parse(fs.readFileSync(path.join(userDataDir, 'osint-extension.json'), 'utf8')).enabled).toBe(false)
	})

	it('never opens again after stop, as on quit', async () => {
		const { controller } = await open({ osint: true })
		const { port } = await controller.setEnabled(true)
		await controller.stop()
		await controller.reconcile()
		expect(await connects(port!)).toBe(false)
		expect((await controller.status()).running).toBe(false)
	})

	it('status reports client metadata and never a key', async () => {
		const { controller } = await open({ osint: true })
		await controller.setEnabled(true)
		await controller.secrets.setClientKey('CCCCCCCCCCCCCCCCCCCCCC', Buffer.alloc(32, 7))
		const status = await controller.status()
		expect(status.secretsEncrypted).toBe(false)
		expect(JSON.stringify(status)).not.toContain(Buffer.alloc(32, 7).toString('base64url'))
	})
})
