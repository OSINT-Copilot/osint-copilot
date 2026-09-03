<script lang="ts">
/**
 * The canvas lens: an infinite pan/zoom board of cards that reference existing notes and
 * entities, stored as JSON Canvas so the same file opens in Obsidian.
 *
 * A native Svelte lens rather than an Obsidian ItemView (which is how the other four OSINT
 * views work) for two reasons. Cards must show real note content, and the component that
 * does that -- NodePreview -- needs Tangent's `workspace` context, so it is only reachable
 * from here. And an ItemView's onOpen() always runs while its container is detached, which
 * makes measuring a viewport there impossible; a Svelte component mounts already in the DOM.
 *
 * Edges are drawings. Nothing here writes to the entity graph.
 */
import { getContext, onDestroy, onMount } from 'svelte'
import NodePreview from 'app/views/summaries/NodePreview.svelte'
import CanvasInspector from './CanvasInspector.svelte'
import CanvasPicker from './CanvasPicker.svelte'
import { CanvasDocumentStore, nodeRect } from './canvas-document'
import {
	vaultFileStore, vaultRelativePath, absoluteVaultPath, entityCardData, entitiesByNotePath,
	openEntityNote, writeAsset, importedFileName,
} from './canvas-runtime'
import {
	fetchLinkPreview, displayHost, isFetchableUrl,
	LINK_TITLE_KEY, LINK_DESCRIPTION_KEY, LINK_IMAGE_KEY, LINK_SITE_KEY, LINK_FETCHED_KEY,
} from './canvas-link-preview'
import {
	defaultViewport, screenToWorld, worldToScreen, zoomAbout, scaleFromWheel, panBy,
	visibleWorldRect, cullToViewport, fitToRects, rectFromCorners, rectsIntersect,
	sideAnchor, inferSide, oppositeSide, edgePath, edgeMidpoint, arrowAngle,
	LIVE_PREVIEW_MIN_SCALE,
	type Viewport, type Rect, type Side,
} from './canvas-viewport'
import type { CanvasNode, CanvasEdge, CanvasFileNode, CanvasTextNode, CanvasLinkNode, CanvasGroupNode } from './canvas-format'

/**
 * The LENS, not the node view state -- NodeViewSelector renders
 * `<svelte:component state={$lensState}>`. CanvasNodeViewState puts the node on the lens
 * as `canvasNode` for exactly this reason.
 */
export let state: { canvasNode: { path: string, name?: string } }
// Props NodeViewSelector passes to every lens.
export let isCurrent: boolean = false
export let focusLevel: number = 0
export let layout: 'fill' | 'auto' = 'fill'
export let background: 'auto' | 'none' = 'auto'
export let extraTop: number = 0
export let extraBottom: number = 0
export let onNavigate: any = null
export let onViewReady: any = null
export let onScrollRequest: any = null
export let onKeyboardExit: any = null

const workspace: any = getContext('workspace')

// The ABSOLUTE path, resolved to vault-relative per call inside the store's file layer.
// Resolving it here instead would happen at component construction, which can precede the
// plugin runtime -- and a path resolved without a vault root stays absolute, which then
// gets written as if it were relative and builds a shadow tree inside the vault.
const store = new CanvasDocumentStore(state.canvasNode.path, vaultFileStore())
let viewport: Viewport = defaultViewport()
let surface: HTMLElement
let width = 0
let height = 0
let entityIndex = new Map<string, string>()

/** A drag in progress. One at a time, so a single discriminated value covers all of them. */
type Gesture =
	| { kind: 'pan', lastX: number, lastY: number }
	| { kind: 'move', lastWorld: { x: number, y: number } }
	| { kind: 'resize', id: string, startRect: Rect, startWorld: { x: number, y: number } }
	| { kind: 'marquee', originWorld: { x: number, y: number }, currentWorld: { x: number, y: number } }
	| { kind: 'connect', fromId: string, fromSide: Side, currentWorld: { x: number, y: number } }
	| null
let gesture: Gesture = null
let picker: 'file' | 'image' | 'link' | null = null
let dropActive = false
/** Ids of link cards with a fetch in flight, so the card can say so. */
let fetching = new Set<string>()

$: selectedNode = docState.selectedNodes.size === 1
	? nodes.find((n) => n.id === [...docState.selectedNodes][0]) ?? null
	: null
$: selectedEdge = docState.selectedEdges.size === 1
	? edges.find((e) => e.id === [...docState.selectedEdges][0]) ?? null
	: null
$: showInspector = !!(selectedNode || selectedEdge)

$: docState = $store
$: nodes = docState.doc.nodes
$: edges = docState.doc.edges
$: nodeById = new Map(nodes.map((n) => [n.id, n]))

// Cards are culled to the viewport plus one screen: a large board must not mount every
// NoteEditor, but a card should already exist by the time it pans into view.
$: visible = width > 0 && height > 0
	? visibleWorldRect(viewport, width, height)
	: { x: 0, y: 0, width: 0, height: 0 }
