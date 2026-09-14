/**
 * Promoting a captured page into the entity graph.
 *
 * This is the join that Ostium does not have: its Investigation Board is a standalone JSON
 * whiteboard that does not know the browser exists. Here a capture becomes an `Evidence`
 * entity in the same vault, on the same graph, carrying the same provenance shape as
 * everything else -- so a page read in a pane and a fact extracted by the agent are the
 * same kind of thing to the rest of the app.
 *
 * Promotion is an ACT, not a side effect of capturing. An armed profile writes archives
 * and an index line and stops; one entity per capture would make the graph unreadable
 * inside an hour of real browsing.
 */
import { EntityType, type Entity, type OsintSourceInput } from '../entities/types';

export interface PromotableCapture {
	url: string;
	title: string;
	capturedAt: string;
	sha256: string;
	files: { mhtml: string, markdown: string, screenshot?: string };
}

/**
 * Two source records, deliberately.
 *
 * The live URL is what `wayback-archive-service.ts` needs in order to resolve an Internet
 * Archive snapshot in the background -- a second, independent attestation nobody here
 * controls. The `vault://` path is the one that still works when the page is gone, the
 * site is hostile, or the operator is offline. Either alone loses something the other has.
 */
export function sourcesForCapture(capture: PromotableCapture): OsintSourceInput[] {
	return [
		{
			source_url: capture.url,
			inferred: false,
			rationale: 'Captured in a browsing pane.',
			captured_at: capture.capturedAt,
		},
		{
			source_url: `vault://${capture.files.mhtml}`,
			inferred: false,
			rationale: `Local MHTML archive of the page as it rendered. sha256 ${capture.sha256}. `
				+ 'Attests that the archive has not changed since capture; it is not a record of '
				+ 'what the server sent.',
			captured_at: capture.capturedAt,
		},
	];
}

interface EntityManagerLike {
	createEntity(
		type: EntityType,
		properties: Record<string, unknown>,
		options?: {
			skipAutoGeocode?: boolean;
			osint_sources?: OsintSourceInput[];
			osint_captured_at?: string;
		},
	): Promise<Entity>;
}

/**
 * Creates the Evidence entity for a capture.
 *
 * Follows handleGraphFileDrop in graph-view.ts, which is the existing path for "a file in
 * the vault becomes an Evidence entity" -- same type, same filePath property, so a
 * captured page and a dropped PDF look the same to the graph.
 */
export async function promoteCapture(
	entityManager: EntityManagerLike, capture: PromotableCapture,
): Promise<Entity> {
	const name = capture.title?.trim() || capture.url;
	return entityManager.createEntity(
		EntityType.Evidence,
		{
			name,
			// The markdown, not the archive: this is the one a person can read in the app.
			filePath: capture.files.markdown,
			description: `Web page captured ${capture.capturedAt} from ${capture.url}`,
			url: capture.url,
			sha256: capture.sha256,
		},
		{
			skipAutoGeocode: true,
			osint_sources: sourcesForCapture(capture),
			osint_captured_at: capture.capturedAt,
		},
	);
}

export interface PromotableHit {
	match: string;
	label: string;
	context: string;
	entityType?: string;
	page: { url: string, title: string, capturedAt?: string };
}

/**
 * Creates an entity from a watchlist hit.
 *
 * Marked `inferred: true` and left at `unverified` confidence on purpose. A selector hit
 * says "this string appeared on this page" and nothing more -- not that it is true, not
 * that it belongs to the target. The rationale carries the surrounding text so the next
 * person to read the note can judge it without going back to the page.
 */
export async function promoteHit(
	entityManager: EntityManagerLike, hit: PromotableHit,
): Promise<Entity> {
	const capturedAt = hit.page.capturedAt ?? new Date().toISOString();
	const type = (hit.entityType as EntityType) ?? EntityType.Text;
	return entityManager.createEntity(
		type,
		{ name: hit.match, title: hit.match, description: `Found on ${hit.page.url}` },
		{
			skipAutoGeocode: true,
			osint_captured_at: capturedAt,
			osint_sources: [{
				source_url: hit.page.url,
				inferred: true,
				rationale: `Watchlist "${hit.label}" matched on a page opened in a browsing pane. `
					+ `Context: ${hit.context}`,
				captured_at: capturedAt,
			}],
		},
	);
}
