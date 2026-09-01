import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
	assertCwdPermitted,
	assertExecPermitted,
	ExecNotPermittedError,
	filterEnvOverrides,
	noteResolved,
	setWorkspaceRootsProvider,
} from './exec-guard'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'osint-exec-guard-'))
const settingsDir = path.join(workspace, '.osint-copilot')

function writeSettings(settings: Record<string, unknown>) {
	fs.mkdirSync(settingsDir, { recursive: true })
	fs.writeFileSync(path.join(settingsDir, 'data.json'), JSON.stringify(settings))
}

afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }))

describe('exec guard', () => {
	beforeEach(() => {
		fs.rmSync(settingsDir, { recursive: true, force: true })
		setWorkspaceRootsProvider(() => [workspace])
	})

	it('permits the built-in runtimes with no settings at all', async () => {
		await expect(assertExecPermitted('claude')).resolves.toBeUndefined()
		await expect(assertExecPermitted('codex')).resolves.toBeUndefined()
		await expect(assertExecPermitted('hermes')).resolves.toBeUndefined()
	})

	it('refuses a binary the user never configured', async () => {
		await expect(assertExecPermitted('/bin/sh')).rejects.toThrow(ExecNotPermittedError)
		await expect(assertExecPermitted('/usr/bin/env')).rejects.toThrow(/not one of the CLI paths/)
		await expect(assertExecPermitted('')).rejects.toThrow(ExecNotPermittedError)
	})

	it('permits a path the user configured, and still refuses its neighbours', async () => {
		writeSettings({ claudeCodeCliPath: '/opt/tools/claude-custom' })
		await expect(assertExecPermitted('/opt/tools/claude-custom')).resolves.toBeUndefined()
		await expect(assertExecPermitted('/opt/tools/other')).rejects.toThrow(ExecNotPermittedError)
	})

	it('permits a configured custom runtime', async () => {
		writeSettings({
			customAgentRuntimes: [
				{ id: 'r1', cliPath: '/opt/tools/my-runtime', enabled: true },
				{ id: 'r2', cliPath: '', enabled: false },
			],
		})
		await expect(assertExecPermitted('/opt/tools/my-runtime')).resolves.toBeUndefined()
	})

	it('accepts the absolute path the resolver produced for a permitted name', async () => {
		// resolveCliPath turns the configured bare name into a full path, and the renderer
		// legitimately passes that result back to exec.
		noteResolved('/home/someone/.local/bin/claude')
		await expect(assertExecPermitted('/home/someone/.local/bin/claude')).resolves.toBeUndefined()
	})

	it('falls back to the built-ins when settings are unreadable', async () => {
		fs.mkdirSync(settingsDir, { recursive: true })
		fs.writeFileSync(path.join(settingsDir, 'data.json'), '{ not json')
		await expect(assertExecPermitted('claude')).resolves.toBeUndefined()
		await expect(assertExecPermitted('/bin/sh')).rejects.toThrow(ExecNotPermittedError)
	})

	it('keeps only the environment overrides the renderer is allowed to set', () => {
		expect(filterEnvOverrides({ NO_COLOR: '1' })).toEqual({ NO_COLOR: '1' })
		expect(filterEnvOverrides({ LD_PRELOAD: '/tmp/evil.so', PATH: '/tmp', NO_COLOR: '1' }))
			.toEqual({ NO_COLOR: '1' })
		expect(filterEnvOverrides(undefined)).toEqual({})
	})

	it('confines the working directory to an open workspace or the home directory', () => {
		expect(() => assertCwdPermitted(undefined)).not.toThrow()
		expect(() => assertCwdPermitted(workspace)).not.toThrow()
		expect(() => assertCwdPermitted(os.homedir())).not.toThrow()
		expect(() => assertCwdPermitted('/etc')).toThrow(ExecNotPermittedError)
		expect(() => assertCwdPermitted(path.join(workspace, 'does-not-exist')))
			.toThrow(/does not exist/)
	})

	it('is not fooled by a path that merely starts with the workspace name', () => {
		expect(() => assertCwdPermitted(workspace + '-evil')).toThrow(ExecNotPermittedError)
	})
})
