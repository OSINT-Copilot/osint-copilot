/**
 * Creating and opening canvas boards.
 *
 * Kept out of vault-ai-plugin.ts, which is already long, and out of CanvasView.svelte,
 * which should only know how to render a board it was handed.
 */
import { serializeCanvas, emptyCanvas } from './canvas-format';
import { CANVAS_FILE_TYPE } from './canvas-file-type';
import { vaultFileStore } from './canvas-runtime';
import { openIndexedVaultNode } from '../integration/open-view';
import { DEFAULT_CANVAS_FOLDER } from '../constants/vault-layout';

interface MinimalVault {
    adapter: { exists(path: string): Promise<boolean> };
}

/**
 * A path no board already occupies.
 *
 * Numbered rather than timestamped so the names stay readable, and checked against the
 * filesystem rather than the index because a board created moments ago may not have been
 * indexed yet.
 */
async function unusedPath(vault: MinimalVault, base: string): Promise<string> {
    const candidate = `${DEFAULT_CANVAS_FOLDER}/${base}${CANVAS_FILE_TYPE}`;
    if (!(await vault.adapter.exists(candidate))) return candidate;
    for (let i = 2; i < 1000; i++) {
        const next = `${DEFAULT_CANVAS_FOLDER}/${base} ${i}${CANVAS_FILE_TYPE}`;
        if (!(await vault.adapter.exists(next))) return next;
    }
    // Practically unreachable; better than looping forever or overwriting a board.
    return `${DEFAULT_CANVAS_FOLDER}/${base} ${Date.now()}${CANVAS_FILE_TYPE}`;
}

const OPEN_TIMEOUT_MS = 5000;

/**
 * Tangent indexes the vault by watching the filesystem, so a file we just wrote is not
 * immediately a node it can navigate to. Poll briefly rather than guessing a delay.
 */
async function openWhenIndexed(path: string): Promise<boolean> {
    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (openIndexedVaultNode(path)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

export interface CreateCanvasResult {
    path: string;
    opened: boolean;
}

/** Writes an empty board and navigates to it. */
export async function createCanvas(vault: MinimalVault): Promise<CreateCanvasResult> {
    const path = await unusedPath(vault, 'Board');
    await vaultFileStore().write(path, serializeCanvas(emptyCanvas()));
    return { path, opened: await openWhenIndexed(path) };
}
