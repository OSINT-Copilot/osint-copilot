// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

import { describe, expect, it, vi } from 'vitest';
import type { PanelRequest, Reply } from '../src/shared/messages';
import { createRouter } from '../src/sw/messages';

const ID = 'eokeefakkjidnblbahcdjobcpallgnfk';
const ORIGIN = `chrome-extension://${ID}/`;

function route(message: unknown, sender: chrome.runtime.MessageSender) {
	const handle = vi.fn(async (_r: PanelRequest): Promise<Reply> => ({ ok: false, error: 'x', message: 'handled' }));
	const router = createRouter({ runtimeId: ID, extensionOrigin: ORIGIN, handle });
	const sendResponse = vi.fn();
	const keepOpen = router(message, sender, sendResponse);
	return { handle, sendResponse, keepOpen };
}

const panel: chrome.runtime.MessageSender = { id: ID, url: `${ORIGIN}sidepanel.html`, origin: `chrome-extension://${ID}` };
const contentScript: chrome.runtime.MessageSender = {
	id: ID,
	url: 'https://evil.example/page',
	origin: 'https://evil.example',
	tab: { id: 7 } as chrome.tabs.Tab,
	frameId: 0,
};

describe('message router', () => {
	it('serves our side panel', async () => {
		const { handle, sendResponse, keepOpen } = route({ type: 'state' }, panel);
		expect(keepOpen).toBe(true);
		await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
		expect(handle).toHaveBeenCalledWith({ type: 'state' });
	});

	it.each(['pair', 'state', 'send', 'queue.retry', 'queue.delete', 'selectWorkspace', 'unpair'])(
		'refuses %s from a content script, and tells it nothing',
		type => {
			const { handle, sendResponse, keepOpen } = route({ type, pairingString: 'x', bundleId: 'y' }, contentScript);
			expect(handle).not.toHaveBeenCalled();
			expect(keepOpen).toBe(false);
			expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'forbidden', message: 'Not available to page scripts.' });
		},
	);

	it('ignores another extension entirely', () => {
		const foreign = { id: 'abcdefghijklmnopabcdefghijklmnop', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html' };
		const { handle, sendResponse, keepOpen } = route({ type: 'state' }, foreign);
		expect(handle).not.toHaveBeenCalled();
		expect(sendResponse).not.toHaveBeenCalled();
		expect(keepOpen).toBe(false);
	});

	it('refuses a sender whose origin disagrees with its URL', () => {
		const odd = { ...panel, origin: 'https://evil.example' };
		const { handle } = route({ type: 'state' }, odd);
		expect(handle).not.toHaveBeenCalled();
	});

	it('refuses a sender with no URL', () => {
		const { handle } = route({ type: 'state' }, { id: ID });
		expect(handle).not.toHaveBeenCalled();
	});

	it('leaves unknown message types unanswered', () => {
		const { handle, sendResponse, keepOpen } = route({ type: 'exfiltrate' }, panel);
		expect(handle).not.toHaveBeenCalled();
		expect(sendResponse).not.toHaveBeenCalled();
		expect(keepOpen).toBe(false);
	});
});
