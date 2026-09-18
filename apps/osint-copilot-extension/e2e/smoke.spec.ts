// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The built extension in a real Chromium, against the desktop app's real server and inbox
 * running under node over a throwaway workspace (the app's extension-harness.ts, with the
 * pairing confirm answered yes). It pairs from the side panel, picks the investigation,
 * sends a note and an entity, and checks both bundles landed in the workspace's
 * .osint-inbox/pending with MACs that verify. It also checks that an ordinary web page
 * cannot read the app's port.
 *
 * The side panel is opened as a tab (chrome-extension://<id>/sidepanel.html), since
 * Playwright cannot click the toolbar button that opens the real panel. The panel attaches
 * items to the active tab of its window, so the web page is brought to the front before
 * sending; the page is served from 127.0.0.1, which the extension's host permission lets
 * it see without an activeTab grant.
 *
 * Runs headless: Chrome for Testing loads unpacked extensions in its new headless mode.
 * Set OC_E2E_HEADED=1 to watch it, and OC_E2E_CHROMIUM to use another Chromium binary.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startExtensionHarness, type ExtensionHarness } from '../../tangent-electron/src/main/osint/inbox/extension-harness';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');

/**
 * The Chromium to launch: OC_E2E_CHROMIUM, else the one this Playwright was built for,
 * else the newest Chromium in Playwright's cache (a different Playwright may have put it
 * there; any recent Chromium can load an unpacked extension).
 */
function chromiumPath(): string | undefined {
	if (process.env.OC_E2E_CHROMIUM) return process.env.OC_E2E_CHROMIUM;
	if (fs.existsSync(chromium.executablePath())) return undefined;
	const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), '.cache', 'ms-playwright');
	const found = (fs.existsSync(cache) ? fs.readdirSync(cache) : [])
		.map(name => /^chromium-(\d+)$/.exec(name))
		.filter((m): m is RegExpExecArray => m !== null)
		.sort((a, b) => Number(b[1]) - Number(a[1]))
		.map(m => path.join(cache, m[0], 'chrome-linux64', 'chrome'))
		.find(p => fs.existsSync(p));
	return found;
}

/** An ordinary web page on another 127.0.0.1 port, standing in for any site the user visits. */
function startWebsite(): Promise<{ url: string; close(): Promise<void> }> {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end('<!doctype html><title>Profile of alice</title><p>Contact: alice@example.com</p>');
	});
	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => resolve({
			url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/profile/alice`,
			close: () => new Promise<void>(done => server.close(() => done())),
		}));
	});
}

let harness: ExtensionHarness;
let website: { url: string; close(): Promise<void> };
let context: BrowserContext;
let profile: string;

test.beforeAll(async () => {
	if (!fs.existsSync(path.join(dist, 'manifest.json'))) throw new Error(`No build in ${dist}: run "npm run e2e", which builds first.`);
	harness = await startExtensionHarness();
	website = await startWebsite();
	profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-e2e-profile-'));
	context = await chromium.launchPersistentContext(profile, {
		executablePath: chromiumPath(),
		headless: process.env.OC_E2E_HEADED !== '1',
		args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
	});
});

test.afterAll(async () => {
	await context?.close();
	await website?.close();
	await harness?.stop();
	if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

async function extensionId(): Promise<string> {
	const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
	const id = new URL(worker.url()).host;
	expect(id).toMatch(/^[a-p]{32}$/);
	return id;
}

async function pendingCount(): Promise<number> {
	return (await harness.pending()).length;
}

test('pairs from the side panel and sends a note and an entity into the investigation', async () => {
	const id = await extensionId();
	const site = await context.newPage();
	await site.goto(website.url);
	const panel: Page = await context.newPage();
	await panel.goto(`chrome-extension://${id}/sidepanel.html`);
	await expect(panel.locator('#connection')).toHaveText('Not paired');

	// Pair: paste the string the app shows. The harness answers the app's confirm dialog.
	await panel.fill('#pair-input', await harness.pairingString());
	await panel.click('#pair-form button[type=submit]');
	await expect(panel.locator('#connection')).toHaveText('Connected');
	expect(harness.confirmed).toEqual([`chrome-extension://${id}`]);

	// Pick the investigation. It is the only one open, so the panel has chosen it already;
	// choosing it by hand as a user would must leave it chosen.
	const workspace = panel.locator('#workspace');
	await expect(workspace.locator('option', { hasText: 'Case Alpha' })).toHaveCount(1);
	const workspaceId = await workspace.locator('option', { hasText: 'Case Alpha' }).getAttribute('value');
	await workspace.selectOption(workspaceId!);
	await expect(panel.locator('#workspace-current')).toHaveText('To: Case Alpha');

	// Items attach to the active tab of the panel's window: make that the web page.
	// The panel follows tab activation (tabs.onActivated) and shows the page it will use.
	await site.bringToFront();
	await expect(panel.locator('#page .page-url')).toHaveText(website.url);

	await panel.fill('#note-text', 'Seen on the profile page.\nSecond line.');
	await panel.click('#note-form button[type=submit]');
	await expect.poll(pendingCount, { timeout: 15_000 }).toBe(1);

	await panel.fill('#entity-value', 'alice@example.com');
	await expect(panel.locator('#entity-kind')).toHaveValue('email');
	await panel.fill('#entity-context', 'Contact line');
	await panel.click('#entity-form button[type=submit]');
	await expect.poll(pendingCount, { timeout: 15_000 }).toBe(2);

	const bundles = await harness.pending();
	for (const bundle of bundles) expect(bundle.macOk, `mac of ${bundle.bundleId}`).toBe(true);
	const stored = bundles.map(b => b.stored as Record<string, any>);
	const note = stored.find(s => s.kind === 'note');
	const entity = stored.find(s => s.kind === 'entity');
	expect(note).toMatchObject({
		workspaceId,
		page: { url: website.url, title: 'Profile of alice' },
		note: { text: 'Seen on the profile page.\nSecond line.' },
		server: { origin: `chrome-extension://${id}`, extVersion: expect.any(String) },
	});
	expect(entity).toMatchObject({
		workspaceId,
		page: { url: website.url, title: 'Profile of alice' },
		entity: { kind: 'email', value: 'alice@example.com', context: 'Contact line' },
	});

	// Both delivered, so the extension's queue is empty again.
	await expect(panel.locator('#queue li.hint')).toBeVisible();
});

test('an ordinary web page cannot read the app\'s port', async () => {
	const site = await context.newPage();
	await site.goto(website.url);
	const status = `http://127.0.0.1:${harness.port}/v1/status`;
	const result = await site.evaluate(async url => {
		const attempt = async (init: RequestInit) => {
			try {
				const res = await fetch(url, init);
				return { type: res.type, status: res.status, text: await res.text() };
			} catch (err) {
				return { rejected: String(err) };
			}
		};
		return {
			// A simple GET: sent, but no Access-Control-* header ever comes back.
			cors: await attempt({}),
			// With the protocol header: the preflight OPTIONS gets 403.
			preflighted: await attempt({ headers: { 'X-OC-Proto': '1' } }),
			// no-cors: an opaque response, with nothing readable in it.
			opaque: await attempt({ mode: 'no-cors' }),
		};
	}, status);
	expect(result.cors).toEqual({ rejected: expect.stringContaining('Failed to fetch') });
	expect(result.preflighted).toEqual({ rejected: expect.stringContaining('Failed to fetch') });
	expect(result.opaque).toEqual({ type: 'opaque', status: 0, text: '' });
});
