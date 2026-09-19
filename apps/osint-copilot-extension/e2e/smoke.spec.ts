// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * The built extension in a real Chromium, against the desktop app's real server and inbox
 * running under node over a throwaway workspace (the app's extension-harness.ts, with the
 * pairing confirm answered yes). It pairs from the side panel, picks the investigation,
 * sends a note and an entity, and checks both bundles landed in the workspace's
 * .osint-inbox/pending with MACs that verify. It captures a page the same way, through
 * the three-step upload, and checks the committed archive's digest. It also checks that an ordinary web page
 * cannot read the app's port. It makes highlights, and checks when they are shown again:
 * on a revisit only once allowed, on request otherwise, and on a single-page site never
 * for an address the page moved to by itself.
 *
 * The side panel is opened as a tab (chrome-extension://<id>/sidepanel.html), since
 * Playwright cannot click the toolbar button that opens the real panel. The panel attaches
 * items to the active tab of its window, so the web page is brought to the front before
 * sending; the page is served from 127.0.0.1, which the extension's host permission lets
 * it see without an activeTab grant.
 *
 * Runs headless: Chrome for Testing loads unpacked extensions in its new headless mode.
 * Set OC_E2E_HEADED=1 to watch it, and OC_E2E_CHROMIUM to use another Chromium binary.
 *
 * Page capture needs pageCapture and <all_urls>, which the real manifest makes optional
 * and asks for with chrome.permissions.request. Chrome answers that with a browser dialog
 * Playwright cannot reach (it stays pending, headless or not, and no command-line switch
 * accepts it), so the capture test loads a copy of the build whose manifest grants the two
 * at install instead. The request the panel makes then resolves true without a prompt,
 * as it does for a user who allowed it before; everything after it is the shipped code.
 * The request itself, and a refusal, are covered by the unit tests (test/capture.test.ts).
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { startExtensionHarness, type ExtensionHarness } from '../../tangent-electron/src/main/osint/inbox/extension-harness';

const here = path.dirname(fileURLToPath(import.meta.url));
// OC_E2E_DIST tests another build, e.g. the unzipped store package (which has no dev key).
const dist = process.env.OC_E2E_DIST ? path.resolve(process.env.OC_E2E_DIST) : path.resolve(here, '../dist');

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
const ARTICLE = '<!doctype html><title>Leak report</title><h1>Leak report</h1><p>Wallet 0x52908400098527886E0F7030069857D2E4169EE7 was seen on the forum.</p>';

/**
 * A single-page site: one document for both addresses, whose links change the address
 * with history.pushState and redraw, as React or Vue routers do.
 */
const SPA = `<!doctype html><title>Single page</title><main id="view"></main>
<a id="to-one" href="/spa">One</a> <a id="to-two" href="/spa/two">Two</a>
<script>
const views = { '/spa': 'Page one mentions nobody in particular.', '/spa/two': 'Page two names Northgate Freight as the shipper.' };
function draw() { document.getElementById('view').innerHTML = '<p>' + views[location.pathname] + '</p>'; }
document.addEventListener('click', (e) => {
	const a = e.target.closest('a');
	if (!a) return;
	e.preventDefault();
	history.pushState(null, '', a.getAttribute('href'));
	draw();
});
addEventListener('popstate', draw);
draw();
</script>`;

/** A page whose text the highlight test changes between visits. */
const STORY_TEXT = 'Transfers were routed through Brightwater Holdings before reaching the second account.';
let story = STORY_TEXT;

function startWebsite(): Promise<{ url: string; origin: string; close(): Promise<void> }> {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		if (req.url === '/spa' || req.url === '/spa/two') {
			res.end(SPA);
			return;
		}
		if (req.url === '/story') {
			res.end(`<!doctype html><title>Story</title><h1>Story</h1><p>Intro paragraph.</p><p>${story}</p>`
				+ '<p id="hidden">Alice paid <span style="display:none">no money to </span>Bob in cash.</p>');
			return;
		}
		res.end(req.url === '/article' ? ARTICLE : '<!doctype html><title>Profile of alice</title><p>Contact: alice@example.com</p>');
	});
	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => resolve({
			origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/profile/alice`,
			close: () => new Promise<void>(done => server.close(() => done())),
		}));
	});
}

let harness: ExtensionHarness;
let website: { url: string; origin: string; close(): Promise<void> };
let context: BrowserContext;
let profile: string;

function launch(profileDir: string, extensionDir: string): Promise<BrowserContext> {
	return chromium.launchPersistentContext(profileDir, {
		executablePath: chromiumPath(),
		headless: process.env.OC_E2E_HEADED !== '1',
		args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
	});
}

test.beforeAll(async () => {
	if (!fs.existsSync(path.join(dist, 'manifest.json'))) throw new Error(`No build in ${dist}: run "npm run e2e", which builds first.`);
	harness = await startExtensionHarness();
	website = await startWebsite();
	profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-e2e-profile-'));
	context = await launch(profile, dist);
});

test.afterAll(async () => {
	await context?.close();
	await website?.close();
	await harness?.stop();
	if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

async function extensionId(ctx: BrowserContext = context): Promise<string> {
	const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
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

test('captures a page into the investigation: create, upload, commit', async () => {
	// The build, with the two optional permissions granted at install (see the top).
	const granted = grantedBuild(['pageCapture']);
	const captureProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-e2e-profile-'));
	const ctx = await launch(captureProfile, granted);
	try {
		const id = await extensionId(ctx);
		const site = await ctx.newPage();
		const articleUrl = `${website.origin}/article`;
		await site.goto(articleUrl);
		const panel = await ctx.newPage();
		await panel.goto(`chrome-extension://${id}/sidepanel.html`);
		await panel.fill('#pair-input', await harness.pairingString());
		await panel.click('#pair-form button[type=submit]');
		await expect(panel.locator('#connection')).toHaveText('Connected');
		await expect(panel.locator('#workspace-current')).toHaveText('To: Case Alpha');
		// Granted already, so the panel does not explain the prompt.
		await expect(panel.locator('#capture-permission')).toBeHidden();

		await site.bringToFront();
		await expect(panel.locator('#page .page-url')).toHaveText(articleUrl);
		const before = new Set((await harness.pending()).map(b => b.bundleId));
		await panel.click('#capture');
		let bundle: Awaited<ReturnType<ExtensionHarness['pending']>>[number] | undefined;
		await expect.poll(async () => {
			bundle = (await harness.pending()).find(b => !before.has(b.bundleId));
			return bundle?.stored.kind;
		}, { timeout: 30_000 }).toBe('capture').catch(async (err: Error) => {
			// Why the panel thinks it did not arrive is the useful part of this failure.
			throw new Error(`${err.message}\nThe panel said: ${await panel.locator('#capture-status').textContent()}`);
		});
		expect(bundle!.macOk).toBe(true);
		const stored = bundle!.stored as Record<string, any>;
		expect(stored).toMatchObject({
			page: { url: articleUrl, title: 'Leak report' },
			server: { origin: `chrome-extension://${id}` },
		});

		// The archive the app holds is the one the extension declared and hashed.
		const dir = path.join(harness.workspace, '.osint-inbox', 'pending', bundle!.bundleId);
		const mhtml = fs.readFileSync(path.join(dir, 'page.mhtml'));
		const digest = createHash('sha256').update(mhtml).digest('hex');
		expect(stored.capture.files['page.mhtml']).toEqual({ size: mhtml.length, sha256: digest });
		expect(stored.server.files['page.mhtml']).toEqual({ size: mhtml.length, sha256: digest });
		expect(mhtml.toString('latin1')).toMatch(/Content-Type: multipart\/related/);
		expect(mhtml.toString('latin1')).toContain('Leak report');
		// The screenshot is optional: sent only if the tab stayed in front. When sent, it too must match.
		if (stored.capture.files['viewport.png']) {
			const png = fs.readFileSync(path.join(dir, 'viewport.png'));
			expect(createHash('sha256').update(png).digest('hex')).toBe(stored.capture.files['viewport.png'].sha256);
		}
		test.info().annotations.push({ type: 'capture files', description: Object.keys(stored.capture.files).join(', ') });

		// Delivered: the panel says so, and the queue (and its stored files) is empty.
		await expect(panel.locator('#capture-status')).toHaveText('Page capture delivered to OSINT Copilot.');
		await expect(panel.locator('#queue li.hint')).toBeVisible();
	} finally {
		await ctx.close();
		fs.rmSync(captureProfile, { recursive: true, force: true });
		fs.rmSync(granted, { recursive: true, force: true });
	}
});

