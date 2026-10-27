import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

// Vitest and Playwright both refuse a --project filter that matches no project, so a
// script naming a renamed or retired project fails before it runs anything.
const root = path.join(__dirname, '../..')
const scripts: Record<string, string> = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts

function projectsNamedBy(tool: string): [string, string][] {
	const named: [string, string][] = []
	for (const [script, command] of Object.entries(scripts)) {
		for (const part of command.split('&&')) {
			if (!part.trim().startsWith(tool)) continue
			for (const match of part.matchAll(/--project[= ](\S+)/g)) named.push([script, match[1]])
		}
	}
	return named
}

function namesIn(files: string[]): string[] {
	return files.flatMap(file => [...fs.readFileSync(path.join(root, file), 'utf8').matchAll(/\bname:\s*'([^']+)'/g)].map(m => m[1]))
}

describe('Package scripts', () => {
	it('Should name vitest projects that exist', () => {
		const projects = namesIn(fs.readdirSync(root).filter(f => /^vitest\.config\.project\..*\.mts$/.test(f)))
		expect(projects).toContain('tangent-electron-integration')
		const named = projectsNamedBy('vitest')
		expect(named.length).toBeGreaterThan(0)
		for (const [script, project] of named) expect(projects, `${script} names ${project}`).toContain(project)
	})

	it('Should name playwright projects that exist', () => {
		const projects = namesIn(['playwright.config.ts'])
		const named = projectsNamedBy('playwright')
		expect(named.length).toBeGreaterThan(0)
		for (const [script, project] of named) expect(projects, `${script} names ${project}`).toContain(project)
	})
})
