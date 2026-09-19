/**
 * Which notes' links may be previewed from the network.
 *
 * Tangent previews an external link by having main fetch the target (link-preview-js,
 * main/messages/urlData.ts) as soon as the link is hovered or embedded. In an
 * investigation that is a request to the investigated site, from the analyst's own
 * address, triggered by nothing more than a mouse passing over a link: the site learns
 * someone is looking, and when.
 *
 * The notes that hold investigated pages are exactly the ones full of such links: a
 * capture's markdown and the page's Sources note (OSINTCopilot/Evidence/ and
 * OSINTCopilot/Sources/, both written by inbox-service.ts). Their links are shown as the
 * plain URL instead, and fetched only when the analyst chooses to open one.
 *
 * Matched on path segments anywhere in the note's path (an absolute path in the
 * renderer, a vault-relative one elsewhere). Matching a folder that merely has the same
 * name under some other root only turns previews off there too, which is the safe way to
 * be wrong.
 */
import { OSINT_COPILOT_VAULT_ROOT } from '../constants/vault-layout'

const INVESTIGATED_PAGE_FOLDERS = new Set(['Evidence', 'Sources'])

/** The value a suppressed preview resolves to: the plain URL is shown, nothing fetched. */
export const PREVIEW_SUPPRESSED_MESSAGE = 'Previews are off for notes that hold investigated pages, so hovering a link does not contact the site.'

/** Whether a link in the note at `notePath` must not be previewed from the network. */
export function linkPreviewSuppressedFor(notePath: string | null | undefined): boolean {
	if (!notePath) return false
	const segments = notePath.split(/[\\/]+/)
	// Up to the last segment only: the note itself lives inside the folder.
	for (let i = 0; i < segments.length - 2; i++) {
		if (segments[i] === OSINT_COPILOT_VAULT_ROOT && INVESTIGATED_PAGE_FOLDERS.has(segments[i + 1])) return true
	}
	return false
}