/**
 * Goes to a URL, once more if the browser itself aborted the navigation. Helium ships
 * uBlock Origin built in (--disable-extensions-except does not turn it off), and it holds
 * back requests until its filter lists are loaded, a second or so after launch, then
 * reloads the tabs that tried: a navigation in that window ends in ERR_ABORTED without
 * reaching the site. Chromium and Brave never do this.
 */
async function goto(page: Page, url: string): Promise<void> {
	try {
		await page.goto(url);
	} catch (err) {
		if (!String(err).includes('net::ERR_ABORTED')) throw err;
		await page.waitForLoadState();
		await page.goto(url);
	}
}

/** Selects `phrase` in the page, as a user dragging across it would. */
async function selectText(page: Page, phrase: string): Promise<void> {
	await page.evaluate((text) => {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const at = (node as Text).data.indexOf(text);
			if (at < 0) continue;
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + text.length);
			const sel = window.getSelection()!;
			sel.removeAllRanges();
			sel.addRange(range);
			return;
		}
		throw new Error(`"${text}" is not on the page`);
	}, phrase);
}

/** Selects the whole of an element's contents. */
async function selectElement(page: Page, selector: string): Promise<void> {
	await page.evaluate((sel) => {
		const range = document.createRange();
		range.selectNodeContents(document.querySelector(sel)!);
		window.getSelection()!.removeAllRanges();
		window.getSelection()!.addRange(range);
	}, selector);
}

