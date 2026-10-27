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
import ExtensionSettings from './ExtensionSettings.svelte'

let container: HTMLElement
let message: string = null

let mounted = false

/**
 * Waits for the plugin rather than telling the user to come back later. Tangent restores
 * whichever preferences page was open last, so this can mount before the plugin — whose
 * startup reads schemas and prompts off disk — has finished.
 */
async function waitForSettingTab(timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const tab = (globalThis as any).osint?.plugin?.settingTab
		if (tab) return tab
		await new Promise(resolve => setTimeout(resolve, 100))
	}
	return null
}

onMount(async () => {
	mounted = true
	message = 'Loading OSINT Copilot settings…'
	const tab = await waitForSettingTab()
	if (!mounted) return
	if (!tab) {
		message = 'OSINT Copilot did not start. See the developer console for details.'
		return
	}
	try {
		message = null
		container.appendChild(tab.containerEl)
		tab.display()
	}
	catch (e) {
		message = String(e?.message ?? e)
		console.error('[osint] settings tab failed to render', e)
	}
})

onDestroy(() => {
	mounted = false
	const tab = (globalThis as any).osint?.plugin?.settingTab
	// hide() lets the tab drop listeners; the element is left detached for the next mount.
	try { tab?.hide?.() } catch { /* the tab may not implement it */ }
	const el = tab?.containerEl
	if (el?.parentElement === container) container.removeChild(el)
})
</script>

<!-- Svelte, not a row in the tab: it needs a live countdown and main's status. -->
<ExtensionSettings />
<div class="OsintSettings" bind:this={container}>
	{#if message}<p class="message">{message}</p>{/if}
</div>

<style>
.OsintSettings { padding-bottom: 2em; }
.message { opacity: .7; }
</style>
