/**
 * The trust boundary for spawning processes.
 *
 * The renderer is untrusted: it displays LLM output and enricher output, and this
 * build ships without a CSP. Without this guard, `osint:cli.exec` forwards a
 * renderer-supplied `binary`, `args`, `cwd`, `stdin` and `envOverrides` straight into
 * execFile, which is arbitrary code execution from a markdown injection.
 *
 * The guard's rule: **main decides which binaries may run, by reading the user's
 * settings itself.** The renderer may name a binary, but only one that main
 * independently derived from `<workspace>/.osint-copilot/data.json` — the file the
 * settings UI writes — or one of the built-in CLI names. A renderer that asks for
 * /bin/sh is refused even though it can see the settings, because main never derived
 * /bin/sh from them.
 *
 * What this does NOT stop: a renderer choosing *which* configured runtime to run, or
 * what arguments to pass it. Those are the product's own semantics. Argument-level
 * control for the Codex runtime is enforced separately by FRAMEWORK_OWNED_CODEX_ARGS
 * in codex-cli-service.ts.
 */
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import Logger from 'js-logger'

/** Runtimes the product ships with. Always permitted, resolved through the normal probe. */
const BUILT_IN_CLI_NAMES = ['claude', 'claude-code', 'codex', 'hermes'] as const

/**
 * Environment variables the renderer may override. Everything else in the child's
 * environment is inherited from main, unmodified — the renderer cannot inject an
 * LD_PRELOAD, a PATH, or a fake credential.
 */
const PERMITTED_ENV_OVERRIDES = new Set(['NO_COLOR'])

const SETTINGS_RELATIVE_PATH = path.join('.osint-copilot', 'data.json')

/** Paths resolveCliPath handed out this session, from a name main had already permitted. */
const derivedFromSettings = new Set<string>()

/**
 * Where to look for settings. Injected rather than imported so the guard stays testable
 * and does not depend on Tangent's workspace bookkeeping.
 */
let workspaceRootsProvider: () => string[] = () => []
export function setWorkspaceRootsProvider(provider: () => string[]): void {
	workspaceRootsProvider = provider
}

/**
 * True when `candidate` names a file inside one of the open workspaces.
 *
 * Settings live in the vault, so whoever can write a note can write `cliPath`. If that
 * path may also *point* into the vault, "write a script and run it" is self-contained:
 * no binary has to already exist on the machine. Refusing vault-resident interpreters
 * costs nothing real -- a CLI runtime lives in /usr/bin or ~/.local/bin, not in the
 * notes you are investigating with.
 */
function isInsideAWorkspace(candidate: string): boolean {
	if (!path.isAbsolute(candidate)) return false
	const resolved = path.resolve(candidate)
	return workspaceRootsProvider().some(root => {
		const rel = path.relative(path.resolve(root), resolved)
		return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
	})
}

function addCandidate(into: Set<string>, value: unknown): void {
	if (typeof value !== 'string') return
	const trimmed = value.trim()
	if (!trimmed) return
	if (isInsideAWorkspace(trimmed)) {
		Logger.warn('[osint] ignoring a configured CLI path inside the vault:', trimmed)
		return
	}
	into.add(trimmed)
	// A bare name ("claude") is resolved to an absolute path before exec, so permit both
	// spellings; the absolute form is verified against this set by basename below.
	//
	// Only for a bare name. Adding the basename of a *path* would widen the set far past
	// what was configured: settings naming /opt/vendor/sh would permit /bin/sh, which is
	// the difference between "run the runtime the user chose" and "run anything". The
	// resolver's own output is recorded by noteResolved() instead, so the path spelling
	// still round-trips.
	if (trimmed === path.basename(trimmed)) into.add(trimmed)
}

/**
 * Re-read every open workspace's settings. Cheap (one small JSON per workspace) and
 * done per exec so that changing a CLI path in Settings takes effect without a restart.
 */
async function readConfiguredBinaries(): Promise<Set<string>> {
	const found = new Set<string>()
	for (const name of BUILT_IN_CLI_NAMES) found.add(name)

	for (const root of workspaceRootsProvider()) {
		const settingsPath = path.join(root, SETTINGS_RELATIVE_PATH)
		try {
			const parsed = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'))
			addCandidate(found, parsed?.claudeCodeCliPath)
			addCandidate(found, parsed?.codexCliPath)
			addCandidate(found, parsed?.hermesAgentCliPath)
			if (Array.isArray(parsed?.customAgentRuntimes)) {
				for (const runtime of parsed.customAgentRuntimes) addCandidate(found, runtime?.cliPath)
			}
		} catch {
			// No settings yet, or unreadable: fall back to the built-ins only.
		}
	}
	return found
}

/** Record a path the resolver produced, so a later exec of that exact path is recognised. */
export function noteResolved(binary: string): void {
	if (binary) derivedFromSettings.add(binary)
}

export class ExecNotPermittedError extends Error {}

/**
 * Throws unless `binary` is one main itself derived from user settings.
 *
 * Matching is on the absolute path when the caller gives one, and additionally on the
 * basename, because resolveCliPath turns a configured bare name into a full path and the
 * renderer legitimately passes that result back.
 */
export async function assertExecPermitted(binary: string): Promise<void> {
	const candidate = (binary ?? '').trim()
	if (!candidate) throw new ExecNotPermittedError('Refusing to execute an empty binary path.')

	const permitted = await readConfiguredBinaries()
	for (const resolved of derivedFromSettings) permitted.add(resolved)

	if (permitted.has(candidate) || permitted.has(path.basename(candidate))) return

	Logger.warn('[osint] refused to execute a binary not derived from settings:', candidate)
	throw new ExecNotPermittedError(
		`Refusing to execute "${candidate}": it is not one of the CLI paths configured in OSINT Copilot's settings.`,
	)
}

/** Drop every override the renderer is not allowed to set. */
export function filterEnvOverrides(
	overrides: Record<string, string> | undefined,
): Record<string, string> {
	const safe: Record<string, string> = {}
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (PERMITTED_ENV_OVERRIDES.has(key)) safe[key] = value
		else Logger.warn('[osint] dropped a disallowed env override:', key)
	}
	return safe
}

/**
 * `cwd` must be inside an open workspace or the user's home. Nothing needs to run
 * elsewhere, and an arbitrary cwd is a useful primitive for an attacker.
 */
export function assertCwdPermitted(cwd: string | undefined): void {
	if (!cwd) return
	const resolved = path.resolve(cwd)
	const allowed = [...workspaceRootsProvider(), os.homedir()].filter(Boolean).map(r => path.resolve(r))
	const ok = allowed.some(root => resolved === root || resolved.startsWith(root + path.sep))
	if (!ok) throw new ExecNotPermittedError(`Refusing to run a process in "${cwd}".`)
	if (!fs.existsSync(resolved)) throw new ExecNotPermittedError(`Working directory does not exist: ${cwd}`)
}