$: mountedNodes = width > 0
	? cullToViewport(nodes.map((node) => ({ node, rect: nodeRect(node) })), visible).map((i) => i.node)
	: []
// Groups paint behind everything else so their contents stay clickable.
$: groupNodes = mountedNodes.filter((n) => n.type === 'group')
$: cardNodes = mountedNodes.filter((n) => n.type !== 'group')
$: livePreviews = viewport.scale >= LIVE_PREVIEW_MIN_SCALE

onMount(() => {
	void store.load().then(() => {
		entityIndex = entitiesByNotePath()
		// Frame the board on open. Without content this leaves the default viewport.
		if (store.current.doc.nodes.length > 0 && width > 0) {
			viewport = fitToRects(store.current.doc.nodes.map(nodeRect), width, height)
		}
		onViewReady?.()
	})
})

onDestroy(() => {
	// Flushes a change still inside the save debounce, so closing the panel cannot lose
	// the last edit.
	void store.dispose()
})

function screenPoint(event: { clientX: number, clientY: number }) {
	const box = surface.getBoundingClientRect()
	return { x: event.clientX - box.left, y: event.clientY - box.top }
}

function worldPoint(event: { clientX: number, clientY: number }) {
	return screenToWorld(viewport, screenPoint(event))
}

function onWheel(event: WheelEvent) {
	event.preventDefault()
	// Anchored on the cursor: the point under the pointer must not move, or zooming feels
	// like the board is sliding away.
	viewport = zoomAbout(viewport, screenPoint(event), scaleFromWheel(viewport.scale, event.deltaY))
}

const LEFT_BUTTON = 0
const MIDDLE_BUTTON = 1

/**
 * The pointer that owns the current gesture.
 *
 * Without it a second pointer -- a touch, a pen, a second mouse -- lands mid-drag and
 * hijacks the one already in progress, because `gesture` is a single value.
 */
let gesturePointerId: number | null = null

function beginGesture(event: PointerEvent, next: Gesture) {
	gesturePointerId = event.pointerId
	surface.setPointerCapture(event.pointerId)
	gesture = next
}

function isPanTrigger(event: PointerEvent) {
	return event.button === MIDDLE_BUTTON || event.altKey
}

function onSurfacePointerDown(event: PointerEvent) {
	// Right-click is left alone, and a gesture already in flight owns the surface.
	// The old condition was `button === 1 || shiftKey === false && button === 2`, which
	// binds as `button === 1 || (…)` -- so middle-click returned before ever reaching the
	// pan branch below it, and shift+right-click started a marquee.
	if (event.button !== LEFT_BUTTON && event.button !== MIDDLE_BUTTON) return
	if (gesturePointerId !== null) return

	if (isPanTrigger(event)) {
		beginGesture(event, { kind: 'pan', lastX: event.clientX, lastY: event.clientY })
		return
	}
	// A drag on empty board is a marquee; a plain click clears the selection.
	const origin = worldPoint(event)
	beginGesture(event, { kind: 'marquee', originWorld: origin, currentWorld: origin })
	if (!event.shiftKey) store.clearSelection()
}

/** True for anything inside a card the user should be able to click or type into. */
function isInteractiveTarget(event: PointerEvent) {
	const target = event.target as HTMLElement | null
	return !!target?.closest('input, textarea, select, a, button:not(.connect-handle):not(.resize-handle)')
}

function onCardPointerDown(event: PointerEvent, node: CanvasNode) {
	if (event.button !== LEFT_BUTTON && event.button !== MIDDLE_BUTTON) return
	if (gesturePointerId !== null) return
	// Capturing unconditionally meant nothing inside a card could ever be interacted with:
	// the surface swallowed the pointer before the control saw it.
	if (isInteractiveTarget(event)) return
	event.stopPropagation()

	if (isPanTrigger(event)) {
		beginGesture(event, { kind: 'pan', lastX: event.clientX, lastY: event.clientY })
		return
	}
	// Dragging an unselected card selects it first, so the drag moves what you grabbed.
	if (!docState.selectedNodes.has(node.id)) {
		store.toggleNodeSelected(node.id, event.shiftKey)
	} else if (event.shiftKey) {
		store.toggleNodeSelected(node.id, true)
	}
	beginGesture(event, { kind: 'move', lastWorld: worldPoint(event) })
}

function onResizePointerDown(event: PointerEvent, node: CanvasNode) {
	if (event.button !== LEFT_BUTTON) return
	event.stopPropagation()
	beginGesture(event, {
		kind: 'resize', id: node.id, startRect: nodeRect(node), startWorld: worldPoint(event),
	})
}

function onConnectPointerDown(event: PointerEvent, node: CanvasNode, side: Side) {
	if (event.button !== LEFT_BUTTON) return
	event.stopPropagation()
	beginGesture(event, {
		kind: 'connect', fromId: node.id, fromSide: side, currentWorld: worldPoint(event),
	})
}

