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
const NOTE = 'OSINTCopilot/boards/Sections.md'

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

/** Opens the board, with any extra cards on it and the notes those cards show. */
async function openBoard(page: Page, extra: { nodes?: object[], notes?: Record<string, string> } = {}) {
	const nodes = [...board.nodes, ...(extra.nodes ?? [])]
	const notes = extra.notes ?? {}
	await expect.poll(() => page.evaluate(() => !!(globalThis as any).osint?.app?.vault?.adapter),
		{ timeout: 30_000, message: 'the OSINT runtime never started' }).toBe(true)
	await page.evaluate(async ({ board, boardPath, thumbPath, notes }) => {
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
		for (const [notePath, text] of Object.entries(notes)) await adapter.write(notePath, text)
		await adapter.write(boardPath, board)
	}, { board: JSON.stringify({ ...board, nodes }, null, 2), boardPath: BOARD, thumbPath: THUMB, notes })
	await indexed(page, THUMB)
	for (const note of Object.keys(notes)) await indexed(page, note)
	await indexed(page, BOARD)
	await page.evaluate(p => {
		const ws = (document as any).workspace
		const node = ws.directoryStore.get(p)
		ws.viewState.tangent.updateThread({ thread: [node], currentNode: node })
	}, path.join(workspace, BOARD))
	await expect(page.locator('.canvas-card')).toHaveCount(nodes.filter(n => (n as any).type !== 'group').length,
		{ timeout: 30_000 })
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


test('the picker\'s list scrolls under the wheel, and the board behind it stays put', async ({ tangent }) => {
	test.setTimeout(120_000)
	const { page } = await tangent.firstWindow()
	await openBoard(page)
	// Enough files that the list is longer than the picker.
	await page.evaluate(async () => {
		const vault = (globalThis as any).osint.app.vault
		if (!vault.getAbstractFileByPath('Leads')) await vault.createFolder('Leads')
		for (let i = 1; i <= 60; i++) await vault.create(`Leads/Lead ${i}.md`, `Lead ${i}`)
	})
	const card = page.locator('.canvas-card.type-text', { hasText: 'Plain card' })
	const before = await card.boundingBox()

	await page.locator('.canvas-toolbar button', { hasText: '+ file' }).click()
	const list = page.locator('.CanvasPicker ul')
	await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight),
		{ message: 'the list never got long enough to scroll' }).toBe(true)

	// The board took every wheel event for its zoom, so the list could not be scrolled
	// and the board zoomed behind the picker instead.
	const box = (await list.boundingBox())!
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	await page.mouse.wheel(0, 400)
	await expect.poll(() => list.evaluate(el => el.scrollTop), { message: 'the list did not scroll' })
		.toBeGreaterThan(0)
	expect(await card.boundingBox(), 'the board zoomed behind the picker').toEqual(before)
})

test('a drop on the open picker is the picker\'s, not the board\'s', async ({ tangent }) => {
	test.setTimeout(120_000)
	const { page } = await tangent.firstWindow()
	await openBoard(page)

	await page.locator('.canvas-toolbar button', { hasText: '+ file' }).click()
	// A vault path, as a file dragged in from the sidebar carries it, dropped on the
	// search box. The board used to take it, cancelling the drop the box would have
	// taken, and put the file on the board behind the still-open picker.
	const dropTaken = await page.locator('.CanvasPicker input').evaluate(async (el, thumb) => {
		const data = new DataTransfer()
		data.setData('text/plain', thumb)
		el.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }))
		const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
		el.dispatchEvent(drop)
		return drop.defaultPrevented
	}, THUMB)
	expect(dropTaken, 'the board cancelled the drop on the search box').toBe(false)
	await expect(page.locator('.canvas-surface')).not.toHaveClass(/drop-active/)
	await expect(page.locator('.CanvasPicker')).toHaveCount(1)
	await expect(page.locator('.canvas-card')).toHaveCount(3)
})

