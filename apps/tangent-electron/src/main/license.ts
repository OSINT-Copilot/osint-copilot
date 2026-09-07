import { app, ipcMain } from 'electron'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import Logger from 'js-logger'

import { LICENSE_FORMAT_VERSION, normalizeLicenseKey, type LicenseStatus } from '../common/license'
import { checkLicenseKey, fail } from './license-verify'
import { mode } from './environment'

const log = Logger.get('license')

/**
 * Licence storage and the IPC surface, in main.
 *
 * In main and not the renderer for two reasons: node:crypto is here, and the stored key
 * never has to cross into a window at all -- the renderer asks "am I licensed?" and gets
 * back a yes/no plus the name it was issued to, never the key itself.
 *
 * This is a lock on the front door, not a safe. Anyone who can edit the application bundle
 * can remove it, which is true of every offline licence check in every Electron app. What
 * it does buy is that a valid key cannot be forged, so keys cannot be invented or shared
 * as plausible-looking text.
 */

/** Where the accepted key is kept. Per-user, beside the app's other state. */
function licenseFilePath(): string {
	return path.join(app.getPath('userData'), 'license.json')
}

let cached: { key: string, status: LicenseStatus } | null = null

function readStoredKey(): string | null {
	try {
		const parsed = JSON.parse(readFileSync(licenseFilePath(), 'utf8'))
		return typeof parsed?.key === 'string' ? parsed.key : null
	}
	catch (e) {
		// Absent is the ordinary first-run case; anything else is worth a line in the log.
		if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			log.error('Could not read the stored licence:', e)
		}
		return null
	}
}

/**
 * Whether this build may run without a key.
 *
 * Only outside a packaged build: a developer running `npm run dev` should not have to mint
 * a licence to see their change, but a shipped application must never treat an environment
 * variable as a way past the check.
 */
function developerBypass(): boolean {
	return mode !== 'production' && process.env.OSINT_SKIP_LICENSE === '1'
}

/** The current licence status. Cheap to call: one file read, and one verify on a change. */
export function licenseStatus(): LicenseStatus {
	if (developerBypass()) {
		return { valid: true, payload: { v: LICENSE_FORMAT_VERSION, name: 'Development build' } }
	}

	const key = readStoredKey()
	if (!key) {
		cached = null
		return fail('missing')
	}
	if (cached?.key === key) return cached.status

	const status = checkLicenseKey(key)
	cached = { key, status }
	log.info(status.valid
		? `Licensed to ${status.payload?.name ?? 'unknown'}`
		: `Stored licence is not usable: ${status.reason}`)
	return status
}

/** Verifies a key and, if it is good, stores it. Returns what the user should be told. */
export function activateLicense(key: string): LicenseStatus {
	const status = checkLicenseKey(key)
	if (!status.valid) return status

	const normalized = normalizeLicenseKey(key)
	try {
		writeFileSync(
			licenseFilePath(),
			JSON.stringify({ key: normalized }, null, '\t'),
			{ encoding: 'utf8', mode: 0o600 },
		)
	}
	catch (e) {
		log.error('Could not store the licence:', e)
		// Verified but unstorable. Say so, rather than reporting success and then asking
		// for the key again on the next launch.
		return {
			valid: false,
			reason: 'missing',
			message: 'The key is valid, but it could not be saved. Check permissions on the application data folder.',
		}
	}

	cached = { key: normalized, status }
	log.info(`Licence activated for ${status.payload?.name ?? 'unknown'}`)
	return status
}

export function clearLicense(): void {
	cached = null
	try {
		rmSync(licenseFilePath(), { force: true })
	}
	catch (e) {
		log.error('Could not remove the stored licence:', e)
	}
}

export function initLicense() {
	ipcMain.handle('license', (_event, action: string, ...params: unknown[]) => {
		switch (action) {
			case 'status':
				return licenseStatus()
			case 'activate':
				return activateLicense(String(params[0] ?? ''))
			case 'clear':
				clearLicense()
				return licenseStatus()
			default:
				log.error('Unknown licence action:', action)
				return licenseStatus()
		}
	})
}
