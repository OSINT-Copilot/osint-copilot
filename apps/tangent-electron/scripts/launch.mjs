#!/usr/bin/env node
/**
 * Dev launcher for OSINT Copilot.
 *
 * Exists because two things reliably go wrong when launching Electron from a shell:
 *
 * 1. `ELECTRON_RUN_AS_NODE` — if it is exported, the Electron binary runs as plain
 *    Node. No window opens, `electron --version` prints the Node version, and nothing
 *    explains why. We strip it.
 *
 * 2. The Wayland ozone backend. On some Linux systems Electron segfaults the instant
 *    it creates a renderer under Wayland (observed on kernel 7.0.0 with Electron 37
 *    *and* 42 — it is not a version regression; Electron <=37 merely defaulted to X11).
 *    Only the `--ozone-platform=x11` command-line switch works; the
 *    ELECTRON_OZONE_PLATFORM_HINT env var does not. So on Linux we default to X11 for
 *    development. Set OZONE=native to opt out and use the system default, and note that
 *    this is dev-only — the packaged build must not force a backend on users.
 *
 * 3. Chromium's sandbox on Linux. Ubuntu 24.04+ sets
 *    kernel.apparmor_restrict_unprivileged_userns=1, which blocks the unprivileged
 *    user-namespace sandbox, so Chromium falls back to its SUID helper — and npm
 *    cannot install that helper setuid-root. Electron then aborts outright. We detect
 *    it, print the permanent fix, and fall back to --no-sandbox so development is not
 *    blocked. The fallback is loud on purpose: this app renders LLM and enricher
 *    output, so the renderer sandbox is worth having.
 *
 * Any extra arguments are passed through to Electron.
 */
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import fs from 'fs'
import path from 'path'

const require = createRequire(import.meta.url)
const electron = require('electron')
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const args = ['.']
if (process.platform === 'linux' && process.env.OZONE !== 'native') {
	args.push('--ozone-platform=x11')
}

/**
 * The SUID helper is only usable when it is owned by root and setuid (mode 4755).
 * Returns null when the sandbox is fine, or a reason string when it is not.
 */
function sandboxProblem() {
	if (process.platform !== 'linux') return null
	const helper = path.join(path.dirname(electron), 'chrome-sandbox')
	let stat
	try { stat = fs.statSync(helper) } catch { return null } // no helper: userns sandbox is in use
	const setuid = (stat.mode & 0o4000) !== 0
	if (stat.uid === 0 && setuid) return null

	// The helper is only consulted when the userns sandbox is unavailable.
	let restricted = false
	try {
		restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'
	} catch { /* kernel without the knob */ }
	if (!restricted) return null

	return helper
}

const helper = sandboxProblem()
if (helper && process.env.SANDBOX !== 'require') {
	console.warn(`
  ! Chromium's sandbox is unavailable, so this launch uses --no-sandbox.
  !
  ! Why: this kernel sets apparmor_restrict_unprivileged_userns=1 (Ubuntu 24.04+),
  ! which blocks the user-namespace sandbox, and npm cannot install Chromium's SUID
  ! helper setuid-root. Fix it once with:
  !
  !     sudo chown root:root "${helper}"
  !     sudo chmod 4755 "${helper}"
  !
  ! Re-run that after any npm install that reinstalls electron. Use SANDBOX=require
  ! to refuse to start without it instead of falling back.
`)
	args.push('--no-sandbox')
}

args.push(...process.argv.slice(2))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

console.log(`> electron ${args.join(' ')}`)
const child = spawn(electron, args, { cwd: appDir, stdio: 'inherit', env })
child.on('close', code => process.exit(code ?? 0))