test('a file dropped anywhere else on the open picker is picked', async ({ tangent }) => {
	test.setTimeout(120_000)
	const { page } = await tangent.firstWindow()
	await openBoard(page)

	await page.locator('.canvas-toolbar button', { hasText: '+ image' }).click()
	// The picker covers the whole board and says a file can be dragged in from the
	// sidebar, but it refused every drop, so following its hint did nothing.
	const dropTaken = await page.locator('.CanvasPicker .note').evaluate(async (el, thumb) => {
		const data = new DataTransfer()
		data.setData('text/plain', thumb)
		el.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }))
		const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
		el.dispatchEvent(drop)
		return drop.defaultPrevented
	}, THUMB)
	expect(dropTaken, 'the drop on the picker was refused').toBe(true)
	await expect(page.locator('.CanvasPicker')).toHaveCount(0)
	await expect(page.locator('.canvas-card.type-file .card-image img')).toHaveCount(1)
})

test('a media card\'s player takes a press, and a middle-drag on it still pans the board', async ({ tangent }) => {
	test.setTimeout(120_000)
	const { page } = await tangent.firstWindow()
	const CLIP = 'OSINTCopilot/boards/assets/clip.webm'
	await openBoard(page, {
		nodes: [{ id: 'clip', type: 'file', file: CLIP, x: 460, y: 220, width: 320, height: 220 }],
		notes: { [CLIP]: 'not a real video' },
	})
	const card = page.locator('.canvas-card.type-file')
	const video = card.locator('video')
	await expect(video).toBeVisible({ timeout: 30_000 })
	const start = (await card.boundingBox())!
	const box = (await video.boundingBox())!
	const x = box.x + box.width / 2
	const y = box.y + box.height / 2

	// The player's controls are the element's own. A press on them started moving the card
	// and took the pointer, so play and seek never got their click.
	await page.mouse.move(x, y)
	await page.mouse.down()
	await page.mouse.move(x + 80, y + 60, { steps: 5 })
	await page.mouse.up()
	expect(await card.boundingBox(), 'the card moved under a press on its player').toEqual(start)

	// A pan is not a click on the control, so it starts there as anywhere else.
	await page.mouse.move(x, y)
	await page.mouse.down({ button: 'middle' })
	await page.mouse.move(x + 80, y + 60, { steps: 5 })
	await page.mouse.up({ button: 'middle' })
	await expect.poll(async () => (await card.boundingBox())!.x, { message: 'the board did not pan' })
		.toBeGreaterThan(start.x + 40)
})

test('a button inside a card takes its click', async ({ tangent }) => {
	test.setTimeout(120_000)
	const { page } = await tangent.firstWindow()
	await openBoard(page, {
		nodes: [{ id: 'note', type: 'file', file: NOTE, x: 460, y: 220, width: 420, height: 260 }],
		notes: { [NOTE]: '# Findings\n\nThe first finding.\n\n# Leads\n\nA lead to follow.\n' },
	})
	const card = page.locator('.canvas-card.type-file')
	await expect(card.getByText('The first finding.')).toBeVisible({ timeout: 30_000 })

	// The note preview's own control: a heading shows its section button while the
	// pointer is at the heading's start.
	await card.locator('.line', { hasText: 'Findings' }).hover({ position: { x: 5, y: 5 } })
	const button = card.locator('button.collapse')
	await expect(button).toBeVisible()
	await button.evaluate(el => el.addEventListener('click', () => el.setAttribute('data-clicked', ''), { once: true }))

	// The press used to go on to the board, which started a selection box and took the
	// pointer, so the click went to the board instead of the button.
	await button.click()
	await expect(button).toHaveAttribute('data-clicked', '')

	// A middle-drag that starts on the button still pans the board.
	const start = (await card.boundingBox())!
	await card.locator('.line', { hasText: 'Findings' }).hover({ position: { x: 5, y: 5 } })
	const at = (await button.boundingBox())!
	await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2)
	await page.mouse.down({ button: 'middle' })
	await page.mouse.move(at.x + 80, at.y + 60, { steps: 5 })
	await page.mouse.up({ button: 'middle' })
	await expect.poll(async () => (await card.boundingBox())!.x, { message: 'the board did not pan' })
		.toBeGreaterThan(start.x + 40)
})
