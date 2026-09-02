<script lang="ts">
/**
 * OSINT Copilot's settings, as a page in Tangent's preferences.
 *
 * The plugin's settings tab is ~975 lines of imperative DOM building roughly 70 rows —
 * CLI paths, agent runtimes, task agents, schema families, the Miro import. Rather than
 * port that to Svelte, this adopts the tab's own containerEl, the same way OsintViewHost
 * adopts a view's. display() is re-run on mount because the tab rebuilds its rows from
 * current settings each time it is shown, which is how it picks up changes made
 * elsewhere (a new custom runtime, an installed prompt file).
 */
import { onDestroy, onMount } from 'svelte'

let container: HTMLElement
let message: string = null

onMount(() => {
	const runtime = (globalThis as any).osint
	if (!runtime) {
		message = 'OSINT Copilot has not finished starting up. Reopen this page in a moment.'
		return
	}
	const tab = runtime.plugin?.settingTab
	if (!tab) {
		message = 'OSINT Copilot did not register a settings tab.'
		return
	}
	try {
		container.appendChild(tab.containerEl)
		tab.display()
	}
	catch (e) {
		message = String(e?.message ?? e)
		console.error('[osint] settings tab failed to render', e)
	}
})

onDestroy(() => {
	const tab = (globalThis as any).osint?.plugin?.settingTab
	// hide() lets the tab drop listeners; the element is left detached for the next mount.
	try { tab?.hide?.() } catch { /* the tab may not implement it */ }
	const el = tab?.containerEl
	if (el?.parentElement === container) container.removeChild(el)
})
</script>

<div class="OsintSettings" bind:this={container}>
	{#if message}<p class="message">{message}</p>{/if}
</div>

<style>
.OsintSettings { padding-bottom: 2em; }
.message { opacity: .7; }
</style>
