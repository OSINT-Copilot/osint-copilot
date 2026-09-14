/**
 * HTML to markdown, in the main process, for captured pages.
 *
 * The repo already has `packages/tangent-html-to-markdown`, and it cannot be used here.
 * Three reasons, all verified:
 *
 *  1. Its entry point does `document.createElement('html'); frag.innerHTML = html` for any
 *     doctype-prefixed input. In main there is no `document`, so that is a ReferenceError.
 *  2. In a RENDERER it is worse than an error: assigning innerHTML on a live document
 *     starts real subresource loads -- images, stylesheets, fonts -- from the host's own
 *     session, on the operator's real address, for a page they captured precisely because
 *     they did not want to touch it again.
 *  3. Its `processedNullTargets` list omits `script`, so `__NEXT_DATA__` blobs and JSON-LD
 *     land in the middle of what is supposed to be readable evidence.
 *
 * So this calls turndown directly. Turndown's node build parses with @mixmark-io/domino,
 * which builds a DOM with no browsing context: it fetches nothing, runs nothing, and has
 * no network stack to reach. webpack targets electron-main here and therefore ignores
 * turndown's `browser` field, so the node build is what gets bundled.
 */
import TurndownService from 'turndown'

/**
 * Elements removed before conversion.
 *
 * `script` and `noscript` because their contents are not prose and are frequently
 * enormous; `style` for the same reason; `svg` because an inlined icon set turns into
 * pages of noise; `template` because its contents are not in the document the reader saw.
 * `iframe` and `object` because what they framed is not in this document either, and a
 * bare URL in the middle of evidence implies content that was never captured.
 */
const STRIPPED = ['script', 'noscript', 'style', 'svg', 'template', 'iframe', 'object', 'embed']

function createService(): TurndownService {
	const service = new TurndownService({
		headingStyle: 'atx',
		codeBlockStyle: 'fenced',
		bulletListMarker: '-',
		emDelimiter: '*',
	})

	// turndown's `remove` drops the element AND its contents, which is the point --
	// `keep` would preserve the tag, and the default behaviour for an unknown block is to
	// emit its text.
	service.remove(STRIPPED as any)

	return service
}

/** Resolves a possibly-relative URL against the page it came from. */
function absolutise(href: string, base: string | undefined): string {
	if (!base) return href
	try {
		return new URL(href, base).href
	}
	catch {
		return href
	}
}

export interface ConvertOptions {
	/**
	 * The address the HTML came from.
	 *
	 * Without it every relative link in the captured page becomes a dangling reference --
	 * evidence that cannot be followed back to what it pointed at.
	 */
	sourceUrl?: string
}

export function htmlToMarkdown(html: string, options: ConvertOptions = {}): string {
	const service = createService()

	// Rewritten rather than post-processed: doing it on the node means link text
	// containing something URL-shaped is never mistaken for the link itself.
	service.addRule('absoluteLinks', {
		filter: (node) => node.nodeName === 'A' && !!(node as HTMLAnchorElement).getAttribute('href'),
		replacement: (content, node) => {
			const href = absolutise((node as HTMLAnchorElement).getAttribute('href')!, options.sourceUrl)
			const text = content.trim()
			if (!text) return ''
			return `[${text}](${href})`
		},
	})

	service.addRule('absoluteImages', {
		filter: 'img',
		replacement: (_content, node) => {
			const element = node as HTMLImageElement
			const src = element.getAttribute('src')
			if (!src) return ''
			const alt = element.getAttribute('alt') ?? ''
			return `![${alt}](${absolutise(src, options.sourceUrl)})`
		},
	})

	return service.turndown(html ?? '').trim() + '\n'
}
