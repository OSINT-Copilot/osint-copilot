// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/** The panel's only way to the app: a message to the service worker, which holds the key. */
import type { PanelRequest, Reply } from '../shared/messages';

export async function ask(request: PanelRequest): Promise<Reply> {
	try {
		const reply = (await chrome.runtime.sendMessage(request)) as Reply | undefined;
		if (reply && typeof reply === 'object' && 'ok' in reply) return reply;
		return { ok: false, error: 'internal', message: 'The extension\'s background worker did not answer. Try reopening the panel.' };
	} catch (err) {
		return { ok: false, error: 'internal', message: err instanceof Error ? err.message : String(err) };
	}
}
