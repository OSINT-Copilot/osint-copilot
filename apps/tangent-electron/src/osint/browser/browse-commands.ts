/**
 * Creating and opening browsing panes.
 *
 * Mirrors canvas-commands.ts, including the two things that are easy to get wrong: a name
 * that does not collide with an existing file, and waiting for Tangent to index the file
 * before trying to navigate to it.
 */
import { BROWSE_FILE_TYPE } from './browse-file-type';
import { serializeBrowseDocument } from './browse-document';
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

/** Writes an empty pane and navigates to it. */
export async function createBrowsePane(
	vault: MinimalVault, name = 'Browsing',
): Promise<CreateBrowsePaneResult> {
	const path = await unusedPath(vault, name);
	await vaultFileStore().write(path, serializeBrowseDocument({}));
	return { path, opened: await openWhenIndexed(path) };
}