/** What the page's highlight registry holds: the page's own scripts can see it too. */
function painted(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const out: string[] = [];
		for (const [, highlight] of CSS.highlights) for (const range of highlight as Highlight) out.push((range as Range).toString());
		return out;
	});
}

/**
 * A copy of the build whose manifest grants reading every page at install, as page capture
 * would have: permission, but not the investigator's choice to have highlights come back.
 * `extraPermissions` are granted at install too.
 */
function grantedBuild(extraPermissions: string[] = []): string {
	const granted = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-e2e-granted-'));
	fs.cpSync(dist, granted, { recursive: true });
	const manifestPath = path.join(granted, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	manifest.permissions.push(...extraPermissions);
	manifest.host_permissions.push('<all_urls>');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest));
	return granted;
}

/** Opens the panel as a tab and pairs it with the harness. */
async function pairedPanel(ctx: BrowserContext): Promise<Page> {
	const id = await extensionId(ctx);
	const panel = await ctx.newPage();
	panel.on('dialog', (d) => void d.accept());
	await panel.goto(`chrome-extension://${id}/sidepanel.html`);
	await panel.fill('#pair-input', await harness.pairingString());
	await panel.click('#pair-form button[type=submit]');
	await expect(panel.locator('#connection')).toHaveText('Connected');
	await expect(panel.locator('#workspace-current')).toHaveText('To: Case Alpha');
	return panel;
}

test('highlights a selection, files it, paints it again on a revisit, and lists it when the text is gone', async () => {
	story = STORY_TEXT;
	const granted = grantedBuild();
	const hlProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-e2e-profile-'));
	const ctx = await launch(hlProfile, granted);
	try {
		const site = await ctx.newPage();
		const storyUrl = `${website.origin}/story`;
		await goto(site, storyUrl);
		const panel = await pairedPanel(ctx);
		// The extension may read pages (as after page capture), but revisits were not allowed.
		await expect(panel.locator('#highlight-revisit')).toBeVisible();

		await site.bringToFront();
		await expect(panel.locator('#page .page-url')).toHaveText(storyUrl);
		const phrase = 'Brightwater Holdings';
		await selectText(site, phrase);
		const before = new Set((await harness.pending()).map(b => b.bundleId));
		await panel.click('#highlight-create');

		// Filed: a highlight bundle, its MAC good, its quote exactly the selection.
		let bundle: Awaited<ReturnType<ExtensionHarness['pending']>>[number] | undefined;
		await expect.poll(async () => {
			bundle = (await harness.pending()).find(b => !before.has(b.bundleId));
			return bundle?.stored.kind;
		}, { timeout: 15_000 }).toBe('highlight');
		expect(bundle!.macOk).toBe(true);
		const annotation = (bundle!.stored as Record<string, any>).highlight.annotation;
		expect(annotation.target.selector[0]).toMatchObject({ type: 'TextQuoteSelector', exact: phrase });
		expect(annotation.target.source).toBe(storyUrl);

		// Painted, with the Custom Highlight API: nothing was added to the page's DOM.
		await expect.poll(() => painted(site), { timeout: 10_000 }).toEqual([phrase]);
		expect(await site.evaluate(() => document.querySelectorAll('[class*=highlight], mark').length)).toBe(0);
		await expect(panel.locator('#highlights li .quote')).toHaveText([phrase]);

		// Not allowed to come back on its own: a reload shows nothing, although the extension
		// may read pages. Until the investigator asks, on this page.
		await site.reload();
		await expect(panel.locator('#highlight-unshown')).toBeVisible({ timeout: 10_000 });
		expect(await painted(site)).toEqual([]);
		await panel.click('#highlight-show-here');
		await expect.poll(() => painted(site), { timeout: 10_000 }).toEqual([phrase]);
		await expect(panel.locator('#highlight-unshown')).toBeHidden();
		await expect(panel.locator('#highlights li .status')).toHaveText(['On the page.']);

		// Allowed: from here on, highlights come back on their own.
		await panel.click('#highlight-grant');
		await expect(panel.locator('#highlight-revisit-on')).toBeVisible();
		await expect(panel.locator('#highlight-revisit')).toBeHidden();

		// A selection holding text the page hides is refused: the quote would not be what
		// the investigator saw. Chrome's own reading of the selection leaves hidden text out.
		await selectElement(site, '#hidden');
		const beforeHidden = (await harness.pending()).length;
		await panel.click('#highlight-create');
		await expect(panel.locator('#flash')).toContainText('hides some text');
		expect((await harness.pending()).length).toBe(beforeHidden);
		await expect(panel.locator('#highlights li')).toHaveCount(1);

		// The page's own scripts share the registry and can wipe it: the next change to the
		// page makes the painter notice and put its marks back.
		await site.evaluate(() => CSS.highlights.clear());
		expect(await painted(site)).toEqual([]);
		await site.evaluate(() => document.body.append(document.createElement('span')));
		await expect.poll(() => painted(site), { timeout: 5_000 }).toEqual([phrase]);

		// A note: an update with the whole annotation and a later modified time.
		await panel.locator('#highlights li textarea').fill('Check the registry for this company.');
		const beforeNote = new Set((await harness.pending()).map(b => b.bundleId));
		await panel.locator('#highlights li button', { hasText: 'Save note' }).click();
		await expect.poll(async () => (await harness.pending()).find(b => !beforeNote.has(b.bundleId))?.stored.kind, { timeout: 15_000 }).toBe('highlight.update');
		const update = (await harness.pending()).find(b => !beforeNote.has(b.bundleId))!.stored as Record<string, any>;
		expect(update.highlight.annotation.body.value).toBe('Check the registry for this company.');

		// A revisit: the registered content script finds it again on its own.
		await site.reload();
		await expect.poll(() => painted(site), { timeout: 10_000 }).toEqual([phrase]);

		// The page's text changes: not found, listed apart, not deleted.
		story = 'This paragraph was rewritten and no longer names the company.';
		await site.reload();
		await expect.poll(() => painted(site), { timeout: 10_000 }).toEqual([]);
		await expect(panel.locator('#orphans li .quote')).toHaveText([phrase], { timeout: 10_000 });
		await expect(panel.locator('#orphans-title')).toBeVisible();

		// Deleted: a delete bundle, and gone from the panel.
		const beforeDelete = new Set((await harness.pending()).map(b => b.bundleId));
		await panel.locator('#orphans li button', { hasText: 'Delete' }).click();
		await expect.poll(async () => (await harness.pending()).find(b => !beforeDelete.has(b.bundleId))?.stored.kind, { timeout: 15_000 }).toBe('highlight.delete');
		await expect(panel.locator('#orphans li')).toHaveCount(0);
	} finally {
		story = STORY_TEXT;
		await ctx.close();
		fs.rmSync(hlProfile, { recursive: true, force: true });
		fs.rmSync(granted, { recursive: true, force: true });
	}
});

