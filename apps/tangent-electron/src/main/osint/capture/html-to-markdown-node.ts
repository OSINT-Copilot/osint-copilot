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
 * turndown's `browser` field, so the node build is what gets bundled. It runs in the
 * capture worker (derive-worker.ts), never on main's own thread: a 50 MB page is seconds
 * of synchronous work.
 *
 * The output must be INERT when the analyst opens it in the app. Tangent turns
 * `![alt](url)` and `![[name]]` into embeds that load when the note is viewed, and it
 * renders HTML tags written in a note. Either, in text a hostile page chose, would make
 * the app fetch the target's tracker every time the analyst reads their own evidence. It
 * also embeds a bare URL: one alone on its line (rawLinksAutoEmbed is on by default, and a
 * list item counts) and `!https://...` anywhere. So: images become plain links
 * (`[image: alt](url)`), which load nothing until clicked; any `![` left in the output
 * (page text, code, alt text) is escaped; every `://` outside a link target this module
 * wrote is escaped, so page text never forms a raw URL; anything that could open a tag is
 * written as `&lt;`; and only http(s) and mailto targets are ever emitted as links.
 */
import { randomUUID } from 'crypto'
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
const STRIPPED = [
	'script', 'noscript', 'style', 'svg', 'template', 'iframe', 'object', 'embed',
	// Not the page's text, and <head> would otherwise put the <title> above the body.
	'head', 'title', 'meta', 'link', 'base',
]

/**
 * Link targets worth keeping: http(s), mailto, and a relative reference left unresolved
 * because there was no page address. Anything else (javascript:, data:, blob:, file:) is
 * dropped.
 */
const LINKABLE = /^((https?|mailto):|(?![a-z][a-z0-9+.-]*:))/i

/**
 * The last word on inertness, applied to the whole output: whatever produced it (text,
 * code, alt text, a URL), no embed and no tag survives.
 *
 * - `![` becomes `!\[`, which Tangent shows as text. That covers `![[name]]` too.
 * - `://` becomes `:\/\/`. Tangent's raw-link parser starts at `://`, so without it no
 *   bare URL exists to embed, alone on a line or after a `!`. Deciding where page text
 *   ends and code begins would mean predicting Tangent's parser; escaping everywhere does
 *   not, at the price of backslashes in a URL quoted in code.
 * - `<` followed by what could start a tag, comment or declaration becomes `&lt;`.
 *
 * `schemeToken` is what the link rules wrote in place of `://` in the targets they
 * emitted; it is restored last, so those, and only those, stay followable links. It is
 * random per conversion, so no page can spell it.
 */
function neutralise(markdown: string, schemeToken?: string): string {
	const out = markdown
		.replace(/!\[/g, '!\\[')
		.replace(/:\/\//g, ':\\/\\/')
		.replace(/<(?=[A-Za-z/!?])/g, '&lt;')
	return schemeToken ? out.split(schemeToken).join('://') : out
}

/** A URL safe to put inside `(...)`: no spaces, no parentheses, no angle brackets. */
function linkTarget(href: string, schemeToken: string): string {
	return href
		.replace(/[\s()<>]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
		.split('://').join(schemeToken)
}

/** Square brackets in link or alt text, escaped so they cannot close the link early. */
function bracketText(text: string): string {
	return text.replace(/[\[\]\\]/g, c => '\\' + c).replace(/\s+/g, ' ').trim()
}

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
	// Stands in for `://` in the targets written below, until neutralise() has escaped
	// every other one. Letters and digits only, so turndown never escapes it.
	const schemeToken = 'osintscheme' + randomUUID().replace(/-/g, '')

	// Rewritten rather than post-processed: doing it on the node means link text
	// containing something URL-shaped is never mistaken for the link itself.
	service.addRule('absoluteLinks', {
		filter: (node) => node.nodeName === 'A' && !!(node as HTMLAnchorElement).getAttribute('href'),
		replacement: (content, node) => {
			const href = absolutise((node as HTMLAnchorElement).getAttribute('href')!, options.sourceUrl)
			const text = content.trim()
			if (!text) return ''
			// A javascript: or data: target is not somewhere evidence can point; keep the words.
			if (!LINKABLE.test(href)) return text
			return `[${text}](${linkTarget(href, schemeToken)})`
		},
	})

	// A link, never an embed: an embedded image loads when the note is viewed, which
	// would tell the site that its page is being read, from the analyst's own address.
	service.addRule('imagesAsLinks', {
		filter: 'img',
		replacement: (_content, node) => {
			const element = node as HTMLImageElement
			const alt = bracketText(element.getAttribute('alt') ?? '')
			const label = alt ? `image: ${alt}` : 'image'
			const src = element.getAttribute('src')
			const href = src ? absolutise(src, options.sourceUrl) : ''
			// Inline data: images would be kilobytes of base64 in the text; say it was there.
			if (!href || !LINKABLE.test(href)) return `[${label}]`
			return `[${label}](${linkTarget(href, schemeToken)})`
		},
	})

	return neutralise(service.turndown(html ?? '').trim(), schemeToken) + '\n'
}
