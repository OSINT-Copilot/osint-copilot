/**
 * Creating and opening browsing panes.
 *
 * Mirrors canvas-commands.ts, including the two things that are easy to get wrong: a name
 * that does not collide with an existing file, and waiting for Tangent to index the file
 * before trying to navigate to it.
 */
import { BROWSE_FILE_TYPE } from './browse-file-type';
import { serializeBrowseDocument, type BrowseDocument } from './browse-document';
import { vaultFileStore } from '../canvas/canvas-runtime';
import { openIndexedVaultNode } from '../integration/open-view';
import { DEFAULT_BROWSING_FOLDER } from '../constants/vault-layout';

interface MinimalVault {
	adapter: { exists(path: string): Promise<boolean> };
}

/**
 * A path no pane already occupies.
 *
 * Checked against the filesystem rather than the index, because a pane created moments
 * ago may not have been indexed yet.
 */
async function unusedPath(vault: MinimalVault, base: string): Promise<string> {
	const candidate = `${DEFAULT_BROWSING_FOLDER}/${base}${BROWSE_FILE_TYPE}`;
	if (!(await vault.adapter.exists(candidate))) return candidate;
	for (let i = 2; i < 1000; i++) {
		const next = `${DEFAULT_BROWSING_FOLDER}/${base} ${i}${BROWSE_FILE_TYPE}`;
		if (!(await vault.adapter.exists(next))) return next;
	}
	return `${DEFAULT_BROWSING_FOLDER}/${base} ${Date.now()}${BROWSE_FILE_TYPE}`;
}

/**
 * Tangent indexes by watching the filesystem, so a file just written is not yet a node it
 * can navigate to. Poll briefly rather than guessing a delay.
 */
async function openWhenIndexed(path: string, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (openIndexedVaultNode(path)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
}

export interface CreateBrowsePaneResult {
	path: string;
	opened: boolean;
}

/** Writes a pane and navigates to it. */
export async function createBrowsePane(
	vault: MinimalVault, name = 'Browsing', document: BrowseDocument = {},
): Promise<CreateBrowsePaneResult> {
	const path = await unusedPath(vault, name);
	await vaultFileStore().write(path, serializeBrowseDocument(document));
	return { path, opened: await openWhenIndexed(path) };
}

/**
 * Opens one pane per pivot destination.
 *
 * Each carries the address but does NOT load it: a pane whose document has a url comes up
 * parked. So a fan-out costs nothing until the analyst opens one, and the selected value
 * has not been handed to any of these sites merely by asking what could be asked.
 *
 * `openedBy` records what the pivot came from, so a pane four steps into an investigation
 * still says which value on which page produced it.
 */
export async function fanOut(
	vault: MinimalVault,
	value: string,
	targets: Array<{ pivotId: string, label: string, url: string }>,
	from: { url: string, profileId?: string },
): Promise<CreateBrowsePaneResult[]> {
	const results: CreateBrowsePaneResult[] = [];
	for (const target of targets) {
		// Named after the destination rather than the value: a thread of eight panes all
		// called "ada-lovelace" is unreadable, and the value is in the document anyway.
		const name = `${target.label} — ${value}`.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
		results.push(await createBrowsePane(vault, name, {
			url: target.url,
			profileId: from.profileId,
			openedBy: {
				value,
				pivotId: target.pivotId,
				fromUrl: from.url,
				at: new Date().toISOString(),
			},
		}));
	}
	return results;
}