test('on a single-page site, shows the highlights of an address the page moved to only when asked', async () => {
	const granted = grantedBuild();
	const spaProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-e2e-profile-'));
	const ctx = await launch(spaProfile, granted);
	try {
		const site = await ctx.newPage();
		await goto(site, `${website.origin}/spa/two`);
		const panel = await pairedPanel(ctx);
		await panel.click('#highlight-grant');
		await expect(panel.locator('#highlight-revisit-on')).toBeVisible();

		// A highlight on the second address, loaded as a document of its own.
		await site.bringToFront();
		await expect(panel.locator('#page .page-url')).toHaveText(`${website.origin}/spa/two`);
		const phrase = 'Northgate Freight';
		await selectText(site, phrase);
		await panel.click('#highlight-create');
		await expect.poll(() => painted(site), { timeout: 10_000 }).toEqual([phrase]);

		// The first address, loaded; then the site's own link moves it to the second.
		await goto(site, `${website.origin}/spa`);
		await expect(panel.locator('#page .page-url')).toHaveText(`${website.origin}/spa`);
		await site.click('#to-two');
		await expect(site).toHaveURL(`${website.origin}/spa/two`);
		await expect(site.locator('#view')).toContainText(phrase);
		// Chrome still names the document by where it was loaded from, so the extension will
		// not show another address's highlights because the page moved its address.
		await expect(panel.locator('#highlight-unshown-text')).toContainText('changed its address', { timeout: 10_000 });
		expect(await painted(site)).toEqual([]);

		// The investigator, looking at this address, asks.
		await panel.click('#highlight-show-here');
		await expect.poll(() => painted(site), { timeout: 10_000 }).toEqual([phrase]);
		await expect(panel.locator('#highlight-unshown')).toBeHidden();

		// Back to the address the document was loaded from: its own highlights (none), on their own.
		await site.goBack();
		await expect(site).toHaveURL(`${website.origin}/spa`);
		await expect.poll(() => painted(site), { timeout: 10_000 }).toEqual([]);
	} finally {
		await ctx.close();
		fs.rmSync(spaProfile, { recursive: true, force: true });
		fs.rmSync(granted, { recursive: true, force: true });
	}
});
