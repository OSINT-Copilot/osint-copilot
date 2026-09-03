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
import { CanvasDocumentStore, nodeRect } from './canvas-document'
import { vaultFileStore, vaultRelativePath, absoluteVaultPath, entityCardData, entitiesByNotePath, openEntityNote } from './canvas-runtime'
import {
	defaultViewport, screenToWorld, worldToScreen, zoomAbout, scaleFromWheel, panBy,
	visibleWorldRect, cullToViewport, fitToRects, rectFromCorners, rectsIntersect,
	sideAnchor, inferSide, oppositeSide, edgePath, LIVE_PREVIEW_MIN_SCALE,
	type Viewport, type Rect, type Side,
} from './canvas-viewport'
import type { CanvasNode, CanvasFileNode, CanvasTextNode, CanvasLinkNode, CanvasGroupNode } from './canvas-format'

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

// Tangent gives absolute paths; the vault adapter wants vault-relative ones.
const store = new CanvasDocumentStore(vaultRelativePath(state.canvasNode.path), vaultFileStore())
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

function onSurfacePointerDown(event: PointerEvent) {
	if (event.button === 1 || event.shiftKey === false && event.button === 2) return
	surface.setPointerCapture(event.pointerId)
	if (event.button === 1 || event.altKey) {
		gesture = { kind: 'pan', lastX: event.clientX, lastY: event.clientY }
		return
	}
	// A drag on empty board is a marquee; a plain click clears the selection.
	const origin = worldPoint(event)
	gesture = { kind: 'marquee', originWorld: origin, currentWorld: origin }
	if (!event.shiftKey) store.clearSelection()
}

function onCardPointerDown(event: PointerEvent, node: CanvasNode) {
	event.stopPropagation()
	surface.setPointerCapture(event.pointerId)
	if (event.button === 1 || event.altKey) {
		gesture = { kind: 'pan', lastX: event.clientX, lastY: event.clientY }
		return
	}
	// Dragging an unselected card selects it first, so the drag moves what you grabbed.
	if (!docState.selectedNodes.has(node.id)) {
		store.toggleNodeSelected(node.id, event.shiftKey)
	} else if (event.shiftKey) {
		store.toggleNodeSelected(node.id, true)
	}
	gesture = { kind: 'move', lastWorld: worldPoint(event) }
}

function onResizePointerDown(event: PointerEvent, node: CanvasNode) {
	event.stopPropagation()
	surface.setPointerCapture(event.pointerId)
	gesture = { kind: 'resize', id: node.id, startRect: nodeRect(node), startWorld: worldPoint(event) }
}

function onConnectPointerDown(event: PointerEvent, node: CanvasNode, side: Side) {
	event.stopPropagation()
	surface.setPointerCapture(event.pointerId)
	gesture = { kind: 'connect', fromId: node.id, fromSide: side, currentWorld: worldPoint(event) }
}

function onPointerMove(event: PointerEvent) {
	if (!gesture) return
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

function onPointerUp(event: PointerEvent) {
	if (!gesture) return
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
	gesture = null
	if (surface.hasPointerCapture?.(event.pointerId)) surface.releasePointerCapture(event.pointerId)
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
		gesture = null
	}
}

function centreOfView() {
	return screenToWorld(viewport, { x: width / 2, y: height / 2 })
}

function addTextCard() {
	const node = store.addNodeAt('text', centreOfView(), { width: 320, height: 180 } as any)
	store.setSelection([node.id])
}

function fitAll() {
	if (nodes.length === 0 || width === 0) return
	viewport = fitToRects(nodes.map(nodeRect), width, height)
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
		window.open((node as CanvasLinkNode).url, '_blank')
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
$: edgeGeometry = edges.map((edge) => ({ edge, d: pathFor(edge, viewport, nodeById) }))

function pathFor(
	edge: { fromNode: string, toNode: string, fromSide?: Side, toSide?: Side },
	view: Viewport,
	byId: Map<string, CanvasNode>,
) {
	const from = byId.get(edge.fromNode)
	const to = byId.get(edge.toNode)
	if (!from || !to) return ''
	const fromRect = nodeRect(from)
	const toRect = nodeRect(to)
	// fromSide/toSide are optional in JSON Canvas, so a file written elsewhere may omit
	// them; infer the pair that reads as the obvious way round.
	const fromSide = edge.fromSide ?? inferSide(fromRect, toRect)
	const toSide = edge.toSide ?? oppositeSide(fromSide)
	const start = worldToScreen(view, sideAnchor(fromRect, fromSide))
	const end = worldToScreen(view, sideAnchor(toRect, toSide))
	return edgePath(start, fromSide, end, toSide)
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
		<button on:click={fitAll} disabled={nodes.length === 0} title="Fit everything on screen">⊡ fit</button>
		<span class="canvas-spacer"></span>
		<span class="canvas-count">{nodes.length} card{nodes.length === 1 ? '' : 's'}</span>
		{#if docState.dirty}<span class="canvas-dirty" title="Unsaved changes">•</span>{/if}
	</div>

	{#if docState.problems.length > 0}
		<div class="canvas-problems" title={docState.problems.join('\n')}>
			{docState.problems.length} item{docState.problems.length === 1 ? '' : 's'} in this canvas could not be read.
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
		on:pointercancel={onPointerUp}
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
			{#each edgeGeometry as { edge, d } (edge.id)}
				<path
					class="canvas-edge"
					class:selected={docState.selectedEdges.has(edge.id)}
					{d}
					on:pointerdown={(e) => { e.stopPropagation(); store.toggleEdgeSelected(edge.id, e.shiftKey) }}
				/>
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
					{@const target = treeNodeFor((node as CanvasFileNode).file)}
					{#if target && livePreviews}
						<div class="card-preview"><NodePreview item={target} layout="fill" background="none" /></div>
					{:else}
						<div class="card-stub">
							<span class="stub-name">{(node as CanvasFileNode).file.split('/').pop()}</span>
							{#if !target}<span class="stub-missing">missing from the vault</span>{/if}
						</div>
					{/if}
				{:else if node.type === 'text'}
					<div class="card-text">{(node as CanvasTextNode).text}</div>
				{:else if node.type === 'link'}
					<div class="card-link">{(node as CanvasLinkNode).url}</div>
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
				<p>Add a text card, or drop a note onto the board.</p>
			</div>
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
	padding: 6px 10px;
	font-size: 12px;
	color: var(--text-warning, var(--text-muted));
	border-bottom: 1px solid var(--background-modifier-border);
	flex: 0 0 auto;
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
	pointer-events: stroke;
	cursor: pointer;
}
.canvas-edge.selected { stroke: var(--text-accent); stroke-width: 3; }
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
.card-stub, .card-text, .card-link { padding: 10px; overflow: hidden; }
.card-text { white-space: pre-wrap; font-size: 13px; }
.card-link { color: var(--text-accent); word-break: break-all; font-size: 13px; }
.stub-name { display: block; font-weight: 600; }
.stub-missing { display: block; font-size: 11px; color: var(--text-warning, var(--text-muted)); }

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
