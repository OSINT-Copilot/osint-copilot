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

async function attach() {
	try {
		const leaf = await state.osintLeaf
		if (!leaf?.view) {
			error = `No view was registered for "${state.osintViewType}".`
			return
		}
		if (!mounted || !container) return
		container.appendChild(leaf.view.containerEl)
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
	// Detach without unloading: the view stays alive so getLeavesOfType() keeps finding
	// it and background refreshes keep working. Its DOM is re-adopted on the next mount.
	state.osintLeaf?.then(leaf => {
		const el = leaf?.view?.containerEl
		if (el?.parentElement === container) container.removeChild(el)
	}).catch(() => {})
})
</script>

<div
	class="OsintViewHost {layout}"
	style:top={extraTop + 'px'}
	style:bottom={extraBottom + 'px'}
	bind:this={container}
>
	{#if error}
		<p class="osint-view-error">{error}</p>
	{/if}
</div>

<style>
.OsintViewHost {
	position: absolute;
	left: 0;
	right: 0;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}
.OsintViewHost.auto {
	position: relative;
	min-height: 24em;
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
