import { test, expect } from './tangent'
import type { Page } from '@playwright/test'
import os from 'os'
import path from 'path'

/**
 * How a canvas board draws its cards, in the real app.
 *
 * CanvasView needs Tangent's `workspace` context and the vault behind it, so only the app
 * itself can show what a card looks like: whether a link's thumbnail leaves its text
 * readable, and whether a card's colour is drawn at all.
 */

// A path only; the fixture creates the workspace and removes it afterwards.
const workspace = path.join(os.tmpdir(), `oc-canvas-cards-${process.pid}-${Date.now()}`)

test.use({ workspace, resetWorkspace: true })

const BOARD = 'OSINTCopilot/boards/Cards.canvas'
const THUMB = 'OSINTCopilot/boards/assets/thumb.png'

const board = {
	nodes: [
		{ id: 'link', type: 'link', url: 'https://example.org/x', x: 40, y: 40, width: 340, height: 180,
			osintLinkTitle: 'Registry extract', osintLinkDescription: 'Director, shareholder, registered office',
			osintLinkSite: 'example.org', osintLinkImage: THUMB },
		{ id: 'red', type: 'text', text: 'Red card', color: '1', x: 460, y: 40, width: 240, height: 120 },
		{ id: 'plain', type: 'text', text: 'Plain card', x: 780, y: 40, width: 240, height: 120 },
		{ id: 'group', type: 'group', label: 'Suppliers', color: '#123456', x: 40, y: 320, width: 400, height: 160 },
	],
	edges: [],
}

/** Waits until Tangent's own index has a file, so it can be opened and drawn. */
async function indexed(page: Page, relative: string) {
	const absolute = path.join(workspace, relative)
	await expect.poll(() => page.evaluate(p => !!(document as any).workspace.directoryStore.get(p), absolute),
		{ timeout: 30_000, message: `Tangent never indexed ${relative}` }).toBe(true)
}

async function openBoard(page: Page) {
	await expect.poll(() => page.evaluate(() => !!(globalThis as any).osint?.app?.vault?.adapter),
		{ timeout: 30_000, message: 'the OSINT runtime never started' }).toBe(true)
	await page.evaluate(async ({ board, boardPath, thumbPath }) => {
		const adapter = (globalThis as any).osint.app.vault.adapter
		for (const folder of ['OSINTCopilot', 'OSINTCopilot/boards', 'OSINTCopilot/boards/assets']) {
			if (!(await adapter.exists(folder))) await adapter.mkdir(folder)
		}
		const canvas = new OffscreenCanvas(64, 40)
		const g = canvas.getContext('2d')!
		g.fillStyle = '#3d9fa8'
		g.fillRect(0, 0, canvas.width, canvas.height)
		const blob = await canvas.convertToBlob({ type: 'image/png' })
		await adapter.writeBinary(thumbPath, await blob.arrayBuffer())
		await adapter.write(boardPath, board)
	}, { board: JSON.stringify(board, null, 2), boardPath: BOARD, thumbPath: THUMB })
	await indexed(page, THUMB)
	await indexed(page, BOARD)
	await page.evaluate(p => {
		const ws = (document as any).workspace
		const node = ws.directoryStore.get(p)
		ws.viewState.tangent.updateThread({ thread: [node], currentNode: node })
	}, path.join(workspace, BOARD))
	await expect(page.locator('.canvas-card')).toHaveCount(3, { timeout: 30_000 })
}

test('a link card shows its saved thumbnail without covering its text', async ({ tangent }) => {
	test.setTimeout(120_000)
	const { page } = await tangent.firstWindow()
	await openBoard(page)

	const link = page.locator('.canvas-card.type-link')
	const img = link.locator('.link-thumb img')
	await expect(img).toHaveCount(1)
	// The vault copy, never the page's own image address.
	const src = await img.getAttribute('src')
	expect(src).toContain(path.join(workspace, THUMB))
	expect(src).not.toContain('http')
	await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete ? el.naturalWidth : 0),
		{ message: 'the thumbnail never loaded' }).toBe(64)

	// Drawn as a file embed, it had a header naming the hash-named asset.
	await expect(link.locator('header')).toHaveCount(0)

	const title = link.locator('.link-title')
	await expect(title).toBeVisible()
	await expect(title).toHaveText('Registry extract')
	const box = (await title.boundingBox())!
	const hitsBody = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.link-body'),
		{ x: box.x + box.width / 2, y: box.y + box.height / 2 })
	expect(hitsBody, 'something is drawn over the link title').toBe(true)
})

test('a card and a group are drawn in their colour, and a new colour shows at once', async ({ tangent }) => {
	test.setTimeout(120_000)
	const { page } = await tangent.firstWindow()
	await openBoard(page)

	const red = page.locator('.canvas-card.type-text', { hasText: 'Red card' })
	const plain = page.locator('.canvas-card.type-text', { hasText: 'Plain card' })
	const group = page.locator('.canvas-group', { hasText: 'Suppliers' })

	// Preset "1", and a hex value as Obsidian may write it.
	await expect(red).toHaveCSS('border-top-color', 'rgb(229, 83, 75)')
	await expect(group).toHaveCSS('border-top-color', 'rgb(18, 52, 86)')

	// A card without a colour keeps the theme's border and background.
	const themeBorder = await page.evaluate(() => {
		const probe = document.createElement('div')
		probe.style.borderTop = '1px solid var(--background-modifier-border)'
		document.querySelector('.canvas-surface')!.appendChild(probe)
		const color = getComputedStyle(probe).borderTopColor
		probe.remove()
		return color
	})
	await expect(plain).toHaveCSS('border-top-color', themeBorder)
	const background = (card: typeof red) => card.evaluate(el => getComputedStyle(el).backgroundColor)
	expect(await background(red), 'the coloured card has no tint').not.toBe(await background(plain))

	// Picking a colour in the inspector repaints the card.
	await red.click()
	await page.locator('.CanvasInspector .swatch[title="Green"]').click()
	await expect.poll(() => red.evaluate(el => el.style.getPropertyValue('--card-color'))).toBe('#4a9d5f')

	// Deselected by a click on empty board between the link card and this one, so the
	// selection outline no longer hides the border.
	const left = (await page.locator('.canvas-card.type-link').boundingBox())!
	const right = (await red.boundingBox())!
	await page.mouse.click((left.x + left.width + right.x) / 2, right.y + 10)
	await expect(page.locator('.CanvasInspector')).toHaveCount(0)
	await expect(red).toHaveCSS('border-top-color', 'rgb(74, 157, 95)')
})

test('the image picker takes a click', async ({ tangent }) => {
	test.setTimeout(120_000)
	const { page } = await tangent.firstWindow()
	await openBoard(page)

	// The picker sits over the board, as the inspector does; a press in it used to start a
	// selection box on the board instead, which took the click away from the list.
	await page.locator('.canvas-toolbar button', { hasText: '+ image' }).click()
	await page.locator('.CanvasPicker button', { hasText: 'thumb.png' }).click()
	await expect(page.locator('.CanvasPicker')).toHaveCount(0)
	await expect(page.locator('.canvas-card.type-file .card-image img')).toHaveCount(1)
})
