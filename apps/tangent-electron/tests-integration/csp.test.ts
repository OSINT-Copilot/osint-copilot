import { test, expect } from './tangent'
import fs from 'fs'
import path from 'path'

/**
 * The Content-Security-Policy, checked against what the app actually renders.
 *
 * It is added for the renderer's sake, not the guests': that renderer holds window.api,
 * which reaches vault writes and cli.exec, and it displays markdown, LLM output and text
 * pulled out of pages under investigation. Without a policy, an injection that survives
 * DOMPurify runs with all of it.
 *
 * The risk of adding one is silent breakage in an upstream-owned file, and the two most
 * likely victims are Prism (syntax highlighting) and KaTeX (math) -- both inject markup
 * and styles at runtime. So this exercises a note containing both and fails on any
 * violation, rather than trusting that the policy was written correctly.
 */

const NOTE = `# CSP probe

Some \`inline code\` and a fenced block:

\`\`\`yaml
key: value
list:
  - one
  - two
\`\`\`

Block math:

$$
\\\\sum_{i=1}^{n} i = \\\\frac{n(n+1)}{2}
$$

And inline math, $E = mc^2$, in a sentence.
`

test('rendering a note with code and math raises no CSP violations', async ({ tangent, workspace }) => {
	const window = await tangent.firstWindow()

	const violations: string[] = []
	window.page.on('console', message => {
		const text = message.text()
		if (/Refused to|Content Security Policy/i.test(text)) violations.push(text)
	})
	window.page.on('pageerror', error => violations.push(`pageerror: ${error.message}`))

	fs.writeFileSync(path.join(workspace, 'CSP Probe.md'), NOTE)

	await expect.poll(
		() => window.page.evaluate(
			(p: string) => !!(document as any).workspace?.directoryStore?.get(p),
			path.join(workspace, 'CSP Probe.md')),
		{ timeout: 10_000 }).toBe(true)

	await window.setThread({ paths: ['CSP Probe.md'] })

	// Prism rewrites the code block and KaTeX replaces the math; both are asserted so a
	// silent "nothing rendered, so nothing was refused" cannot pass.
	await expect(window.page.locator('.katex').first()).toBeVisible({ timeout: 10_000 })
	await expect(window.page.locator('code .token, pre .token').first())
		.toBeVisible({ timeout: 10_000 })

	expect(violations, `CSP violations while rendering:\n${violations.join('\n')}`).toEqual([])
})

test('the policy is actually in force', async ({ tangent }) => {
	const window = await tangent.firstWindow()

	// A policy that is present but unenforced is worse than none: it reads as protection.
	// Inline script is the specific thing it exists to stop.
	const ran = await window.page.evaluate(() => {
		(globalThis as any).__cspProbe = false
		const script = document.createElement('script')
		script.textContent = '(globalThis).__cspProbe = true'
		document.body.appendChild(script)
		const result = (globalThis as any).__cspProbe
		script.remove()
		return result
	})

	expect(ran, 'an injected inline <script> executed').toBe(false)
})
