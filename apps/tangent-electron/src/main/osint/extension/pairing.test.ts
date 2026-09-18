import { describe, it, expect, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { PairingManager, PairingStoreError, METADATA_FILE, type ConfirmPairing } from './pairing'
import { ExtensionSecretStore } from './secret-store'
import { PAIR_TTL_MS } from './protocol'
import {
	b64url,
	deriveClientKey,
	hmac,
	pairingIdFor,
	pairProofString,
	pairServerProofString,
	parsePairingString,
	verifyMac,
} from './signing'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-ext-pairing-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const ORIGIN_A = 'chrome-extension://' + 'a'.repeat(32)
const ORIGIN_B = 'chrome-extension://' + 'b'.repeat(32)

let n = 0
async function setup(confirm: ConfirmPairing = async () => true) {
	const dir = path.join(root, String(n++))
	fs.mkdirSync(dir)
	const clock = { now: 1_760_000_000_000 }
	const secrets = await ExtensionSecretStore.open(dir, null)
	const confirmSpy = vi.fn(confirm)
	const pairing = await PairingManager.open({ userDataDir: dir, secrets, confirm: confirmSpy, now: () => clock.now })
	return { dir, clock, secrets, pairing, confirm: confirmSpy }
}

/** What the extension does with a pairing string. */
function extensionRequest(pairing: string) {
	const parsed = parsePairingString(pairing)!
	const clientNonce = b64url(randomBytes(16))
	return {
		secret: parsed.pairSecret,
		request: {
			pairingId: pairingIdFor(parsed.pairSecret),
			clientNonce,
			extVersion: '1.0.0',
			proof: b64url(hmac(parsed.pairSecret, pairProofString(clientNonce))),
		},
	}
}

describe('pairing', () => {
	it('completes: both sides derive the same K and the server proof verifies', async () => {
		const { pairing, secrets, confirm } = await setup()
		const { pairingString } = pairing.begin(23760)
		expect(pairingString).toMatch(/^ocpair1\.23760\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
		const { secret, request } = extensionRequest(pairingString)

		const outcome = await pairing.complete(request, ORIGIN_A)
		expect(outcome.ok).toBe(true)
		if (!outcome.ok) return
		const { clientId, serverNonce, instanceId, serverProof } = outcome.response
		expect(instanceId).toBe(pairing.instanceId)
		expect(confirm).toHaveBeenCalledWith({ origin: ORIGIN_A, extVersion: '1.0.0' })
		expect(verifyMac(secret, pairServerProofString(request.clientNonce, serverNonce, clientId), serverProof)).toBe(true)

		const K = deriveClientKey(secret, request.clientNonce, serverNonce, clientId)
		expect(secrets.clientKey(clientId)?.equals(K)).toBe(true)
		expect(pairing.client(clientId)?.record.origin).toBe(ORIGIN_A)
	})

	it('never writes K, or the pairing secret, to osint-extension.json', async () => {
		const { pairing, secrets, dir } = await setup()
		const { secret, request } = extensionRequest(pairing.begin(23760).pairingString)
		const outcome = await pairing.complete(request, ORIGIN_A)
		if (!outcome.ok) throw new Error('pairing failed')
		const K = secrets.clientKey(outcome.response.clientId)!

		const text = fs.readFileSync(path.join(dir, METADATA_FILE), 'utf-8')
		for (const s of [b64url(K), K.toString('hex'), K.toString('base64'), b64url(secret)]) {
			expect(text).not.toContain(s)
		}
		const meta = JSON.parse(text)
		expect(Object.keys(meta).sort()).toEqual(['clients', 'enabled', 'instanceId', 'port'])
		expect(Object.keys(meta.clients[0]).sort()).toEqual(['clientId', 'createdAt', 'extVersion', 'lastSeenAt', 'origin'])
	})

	it('expires five minutes after it is shown', async () => {
		const { pairing, clock, confirm } = await setup()
		const { request } = extensionRequest(pairing.begin(23760).pairingString)
		clock.now += PAIR_TTL_MS + 1
		expect(pairing.hasActivePairing()).toBe(false)
		expect(await pairing.complete(request, ORIGIN_A)).toEqual({ ok: false, error: 'pair_expired' })
		expect(confirm).not.toHaveBeenCalled()
	})

	it('is still valid just before expiry', async () => {
		const { pairing, clock } = await setup()
		const { request } = extensionRequest(pairing.begin(23760).pairingString)
		clock.now += PAIR_TTL_MS - 1
		expect((await pairing.complete(request, ORIGIN_A)).ok).toBe(true)
	})

	it('is single use', async () => {
		const { pairing } = await setup()
		const { request } = extensionRequest(pairing.begin(23760).pairingString)
		expect((await pairing.complete(request, ORIGIN_A)).ok).toBe(true)
		expect(await pairing.complete(request, ORIGIN_A)).toEqual({ ok: false, error: 'pair_expired' })
	})

	it('is cancelled by beginning another', async () => {
		const { pairing } = await setup()
		const first = extensionRequest(pairing.begin(23760).pairingString)
		const second = extensionRequest(pairing.begin(23760).pairingString)
		expect(await pairing.complete(first.request, ORIGIN_A)).toEqual({ ok: false, error: 'pair_expired' })
		expect((await pairing.complete(second.request, ORIGIN_A)).ok).toBe(true)
	})

	it('is cancelled by cancel(), even while its dialog is open', async () => {
		let answer!: (yes: boolean) => void
		const { pairing, secrets } = await setup(() => new Promise(resolve => { answer = resolve }))
		const { request } = extensionRequest(pairing.begin(23760).pairingString)
		const pending = pairing.complete(request, ORIGIN_A)
		await vi.waitFor(() => expect(answer).toBeDefined())
		pairing.cancel()
		answer(true)
		expect(await pending).toEqual({ ok: false, error: 'pair_expired' })
		expect(pairing.listClients()).toEqual([])
		expect(secrets.clientIds()).toEqual([])
	})

	it('rejects a bad proof without consuming the pairing', async () => {
		const { pairing, confirm } = await setup()
		const { request } = extensionRequest(pairing.begin(23760).pairingString)
		const forged = { ...request, proof: b64url(randomBytes(32)) }
		expect(await pairing.complete(forged, ORIGIN_A)).toEqual({ ok: false, error: 'bad_signature' })
		expect(confirm).not.toHaveBeenCalled()
		expect((await pairing.complete(request, ORIGIN_A)).ok).toBe(true)
	})

	it('denial answers pair_denied, stores nothing, and uses up the pairing', async () => {
		const { pairing, secrets } = await setup(async () => false)
		const { request } = extensionRequest(pairing.begin(23760).pairingString)
		expect(await pairing.complete(request, ORIGIN_A)).toEqual({ ok: false, error: 'pair_denied' })
		expect(pairing.listClients()).toEqual([])
		expect(secrets.clientIds()).toEqual([])
		expect(await pairing.complete(request, ORIGIN_A)).toEqual({ ok: false, error: 'pair_expired' })
	})

	it('pairing the same origin again replaces its previous client', async () => {
		const { pairing, secrets } = await setup()
		const first = await pairing.complete(extensionRequest(pairing.begin(23760).pairingString).request, ORIGIN_A)
		const other = await pairing.complete(extensionRequest(pairing.begin(23760).pairingString).request, ORIGIN_B)
		const second = await pairing.complete(extensionRequest(pairing.begin(23760).pairingString).request, ORIGIN_A)
		if (!first.ok || !second.ok || !other.ok) throw new Error('pairing failed')

		expect(pairing.client(first.response.clientId)).toBeNull()
		expect(secrets.clientKey(first.response.clientId)).toBeNull()
		expect(pairing.client(second.response.clientId)).not.toBeNull()
		expect(pairing.client(other.response.clientId)).not.toBeNull()
		expect(pairing.listClients().map(c => c.origin).sort()).toEqual([ORIGIN_A, ORIGIN_B])
	})

	it('revoking removes the record and the key, across a restart', async () => {
		const { pairing, secrets, dir } = await setup()
		const outcome = await pairing.complete(extensionRequest(pairing.begin(23760).pairingString).request, ORIGIN_A)
		if (!outcome.ok) throw new Error('pairing failed')
		expect(await pairing.revokeClient(outcome.response.clientId)).toBe(true)
		expect(pairing.client(outcome.response.clientId)).toBeNull()
		expect(secrets.clientKey(outcome.response.clientId)).toBeNull()

		const reopened = await PairingManager.open({ userDataDir: dir, secrets, confirm: async () => true })
		expect(reopened.listClients()).toEqual([])
		expect(reopened.instanceId).toBe(pairing.instanceId)
	})

	it('drops a key whose record is gone when it opens', async () => {
		const { secrets, dir } = await setup()
		await secrets.setClientKey('orphan', randomBytes(32))
		await PairingManager.open({ userDataDir: dir, secrets, confirm: async () => true })
		expect(secrets.clientKey('orphan')).toBeNull()
	})

	it('refuses to start over a metadata file it cannot read or parse, and keeps the keys', async () => {
		const { pairing, secrets, dir } = await setup()
		const outcome = await pairing.complete(extensionRequest(pairing.begin(23760).pairingString).request, ORIGIN_A)
		if (!outcome.ok) throw new Error('pairing failed')
		const file = path.join(dir, METADATA_FILE)
		const original = fs.readFileSync(file, 'utf-8')

		for (const broken of ['{"instanceId":', '{"port":23760}']) {
			fs.writeFileSync(file, broken)
			await expect(PairingManager.open({ userDataDir: dir, secrets, confirm: async () => true })).rejects.toBeInstanceOf(PairingStoreError)
			expect(fs.readFileSync(file, 'utf-8')).toBe(broken)
		}
		// A read error that is not ENOENT (here EISDIR) is not "no file" either.
		fs.rmSync(file)
		fs.mkdirSync(file)
		await expect(PairingManager.open({ userDataDir: dir, secrets, confirm: async () => true })).rejects.toBeInstanceOf(PairingStoreError)
		expect(secrets.clientKey(outcome.response.clientId)).not.toBeNull()

		fs.rmdirSync(file)
		fs.writeFileSync(file, original)
		const reopened = await PairingManager.open({ userDataDir: dir, secrets, confirm: async () => true })
		expect(reopened.client(outcome.response.clientId)).not.toBeNull()
		expect(reopened.instanceId).toBe(pairing.instanceId)
	})

	it('refuses an invalid extVersion before showing the dialog', async () => {
		const { pairing, confirm } = await setup()
		const { request } = extensionRequest(pairing.begin(23760).pairingString)
		const outcome = await pairing.complete({ ...request, extVersion: '1.0<script>' }, ORIGIN_A)
		expect(outcome.ok).toBe(false)
		expect(confirm).not.toHaveBeenCalled()
	})

	it('persists port, instanceId and the enabled switch', async () => {
		const { pairing, secrets, dir } = await setup()
		await pairing.setPort(23762)
		await pairing.setEnabled(true)
		const reopened = await PairingManager.open({ userDataDir: dir, secrets, confirm: async () => true })
		expect(reopened.port).toBe(23762)
		expect(reopened.enabled).toBe(true)
		expect(reopened.instanceId).toBe(pairing.instanceId)
	})
})
