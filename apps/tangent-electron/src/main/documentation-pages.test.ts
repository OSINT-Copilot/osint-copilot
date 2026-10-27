import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

// The ? button on each settings page opens Configuration/<page> in the documentation
// window. A page with no file there opens as a new, empty note instead.
const systemMenu = path.join(__dirname, '../app/views/System/System.svelte')
const configurationDocs = path.join(__dirname, '../../../../Documentation/Configuration')

/** Each menu entry's documentation page, unless it opts out with `documentation: false`. */
function documentedPages(source: string): string[] {
	const script = source.slice(0, source.indexOf('</script>'))
	const pages: string[] = []
	for (const entry of script.matchAll(/\{([^{}]*)\}/g)) {
		const name = /\bname:\s*'([^']+)'/.exec(entry[1])
		if (!name) continue
		const documentation = /\bdocumentation:\s*(false|'([^']+)')/.exec(entry[1])
		if (documentation?.[1] === 'false') continue
		pages.push(documentation?.[2] ?? name[1])
	}
	return pages
}

describe('System menu documentation', () => {
	const pages = documentedPages(fs.readFileSync(systemMenu, 'utf8'))

	it('Should find the menu entries', () => {
		expect(pages).toContain('Appearance')
		expect(pages).toContain('OSINT Copilot')
		expect(pages).not.toContain('About')
	})

	it.each(pages)('Should have a page for %s', page => {
		expect(fs.existsSync(path.join(configurationDocs, page + '.md'))).toBe(true)
	})
})
