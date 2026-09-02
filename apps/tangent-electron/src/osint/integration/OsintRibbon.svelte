<script lang="ts">
/**
 * The plugin's ribbon icons, in Tangent's top bar.
 *
 * Obsidian gives a plugin a ribbon rail; Tangent has no such thing, so its registrations
 * are rendered here instead — one button per addRibbonIcon() call, in registration order,
 * using the lucide icon the plugin asked for.
 *
 * The raw MouseEvent is forwarded to the callback rather than swallowed: every one of the
 * five handlers checks Ctrl/Cmd-click to open the view in a new pane, and that behaviour
 * is lost if the event is not passed through.
 */
import { onDestroy, onMount } from 'svelte'
import { setIcon } from '../obsidian-shim/ui/set-icon'

interface RibbonAction {
	icon: string
	title: string
	callback: (event: MouseEvent) => unknown
}

let actions: RibbonAction[] = []
let mounted = false

async function waitForRibbon(timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const found = (globalThis as any).osint?.plugin?.ribbonActions
		// The plugin registers ribbons partway through startup; wait for a non-empty list.
		if (found?.length) return found as RibbonAction[]
		await new Promise(resolve => setTimeout(resolve, 200))
	}
	return []
}

onMount(async () => {
	mounted = true
	const found = await waitForRibbon()
	if (mounted) actions = found
})

onDestroy(() => { mounted = false })

/** Renders the lucide SVG the plugin named into the button. */
function icon(node: HTMLElement, name: string) {
	try { setIcon(node, name) }
	catch (e) { console.error('[osint] unknown ribbon icon', name, e) }
	return {}
}

function run(action: RibbonAction, event: MouseEvent) {
	try { action.callback(event) }
	catch (e) { console.error('[osint] ribbon action failed', action.title, e) }
}
</script>

{#if actions.length}
	<span class="OsintRibbon">
		{#each actions as action (action.title)}
			<!-- svelte-ignore a11y_consider_explicit_label -->
			<button
				class="subtle"
				title={action.title}
				aria-label={action.title}
				on:click={event => run(action, event)}
			>
				<span class="icon" use:icon={action.icon}></span>
			</button>
		{/each}
	</span>
{/if}

<style>
.OsintRibbon {
	display: inline-flex;
	align-items: center;
}
.OsintRibbon .icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
}
.OsintRibbon :global(svg) {
	width: 1.15em;
	height: 1.15em;
	stroke: currentColor;
	fill: none;
}
</style>
