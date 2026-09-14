/**
 * What a browsing pane remembers between sessions.
 *
 * Small on purpose. A pane records the address it was last showing and the title that
 * address had, and nothing else: history, capture indexes and profile bindings are later
 * phases, and inventing their schema before they exist would mean inventing it twice.
 *
 * Reads and writes are debounced the way canvas-document does, and for the same reason --
 * every write lands in the vault under Tangent's watcher, which fans a tree-change event
 * to every window.
 */
import type { CanvasFileStore } from '../canvas/canvas-document';

/** The file's contents. Anything unrecognised is preserved, so an older app does not eat newer fields. */
export interface BrowseDocument {
	url?: string;
	title?: string;
	/**
	 * Which identity this pane browses as.
	 *
	 * Kept in the file so a restored pane comes back as the same profile it was. A pane
	 * that reopened as "default" after being used as a puppet would send that puppet's
	 * site a request from the operator's own jar -- a silent identity swap, which is the
	 * worst failure this feature has.
	 */
	profileId?: string;
	[key: string]: unknown;
}

/** Matches canvas-document's debounce; a navigation burst should not mean a write burst. */
export const SAVE_DEBOUNCE_MS = 1000;

export function parseBrowseDocument(text: string | null): BrowseDocument {
	if (!text) return {};
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as BrowseDocument
			: {};
	}
	catch {
		// A corrupt file should not lose the pane; it should lose the remembered address.
		return {};
	}
}

export function serializeBrowseDocument(doc: BrowseDocument): string {
	return JSON.stringify(doc, null, '\t') + '\n';
}

export class BrowseDocumentStore {
	private doc: BrowseDocument = {};
	private timer: ReturnType<typeof setTimeout> | null = null;
	private dirty = false;
	/**
	 * Until the first load resolves, nothing may be written.
	 *
	 * A lens can be constructed while a session is being restored, before the vault
	 * adapter exists. Writing then would put an empty document over a real one -- the same
	 * trap canvas-runtime's read() documents, approached from the other side.
	 */
	private loaded = false;

	constructor(
		private readonly path: string,
		private readonly files: CanvasFileStore,
	) {}

	async load(): Promise<BrowseDocument> {
		const text = await this.files.read(this.path);
		this.doc = parseBrowseDocument(text);
		this.loaded = true;
		return this.doc;
	}

	get value(): BrowseDocument {
		return this.doc;
	}

	/** Records where the pane is now. No-op when nothing actually changed. */
	record(url: string | undefined, title: string | undefined): void {
		const nextUrl = url && url !== 'about:blank' ? url : undefined;
		if (this.doc.url === nextUrl && this.doc.title === title) return;
		this.doc = { ...this.doc, url: nextUrl, title };
		this.dirty = true;
		this.schedule();
	}

	/** Binds the pane to an identity. */
	recordProfile(profileId: string): void {
		if (this.doc.profileId === profileId) return;
		this.doc = { ...this.doc, profileId };
		this.dirty = true;
		this.schedule();
	}

	private schedule(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.flush(); }, SAVE_DEBOUNCE_MS);
	}

	/** Writes now if there is anything pending. Called on pane teardown. */
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (!this.dirty || !this.loaded) return;
		this.dirty = false;
		await this.files.write(this.path, serializeBrowseDocument(this.doc));
	}
}