/** Ends a gesture without committing it, and always releases the capture. */
function abortGesture(pointerId?: number) {
	const id = pointerId ?? gesturePointerId
	gesture = null
	gesturePointerId = null
	if (id !== null && id !== undefined && surface?.hasPointerCapture?.(id)) {
		surface.releasePointerCapture(id)
	}
}

function onPointerMove(event: PointerEvent) {
	if (!gesture) return
	// A second pointer must not drive the first one's gesture.
	if (gesturePointerId !== null && event.pointerId !== gesturePointerId) return
	if (gesture.kind === 'pan') {
		viewport = panBy(viewport, event.clientX - gesture.lastX, event.clientY - gesture.lastY)
		gesture = { ...gesture, lastX: event.clientX, lastY: event.clientY }
		return
	}
	const world = worldPoint(event)
	if (gesture.kind === 'move') {
		store.moveNodes(docState.selectedNodes, world.x - gesture.lastWorld.x, world.y - gesture.lastWorld.y)
		gesture = { ...gesture, lastWorld: world }
		return
	}
	if (gesture.kind === 'resize') {
		// A minimum so a card cannot be shrunk to an unclickable sliver.
		const width = Math.max(80, gesture.startRect.width + (world.x - gesture.startWorld.x))
		const height = Math.max(60, gesture.startRect.height + (world.y - gesture.startWorld.y))
		store.updateNode(gesture.id, { width, height } as Partial<CanvasNode>)
		return
	}
	gesture = { ...gesture, currentWorld: world }
}

/**
 * A cancelled pointer abandons the gesture; it does not complete it.
 *
 * pointercancel used to run the same path as pointerup, so a connect drag that the OS or
 * browser cancelled -- a gesture takeover, the window losing the pointer -- committed a
 * real edge the user never finished drawing.
 */
function onPointerCancel(event: PointerEvent) {
	if (gesturePointerId !== null && event.pointerId !== gesturePointerId) return
	abortGesture(event.pointerId)
}

function onPointerUp(event: PointerEvent) {
	if (!gesture) return
	if (gesturePointerId !== null && event.pointerId !== gesturePointerId) return
	if (gesture.kind === 'marquee') {
		const box = rectFromCorners(gesture.originWorld, gesture.currentWorld)
		// A click, not a drag: leave the selection the pointerdown already set.
		if (box.width > 3 || box.height > 3) {
			store.setSelection(nodes.filter((n) => rectsIntersect(nodeRect(n), box)).map((n) => n.id))
		}
	}
	if (gesture.kind === 'connect') {
		const target = nodes.find((n) => {
			const rect = nodeRect(n)
			return gesture!.kind === 'connect'
				&& gesture.currentWorld.x >= rect.x && gesture.currentWorld.x <= rect.x + rect.width
				&& gesture.currentWorld.y >= rect.y && gesture.currentWorld.y <= rect.y + rect.height
		})
		if (target) {
			store.addEdge(gesture.fromId, target.id, gesture.fromSide,
				oppositeSide(inferSide(nodeRect(nodeById.get(gesture.fromId)!), nodeRect(target))))
		}
	}
	abortGesture(event.pointerId)
}

function onKeyDown(event: KeyboardEvent) {
	if (event.key === 'Delete' || event.key === 'Backspace') {
		// Never while typing into a card.
		const active = document.activeElement
		if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return
		if (docState.selectedNodes.size === 0 && docState.selectedEdges.size === 0) return
		event.preventDefault()
		store.deleteSelection()
		return
	}
	if (event.key === 'Escape') {
		store.clearSelection()
		// Through abortGesture, so the pointer capture is released too. Clearing `gesture`
		// alone left the surface holding the pointer, and the next pointerup returned
		// early because there was no gesture to end.
		abortGesture()
	}
}

function centreOfView() {
	return screenToWorld(viewport, { x: width / 2, y: height / 2 })
}

function addTextCard() {
	const node = store.addNodeAt('text', centreOfView(), { width: 320, height: 180 } as any)
	store.setSelection([node.id])
}

/** Places a vault file on the board. Images get a squarer default than documents. */
function addFileCard(path: string, at = centreOfView()) {
	const isImage = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(path)
	const node = store.addNodeAt('file', at, {
		file: path,
		width: isImage ? 360 : 420,
		height: isImage ? 300 : 380,
	} as any)
	store.setSelection([node.id])
	return node
}

/**
 * Adds a link card and fetches its preview.
 *
 * The fetch is immediate and deliberate -- the behaviour chosen for this feature -- so
 * adding a link is also a request to that site. The result is written into the board, so
 * reopening it later makes no further requests.
 */
async function addLinkCard(url: string, at = centreOfView()) {
	if (!isFetchableUrl(url)) return
	const node = store.addNodeAt('link', at, { url, width: 340, height: 260 } as any)
	store.setSelection([node.id])
	await loadLinkPreview(node.id, url)
}

