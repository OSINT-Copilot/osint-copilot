<script lang="ts">
/**
 * Picks a vault file to put on the board, or takes a URL for a link card.
 *
 * Built here rather than reaching for Tangent's quick-open or the obsidian-shim Modal:
 * both are tied to machinery a Svelte lens does not own, and the list this needs is small
 * enough that borrowing either would cost more than it saved.
 */
import { vaultFiles } from './canvas-runtime'
import { isFetchableUrl } from './canvas-link-preview'

export let mode: 'file' | 'image' | 'link'
export let onPick: (value: string) => void
export let onCancel: () => void

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'])

/**
 * Machine-owned trees the analyst never means to put on a board.
 *
 * The picker lists the whole vault, which includes the plugin's own settings, Tangent's
 * session state and the YAML mirror of the entity graph -- offering `.osint-copilot/
 * data.json` as a card is noise at best and an invitation to a confusing mistake.
 */
function isInternal(path: string): boolean {
	if (path.split('/').some((segment) => segment.startsWith('.'))) return true
	return path.includes('/graph-yaml/') || path.startsWith('graph-yaml/')
}

let query = ''
let url = ''
let input: HTMLInputElement | undefined

$: all = mode === 'link' ? [] : vaultFiles().filter((file) => {
	if (isInternal(file.path)) return false
	if (mode !== 'image') return true
	return IMAGE_EXTENSIONS.has(file.extension.toLowerCase())
})

$: needle = query.trim().toLowerCase()
$: matches = needle
	? all.filter((f) => f.path.toLowerCase().includes(needle)).slice(0, 200)
	// Unfiltered, this is every file in the vault; a cap keeps the first paint cheap.
	: all.slice(0, 200)

$: urlLooksUsable = isFetchableUrl(url.trim())

function submitUrl() {
	if (urlLooksUsable) onPick(url.trim())
}

function onKeyDown(event: KeyboardEvent) {
	if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
	if (event.key === 'Enter' && mode === 'link') submitUrl()
}

// Focus on open, so the picker is usable without reaching for the mouse.
$: if (input) input.focus()
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="CanvasPickerBackdrop" on:click={onCancel} on:keydown={onKeyDown} role="presentation">
	<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
	<div class="CanvasPicker" on:click|stopPropagation role="dialog" aria-label="Add to canvas">
		{#if mode === 'link'}
			<h3>Add a link</h3>
			<input
				bind:this={input}
				bind:value={url}
				type="text"
				placeholder="https://example.org/article"
				on:keydown={onKeyDown}
			/>
			<p class="note">
				Adding a link fetches the page for its title and thumbnail, so the site is told you
				saved it. The result is stored in the board and not fetched again.
			</p>
			<div class="actions">
				<button on:click={onCancel}>Cancel</button>
				<button class="primary" disabled={!urlLooksUsable} on:click={submitUrl}>Add link</button>
			</div>
		{:else}
			<h3>{mode === 'image' ? 'Add an image' : 'Add a file'}</h3>
			<input
				bind:this={input}
				bind:value={query}
				type="text"
				placeholder="Search the vault…"
				on:keydown={onKeyDown}
			/>
			<ul>
				{#each matches as file (file.path)}
					<li>
						<button on:click={() => onPick(file.path)}>
							<span class="name">{file.name}</span>
							<span class="path">{file.path}</span>
						</button>
					</li>
				{:else}
					<li class="empty">
						{mode === 'image' ? 'No images in this vault yet.' : 'Nothing matches.'}
					</li>
				{/each}
			</ul>
			<p class="note">You can also drag a file in from the sidebar, or drop one from your desktop.</p>
			<div class="actions"><button on:click={onCancel}>Cancel</button></div>
		{/if}
	</div>
</div>

<style>
.CanvasPickerBackdrop {
	position: absolute;
	inset: 0;
	background: rgba(0, 0, 0, .35);
	display: flex;
	align-items: flex-start;
	justify-content: center;
	padding-top: 12vh;
	z-index: 20;
}
.CanvasPicker {
	width: min(520px, 90%);
	max-height: 60vh;
	display: flex;
	flex-direction: column;
	background: var(--background-secondary);
	border: 1px solid var(--background-modifier-border);
	border-radius: 10px;
	box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
	padding: 14px 16px 12px;
	box-sizing: border-box;
}
h3 { margin: 0 0 10px; font-size: 15px; }
input {
	width: 100%;
	box-sizing: border-box;
	font: inherit;
	padding: 6px 8px;
	background: var(--background-primary);
	color: var(--text-normal);
	border: 1px solid var(--background-modifier-border);
	border-radius: 5px;
}
ul {
	list-style: none;
	margin: 10px 0 0;
	padding: 0;
	overflow-y: auto;
	flex: 1 1 auto;
	min-height: 0;
}
li button {
	display: block;
	width: 100%;
	text-align: left;
	background: none;
	border: none;
	border-radius: 5px;
	padding: 5px 7px;
	color: var(--text-normal);
	cursor: pointer;
	font: inherit;
}
li button:hover { background: var(--background-modifier-hover); }
.name { display: block; }
.path { display: block; font-size: 11px; color: var(--text-muted); }
.empty { color: var(--text-muted); padding: 8px 4px; }
.note { color: var(--text-muted); font-size: 11px; line-height: 1.4; margin: 10px 0 0; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.actions button {
	font: inherit;
	padding: 5px 12px;
	border-radius: 5px;
	border: 1px solid var(--background-modifier-border);
	background: var(--background-primary);
	color: var(--text-normal);
	cursor: pointer;
}
.actions button.primary {
	background: var(--interactive-accent, var(--text-accent));
	border-color: transparent;
	color: var(--text-on-accent, #fff);
}
.actions button:disabled { opacity: .5; cursor: default; }
</style>
