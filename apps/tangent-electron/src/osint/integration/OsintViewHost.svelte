<script lang="ts">
/**
 * Renders an Obsidian ItemView inside a Tangent panel.
 *
 * This is the only Svelte we write for the OSINT views. The views themselves are ~9,700
 * lines of imperative DOM built against Obsidian's API; rather than rewrite them, this
 * component adopts the ItemView's own containerEl and drives its lifecycle. That is what
 * keeps the port cheap.
 *
 * The container is adopted rather than recreated: onOpen() has already populated it, and
 * moving the element preserves everything the view built — cytoscape's canvas, leaflet's
 * map, the chat transcript and its scroll position — across panel remounts.
 */
import { onDestroy, onMount } from 'svelte'
import { osintPluginState, graphFeaturesEnabled, type OsintPluginState } from './osint-plugin-state'
import { viewForViewType } from './osint-view-types'
import { openOsintSettings } from './open-view'

export let state: { osintViewType: string, osintLeaf: Promise<any> }
// Props NodeViewSelector passes to every view component. Accepted and unused.
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

let container: HTMLElement
let error: string = null
let mounted = false

const descriptor = viewForViewType(state.osintViewType)
let pluginState: OsintPluginState = osintPluginState.value
const unsubscribeState = osintPluginState.subscribe((next) => { pluginState = next })
/** Startup threw: say so now instead of after the 60-second wait, and say the right thing. */
$: startupFailed = pluginState.failed
/**
 * The setting turned this view off after it was restored into the thread. The toolbar
 * hides the button, but a saved session can still carry the node; without this the view
 * mounted over an entity store that was never initialised and showed an empty graph with
 * no explanation and no button to leave by.
 */
$: gated = pluginState.ready && !!descriptor?.requiresGraphFeatures && !graphFeaturesEnabled(pluginState)
/** Views that are a viewport (canvas/map) keep a floor in auto layout; flow views do not. */
const needsViewport = descriptor?.viewType === 'graph_copilot-graph-view' || descriptor?.viewType === 'graph_copilot-map-view'
/** Held synchronously so onDestroy does not have to re-await the leaf promise. */
let attachedView: any = null

async function attach() {
	try {
		const leaf = await state.osintLeaf
		if (!leaf?.view) {
			error = pluginState.failed
				? `OSINT Copilot did not start: ${pluginState.failed}`
				: `No view was registered for "${state.osintViewType}".`
			return
		}
		if (!mounted || !container) return
		container.appendChild(leaf.view.containerEl)
		attachedView = leaf.view
		// Next frame, so the element has actually been through layout: a view that
		// measures its own container (Leaflet needs invalidateSize) reads a real box
		// rather than the 0x0 it had while detached. Panel and width transitions are
		// still running -- the view's own ResizeObserver covers those.
		requestAnimationFrame(() => {
			if (attachedView === leaf.view && leaf.view.containerEl.isConnected) {
				leaf.view.attachedToDocument?.()
			}
		})
		onViewReady?.()
	}
	catch (e) {
		error = String(e?.message ?? e)
		console.error('[osint] could not mount view', state.osintViewType, e)
	}
}

onMount(() => {
	mounted = true
	attach()
})

onDestroy(() => {
	mounted = false
	unsubscribeState()
	// Detach without unloading: the view stays alive so getLeavesOfType() keeps finding
	// it and background refreshes keep working. Its DOM is re-adopted on the next mount.
	//
	// Synchronous, unlike the promise this used to await: that microtask could run after
	// a new host had already adopted the element, and then remove it out from under it.
	const view = attachedView
	attachedView = null
	const el = view?.containerEl
	if (el?.parentElement === container) container.removeChild(el)
	// After the removal, so isConnected truthfully answers "did it really detach".
	view?.detachedFromDocument?.()
})
</script>

<div
	class="OsintViewHost {layout}"
	class:no-background={background === 'none'}
	class:needs-viewport={needsViewport}
	class:gated
	style:--osint-extra-top={extraTop + 'px'}
	style:--osint-extra-bottom={extraBottom + 'px'}
	bind:this={container}
>
	{#if startupFailed && !error}
		<p class="osint-view-error">OSINT Copilot did not start: {startupFailed}. See the developer console for details.</p>
	{:else if error}
		<p class="osint-view-error">{error}</p>
	{/if}
	{#if gated}
		<div class="osint-view-gated">
			<p><strong>{descriptor?.label}</strong> is turned off.</p>
			<p>Graph features are disabled in this vault's settings, so this view has nothing to show.</p>
			<button on:click={() => openOsintSettings()}>Open Tangent settings</button>
		</div>
	{/if}
</div>

<style>
.OsintViewHost {
	position: absolute;
	left: 0;
	right: 0;
	top: var(--osint-extra-top, 0px);
	bottom: var(--osint-extra-bottom, 0px);
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
/*
 * position: relative here, where `top` would shift the box without reserving space and
 * `bottom` would do nothing at all. Tangent's own views reserve it with padding --
 * ImageView.svelte:122-123, PdfView.svelte:206-207 -- so this does the same, from the
 * same two variables.
 */
.OsintViewHost.auto {
	position: relative;
	top: auto;
	bottom: auto;
	padding-top: var(--osint-extra-top, 0px);
	padding-bottom: var(--osint-extra-bottom, 0px);
	box-sizing: border-box;
}
/* A viewport (graph, map) needs room to be usable; a flow view (chat, timeline) sizes to content. */
.OsintViewHost.auto.needs-viewport { min-height: 24em; }
/* Honour Tangent's transparent-background request the way the canvas does. */
.OsintViewHost.no-background :global(.view-content) { background: transparent; }
/* While gated, the Obsidian view stays attached (getLeavesOfType still finds it) but hidden. */
.OsintViewHost.gated :global(> .workspace-leaf-content) { display: none; }
.osint-view-gated {
	padding: 2em;
	max-width: 40em;
	color: var(--text-muted);
}
.osint-view-gated p { margin: 0 0 .75em; }
.osint-view-gated button {
	font: inherit;
	padding: .4em .9em;
	border-radius: var(--radius-s, 4px);
	border: 1px solid var(--background-modifier-border);
	background: var(--interactive-normal);
	color: var(--text-normal);
	cursor: pointer;
}
/* The Obsidian view's own container fills the panel. */
.OsintViewHost :global(> .workspace-leaf-content) {
	flex: 1 1 auto;
	min-height: 0;
	display: flex;
	flex-direction: column;
}
.osint-view-error {
	padding: 2em;
	opacity: .7;
}
</style>