async function loadLinkPreview(nodeId: string, url: string) {
	fetching = new Set([...fetching, nodeId])
	try {
		const preview = await fetchLinkPreview(url)
		if (!preview) return
		let imagePath: string | undefined
		if (preview.image) {
			try {
				imagePath = await writeAsset(preview.image.fileName, preview.image.bytes)
			} catch (e) {
				// A thumbnail we could not store is not worth losing the text preview over.
				console.warn('[Canvas] could not store link thumbnail', e)
			}
		}
		store.setNodeExtra(nodeId, {
			[LINK_TITLE_KEY]: preview.title,
			[LINK_DESCRIPTION_KEY]: preview.description,
			[LINK_SITE_KEY]: preview.siteName,
			[LINK_IMAGE_KEY]: imagePath,
			// Recorded so an analyst can tell how old a cached preview is.
			[LINK_FETCHED_KEY]: new Date().toISOString(),
		})
	} finally {
		const next = new Set(fetching)
		next.delete(nodeId)
		fetching = next
	}
}

function onPickerResult(value: string) {
	const mode = picker
	picker = null
	if (mode === 'link') void addLinkCard(value)
	else if (mode) addFileCard(value)
}

/** Copies dropped OS files into the vault, then puts each on the board. */
async function importDroppedFiles(files: FileList, at: { x: number, y: number }) {
	let offset = 0
	for (const file of Array.from(files)) {
		try {
			const bytes = await file.arrayBuffer()
			const path = await writeAsset(importedFileName(file.name, bytes), bytes)
			addFileCard(path, { x: at.x + offset, y: at.y + offset })
			offset += 40
		} catch (e) {
			console.error('[Canvas] could not import', file.name, e)
		}
	}
}

