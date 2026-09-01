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
 * Any extra arguments are passed through to Electron.
 */
import { spawn } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

const require = createRequire(import.meta.url)
const electron = require('electron')
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const args = ['.']
if (process.platform === 'linux' && process.env.OZONE !== 'native') {
	args.push('--ozone-platform=x11')
}
args.push(...process.argv.slice(2))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

console.log(`> electron ${args.join(' ')}`)
const child = spawn(electron, args, { cwd: appDir, stdio: 'inherit', env })
child.on('close', code => process.exit(code ?? 0))