function onDragOver(event: DragEvent) {
	event.preventDefault()
	dropActive = true
	if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(event: DragEvent) {
	// Only when the pointer actually left the surface, not on every child crossing.
	if (event.currentTarget === event.target) dropActive = false
}

async function onDrop(event: DragEvent) {
	event.preventDefault()
	dropActive = false
	const at = worldPoint(event)
	const transfer = event.dataTransfer
	if (!transfer) return

	if (transfer.files?.length) {
		await importDroppedFiles(transfer.files, at)
		return
	}

	// Tangent's file tree and most text drags carry a path or a URL as plain text.
	const text = transfer.getData('text/plain')?.trim()
	if (!text) return
	if (isFetchableUrl(text)) { await addLinkCard(text, at); return }

	// A vault path, possibly absolute because Tangent addresses nodes that way.
	const relative = vaultRelativePath(text)
	if (treeNodeFor(relative)) addFileCard(relative, at)
}

function fitAll() {
	if (nodes.length === 0 || width === 0) return
	viewport = fitToRects(nodes.map(nodeRect), width, height)
}

/**
 * Whether NodePreview will actually draw something for this node.
 *
 * It handles notes, folders and embeds (image/audio/video/pdf) and silently renders
 * nothing for everything else, so a .csv or .docx card came out blank with no hint that
 * the file was perfectly fine.
 */
function isPreviewable(target: any): boolean {
	if (!target) return false
	if (Array.isArray(target.children)) return true
	const name: string = target.name ?? ''
	const dot = name.lastIndexOf('.')
	const extension: string = (target.fileType ?? (dot >= 0 ? name.slice(dot) : '')).toLowerCase()
	if (extension === '.md' || extension === '') return true
	return /^\.(png|jpe?g|gif|webp|bmp|avif|svg|pdf|mp3|wav|ogg|m4a|mp4|webm|mov)$/.test(extension)
}

/**
 * Resolves a card's file to the Tangent tree node NodePreview renders.
 *
 * JSON Canvas stores vault-relative paths; directoryStore is keyed by absolute path, so
 * this has to convert. Without it every note card rendered as "missing from the vault".
 */
function treeNodeFor(path: string) {
	return workspace?.directoryStore?.get?.(absoluteVaultPath(path)) ?? null
}

function entityFor(node: CanvasNode) {
	if (node.type !== 'file') return null
	// The explicit binding first; otherwise a note that happens to back an entity still
	// gets the entity treatment, which is what makes dragging one in from the tree work.
	const id = node.osintEntityId ?? entityIndex.get((node as CanvasFileNode).file)
	return id ? entityCardData(id) : null
}

function openNode(node: CanvasNode) {
	if (node.type === 'link') {
		const url = (node as CanvasLinkNode).url
		// Checked at the point of opening, not only when the card was made: the URL is
		// editable, and boards are shared. window.open hands anything else to the OS
		// handler, so file: and custom schemes would be launched by a double-click.
		if (!isFetchableUrl(url)) {
			console.warn('[Canvas] refusing to open a non-http(s) link', url)
			return
		}
		window.open(url, '_blank', 'noopener,noreferrer')
		return
	}
	if (node.type !== 'file') return
	const entity = entityFor(node)
	if (entity) { openEntityNote(entity.id); return }
	const target = treeNodeFor((node as CanvasFileNode).file)
	if (target) onNavigate?.({ node: target })
}

/**
 * Screen-space rect for a world rect, so cards can be absolutely positioned.
 *
 * Takes the viewport as an argument rather than closing over it so that every call site
 * names it, and Svelte therefore re-runs the expression when it changes.
 */
function screenRect(rect: Rect, view: Viewport) {
	const topLeft = worldToScreen(view, rect)
	return {
		left: topLeft.x, top: topLeft.y,
		width: rect.width * view.scale, height: rect.height * view.scale,
	}
}

const SIDES: Side[] = ['top', 'right', 'bottom', 'left']

/**
 * Edge geometry, recomputed reactively.
 *
 * This has to be a `$:` over `viewport` rather than `d={pathFor(edge)}` in the template.
 * Svelte only tracks the variables a template expression names directly, and
 * `pathFor(edge)` names `edge`, not `viewport` -- so edges were drawn once with the
 * initial identity transform and then never moved again, leaving them in world
 * coordinates while every card was correctly transformed around them.
 */
$: edgeGeometry = edges
	.map((edge) => geometryFor(edge, viewport, nodeById))
	.filter((g) => g !== null) as EdgeGeometry[]

interface EdgeGeometry {
	edge: CanvasEdge
	d: string
	start: { x: number, y: number }
	end: { x: number, y: number }
	startAngle: number
	endAngle: number
	mid: { x: number, y: number }
}

function geometryFor(
	edge: CanvasEdge,
	view: Viewport,
	byId: Map<string, CanvasNode>,
): EdgeGeometry | null {
	const from = byId.get(edge.fromNode)
	const to = byId.get(edge.toNode)
	if (!from || !to) return null
	const fromRect = nodeRect(from)
	const toRect = nodeRect(to)
	// fromSide/toSide are optional in JSON Canvas, so a file written elsewhere may omit
	// them; infer the pair that reads as the obvious way round.
	const fromSide = edge.fromSide ?? inferSide(fromRect, toRect)
	const toSide = edge.toSide ?? oppositeSide(fromSide)
	const start = worldToScreen(view, sideAnchor(fromRect, fromSide))
	const end = worldToScreen(view, sideAnchor(toRect, toSide))
	return {
		edge,
		d: edgePath(start, fromSide, end, toSide),
		start,
		end,
		// The head points INTO the card it touches, so it uses that card's side.
		startAngle: arrowAngle(oppositeSide(fromSide)),
		endAngle: arrowAngle(toSide),
		mid: edgeMidpoint(start, fromSide, end, toSide),
	}
}

/** JSON Canvas preset colours, so an edge looks the same here as in Obsidian. */
const PRESET_CSS: Record<string, string> = {
	'1': '#e5534b', '2': '#e08c39', '3': '#d9a406',
	'4': '#4a9d5f', '5': '#3d9fa8', '6': '#8b62c9',
}

function edgeStroke(edge: CanvasEdge): string {
	if (!edge.color) return 'var(--text-faint, var(--text-muted))'
	return PRESET_CSS[edge.color] ?? edge.color
}

/**
 * `toEnd` defaults to "arrow" in the spec, `fromEnd` to "none".
 *
 * Reading them with those defaults is what lets the inspector turn an arrow OFF: a file
 * that simply omits toEnd still means "arrow", so "none" has to be written explicitly and
 * read back the same way.
 */
function hasArrow(value: string | undefined, fallback: 'none' | 'arrow'): boolean {
	return (value ?? fallback) === 'arrow'
}
</script>

<svelte:window on:keydown={isCurrent ? onKeyDown : undefined} />

<div
	class="CanvasView {layout}"
	style:--canvas-extra-top={extraTop + 'px'}
	style:--canvas-extra-bottom={extraBottom + 'px'}
	class:no-background={background === 'none'}
>
	<div class="canvas-toolbar">
		<button on:click={addTextCard} title="Add a text card">+ text</button>
		<button on:click={() => picker = 'file'} title="Add a note or file from the vault">+ file</button>
		<button on:click={() => picker = 'image'} title="Add an image from the vault">+ image</button>
		<button on:click={() => picker = 'link'} title="Add a web link">+ link</button>
		<button on:click={fitAll} disabled={nodes.length === 0} title="Fit everything on screen">⊡ fit</button>
		<span class="canvas-spacer"></span>
		<span class="canvas-count">{nodes.length} card{nodes.length === 1 ? '' : 's'}</span>
		{#if docState.dirty}<span class="canvas-dirty" title="Unsaved changes">•</span>{/if}
	</div>

	{#if docState.problems.length > 0}
		<div class="canvas-problems" title={docState.problems.join('\n')}>
			<span>
				{docState.problems.length} item{docState.problems.length === 1 ? '' : 's'} in this canvas
				could not be read.
				{#if docState.lossyLoad}
					Editing is held, because saving would remove {docState.problems.length === 1 ? 'it' : 'them'}.
				{/if}
			</span>
			{#if docState.lossyLoad}
				<button on:click={() => store.acceptLossyLoad()}>Edit anyway</button>
			{/if}
		</div>
	{/if}

	<div
		class="canvas-surface"
		bind:this={surface}
		bind:clientWidth={width}
		bind:clientHeight={height}
		on:wheel={onWheel}
		on:pointerdown={onSurfacePointerDown}
		on:pointermove={onPointerMove}
		on:pointerup={onPointerUp}
		on:pointercancel={onPointerCancel}
		on:dragover={onDragOver}
		on:dragleave={onDragLeave}
		on:drop={onDrop}
		class:drop-active={dropActive}
		role="application"
		aria-label="Canvas"
	>
		<!-- Groups first: they are backdrops, and must not swallow clicks on their contents. -->
		{#each groupNodes as node (node.id)}
			{@const box = screenRect(nodeRect(node), viewport)}
			<div
				class="canvas-group"
				class:selected={docState.selectedNodes.has(node.id)}
				style:left="{box.left}px" style:top="{box.top}px"
				style:width="{box.width}px" style:height="{box.height}px"
				on:pointerdown={(e) => onCardPointerDown(e, node)}
			>
				<span class="canvas-group-label">{(node as CanvasGroupNode).label ?? ''}</span>
			</div>
		{/each}

		<svg class="canvas-edges" {width} {height}>
			{#each edgeGeometry as g (g.edge.id)}
				{@const selected = docState.selectedEdges.has(g.edge.id)}
				{@const stroke = selected ? 'var(--text-accent)' : edgeStroke(g.edge)}
				<g class="canvas-edge-group">
					<!--
					  A wide invisible path under the visible one. A 2px curve is close to
					  unclickable, and an edge you cannot select is an edge you cannot edit.
					-->
					<path class="canvas-edge-hit" d={g.d}
						on:pointerdown={(e) => { e.stopPropagation(); store.toggleEdgeSelected(g.edge.id, e.shiftKey) }}
					/>
					<path class="canvas-edge" class:selected d={g.d} style:stroke={stroke} />
					{#if hasArrow(g.edge.toEnd, 'arrow')}
						<polygon class="canvas-arrow" style:fill={stroke}
							points="0,0 -9,4.5 -9,-4.5"
							transform="translate({g.end.x} {g.end.y}) rotate({g.endAngle})" />
					{/if}
					{#if hasArrow(g.edge.fromEnd, 'none')}
						<polygon class="canvas-arrow" style:fill={stroke}
							points="0,0 -9,4.5 -9,-4.5"
							transform="translate({g.start.x} {g.start.y}) rotate({g.startAngle})" />
					{/if}
					{#if g.edge.label}
						<!-- paint-order puts the halo behind the glyphs, so a label stays
						     readable where it crosses its own edge or a card. -->
						<text class="canvas-edge-label" x={g.mid.x} y={g.mid.y}
							text-anchor="middle" dominant-baseline="central">{g.edge.label}</text>
					{/if}
				</g>
			{/each}
			{#if gesture?.kind === 'connect'}
				{@const from = nodeById.get(gesture.fromId)}
				{#if from}
					{@const start = worldToScreen(viewport, sideAnchor(nodeRect(from), gesture.fromSide))}
					{@const end = worldToScreen(viewport, gesture.currentWorld)}
					<path class="canvas-edge pending" d={edgePath(start, gesture.fromSide, end, oppositeSide(gesture.fromSide))} />
				{/if}
			{/if}
		</svg>

		{#each cardNodes as node (node.id)}
			{@const box = screenRect(nodeRect(node), viewport)}
			{@const entity = entityFor(node)}
			<div
				class="canvas-card type-{node.type}"
				class:selected={docState.selectedNodes.has(node.id)}
				class:is-entity={!!entity}
				style:left="{box.left}px" style:top="{box.top}px"
				style:width="{box.width}px" style:height="{box.height}px"
				style:--entity-color={entity?.color ?? 'transparent'}
				on:pointerdown={(e) => onCardPointerDown(e, node)}
				on:dblclick={() => openNode(node)}
				role="button"
				tabindex="-1"
			>
				{#if entity}
					<div class="entity-header" style:background={entity.color}>
						<span class="entity-type">{entity.type}</span>
					</div>
					<div class="entity-body">
						<h3>{entity.label}</h3>
						{#each entity.summary as row (row.key)}
							<div class="entity-row"><span>{row.key}</span><span>{row.value}</span></div>
						{/each}
					</div>
				{:else if node.type === 'file'}
					{@const path = (node as CanvasFileNode).file}
					{@const target = treeNodeFor(path)}
					{#if target && livePreviews && isPreviewable(target)}
						<div class="card-preview"><NodePreview item={target} layout="fill" background="none" /></div>
					{:else}
						<div class="card-stub">
							<span class="stub-name">{path.split('/').pop()}</span>
							{#if !target}
								<span class="stub-missing">missing from the vault</span>
							{:else if !isPreviewable(target)}
								<!-- NodePreview handles notes, folders and embeds and renders
								     nothing at all for anything else -- a blank card with no
								     explanation. Say what the file is instead. -->
								<span class="stub-kind">{path.split('.').pop()?.toUpperCase()} file</span>
								<span class="stub-hint">Double-click to open</span>
							{/if}
						</div>
					{/if}
				{:else if node.type === 'text'}
					<div class="card-text">{(node as CanvasTextNode).text}</div>
				{:else if node.type === 'link'}
					{@const url = (node as CanvasLinkNode).url}
					{@const thumb = typeof node.extra[LINK_IMAGE_KEY] === 'string'
						? treeNodeFor(node.extra[LINK_IMAGE_KEY] as string) : null}
					<div class="card-link">
						{#if thumb}
							<!--
							  The thumbnail is the vault copy, never the remote URL. Pointing an
							  <img> at the origin would fetch it straight from the renderer, outside
							  net-guard, and re-tell the site every time the board was opened.
							-->
							<div class="link-thumb"><NodePreview item={thumb} layout="fill" background="none" /></div>
						{/if}
						<div class="link-body">
							<!-- textContent, never markup: these came from a page we do not control. -->
							<strong class="link-title">{node.extra[LINK_TITLE_KEY] ?? displayHost(url)}</strong>
							{#if node.extra[LINK_DESCRIPTION_KEY]}
								<p class="link-desc">{node.extra[LINK_DESCRIPTION_KEY]}</p>
							{/if}
							<span class="link-host">{node.extra[LINK_SITE_KEY] ?? displayHost(url)}</span>
							{#if fetching.has(node.id)}
								<span class="link-status">Fetching preview…</span>
							{:else if !node.extra[LINK_TITLE_KEY]}
								<span class="link-status">No preview</span>
							{/if}
						</div>
					</div>
				{/if}

				{#if docState.selectedNodes.has(node.id)}
					{#each SIDES as side (side)}
						<button
							class="connect-handle {side}"
							title="Drag to connect"
							on:pointerdown={(e) => onConnectPointerDown(e, node, side)}
						></button>
					{/each}
					<button
						class="resize-handle"
						title="Drag to resize"
						on:pointerdown={(e) => onResizePointerDown(e, node)}
					></button>
				{/if}
			</div>
		{/each}

		{#if gesture?.kind === 'marquee'}
			{@const box = screenRect(rectFromCorners(gesture.originWorld, gesture.currentWorld), viewport)}
			<div class="canvas-marquee"
				style:left="{box.left}px" style:top="{box.top}px"
				style:width="{box.width}px" style:height="{box.height}px"></div>
		{/if}

		{#if docState.loaded && nodes.length === 0}
			<div class="canvas-empty">
				<p>This canvas is empty.</p>
				<p>Add a card from the toolbar, or drop a file or link onto the board.</p>
			</div>
		{/if}

		{#if showInspector}
			<CanvasInspector
				{store}
				node={selectedNode}
				edge={selectedEdge}
				onRefetchLink={(n) => void loadLinkPreview(n.id, (n as CanvasLinkNode).url)}
				onClose={() => store.clearSelection()}
			/>
		{/if}

		{#if picker}
			<CanvasPicker mode={picker} onPick={onPickerResult} onCancel={() => picker = null} />
		{/if}
	</div>
</div>

<style>
.CanvasView {
	position: absolute;
	left: 0; right: 0;
	top: var(--canvas-extra-top, 0px);
	bottom: var(--canvas-extra-bottom, 0px);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	background: var(--background-primary);
}
/*
 * position: relative here, where `top` would shift the box without reserving space.
 * Tangent's own views reserve it with padding; this matches OsintViewHost.
 */
.CanvasView.auto {
	position: relative;
	top: auto; bottom: auto;
	padding-top: var(--canvas-extra-top, 0px);
	padding-bottom: var(--canvas-extra-bottom, 0px);
	box-sizing: border-box;
	min-height: 24em;
}
.CanvasView.no-background { background: none; }

.canvas-toolbar {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 10px;
	background: var(--background-secondary);
	border-bottom: 1px solid var(--background-modifier-border);
	flex: 0 0 auto;
}
.canvas-spacer { flex: 1; }
.canvas-count { color: var(--text-muted); font-size: 12px; }
.canvas-dirty { color: var(--text-accent); font-size: 18px; line-height: 1; }
.canvas-problems {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 6px 10px;
	font-size: 12px;
	color: var(--text-warning, var(--text-muted));
	border-bottom: 1px solid var(--background-modifier-border);
	flex: 0 0 auto;
}
.canvas-problems button {
	flex: 0 0 auto;
	font: inherit;
	padding: 2px 8px;
	border-radius: 4px;
	border: 1px solid var(--background-modifier-border);
	background: var(--background-primary);
	color: var(--text-normal);
	cursor: pointer;
}

.canvas-surface {
	position: relative;
	flex: 1 1 auto;
	min-height: 0;
	overflow: hidden;
	/* The dotted ground is what makes panning legible; without it an empty board looks
	   frozen because nothing moves. */
	background-image: radial-gradient(var(--background-modifier-border) 1px, transparent 1px);
	background-size: 24px 24px;
	touch-action: none;
	cursor: default;
}

.canvas-edges {
	position: absolute;
	left: 0; top: 0;
	overflow: visible;
	pointer-events: none;
}
.canvas-edge {
	fill: none;
	stroke: var(--text-faint, var(--text-muted));
	stroke-width: 2;
	pointer-events: none;
}
.canvas-edge.selected { stroke-width: 3; }
/* The click target: invisible, wide, and the only part that takes pointer events. */
.canvas-edge-hit {
	fill: none;
	stroke: transparent;
	stroke-width: 16;
	pointer-events: stroke;
	cursor: pointer;
}
.canvas-arrow { pointer-events: none; }
.canvas-edge-label {
	font-size: 11px;
	fill: var(--text-normal);
	paint-order: stroke;
	stroke: var(--background-primary);
	stroke-width: 4px;
	stroke-linejoin: round;
	pointer-events: none;
	user-select: none;
}
.canvas-edge.pending { stroke-dasharray: 6 4; opacity: .7; }

.canvas-card {
	position: absolute;
	box-sizing: border-box;
	background: var(--background-primary-alt, var(--background-primary));
	border: 1px solid var(--background-modifier-border);
	border-radius: 8px;
	overflow: hidden;
	display: flex;
	flex-direction: column;
	box-shadow: 0 1px 3px rgba(0, 0, 0, .18);
}
.canvas-card.selected {
	border-color: var(--text-accent);
	box-shadow: 0 0 0 2px var(--text-accent);
}
.canvas-card.is-entity { border-top: none; }

.entity-header { padding: 4px 8px; color: #fff; font-size: 11px; text-transform: uppercase; }
.entity-body { padding: 8px; overflow: hidden; }
.entity-body h3 { margin: 0 0 6px; font-size: 15px; }
.entity-row { display: flex; gap: 8px; font-size: 12px; color: var(--text-muted); }
.entity-row span:first-child { opacity: .75; }

.card-preview { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.card-stub, .card-text { padding: 10px; overflow: hidden; }
.card-text { white-space: pre-wrap; font-size: 13px; }

.card-link { display: flex; flex-direction: column; overflow: hidden; height: 100%; }
.link-thumb { flex: 0 0 55%; min-height: 0; overflow: hidden; }
.link-body { padding: 8px 10px 10px; overflow: hidden; }
.link-title { display: block; font-size: 13px; line-height: 1.3; }
.link-desc {
	margin: 4px 0 0;
	font-size: 12px;
	color: var(--text-muted);
	line-height: 1.35;
	/* Two lines, so a long description cannot push the host out of the card. */
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 2;
	overflow: hidden;
}
.link-host { display: block; margin-top: 6px; font-size: 11px; color: var(--text-accent); }
.link-status { display: block; margin-top: 2px; font-size: 11px; color: var(--text-muted); }

/* A drop target has to look like one, or nobody tries. */
.canvas-surface.drop-active {
	outline: 2px dashed var(--text-accent);
	outline-offset: -6px;
}
.stub-name { display: block; font-weight: 600; }
.stub-missing { display: block; font-size: 11px; color: var(--text-warning, var(--text-muted)); }
.stub-kind { display: block; font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.stub-hint { display: block; font-size: 11px; color: var(--text-faint, var(--text-muted)); margin-top: 6px; }

.canvas-group {
	position: absolute;
	box-sizing: border-box;
	border: 2px dashed var(--background-modifier-border);
	border-radius: 10px;
	background: var(--background-modifier-hover);
	opacity: .5;
}
.canvas-group.selected { border-color: var(--text-accent); }
.canvas-group-label {
	position: absolute; top: -22px; left: 4px;
	font-size: 12px; color: var(--text-muted);
}

.connect-handle {
	position: absolute;
	width: 11px; height: 11px;
	padding: 0;
	border-radius: 50%;
	border: 2px solid var(--background-primary);
	background: var(--text-accent);
	cursor: crosshair;
}
.connect-handle.top { top: -6px; left: calc(50% - 5px); }
.connect-handle.bottom { bottom: -6px; left: calc(50% - 5px); }
.connect-handle.left { left: -6px; top: calc(50% - 5px); }
.connect-handle.right { right: -6px; top: calc(50% - 5px); }

.resize-handle {
	position: absolute;
	right: 0; bottom: 0;
	width: 14px; height: 14px;
	padding: 0;
	border: none;
	background: linear-gradient(135deg, transparent 50%, var(--text-accent) 50%);
	cursor: nwse-resize;
}

.canvas-marquee {
	position: absolute;
	border: 1px solid var(--text-accent);
	background: var(--text-accent);
	opacity: .15;
	pointer-events: none;
}

.canvas-empty {
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	color: var(--text-muted);
	pointer-events: none;
}
.canvas-empty p { margin: 2px; }
</style>
