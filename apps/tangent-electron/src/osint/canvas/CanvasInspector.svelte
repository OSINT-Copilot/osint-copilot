<script lang="ts">
/**
 * The edit surface for whatever is selected: an edge's label, colour, sides and arrows;
 * a link's URL; a text card's text; a group's label.
 *
 * A panel rather than a modal or a context menu. The other OSINT views hand-build absolutely
 * positioned menus because they are imperative DOM inside an Obsidian ItemView; this is a
 * Svelte lens, and a panel stays open while you nudge a colour or retype a label, which is
 * what editing actually looks like. It also gives edges somewhere to be edited at all --
 * a curve is a poor click target for a menu.
 */
import type { CanvasDocumentStore } from './canvas-document'
import type { CanvasNode, CanvasEdge, CanvasSide, CanvasEnd } from './canvas-format'
import { displayHost } from './canvas-link-preview'

export let store: CanvasDocumentStore
export let node: CanvasNode | null = null
export let edge: CanvasEdge | null = null
export let onRefetchLink: ((node: CanvasNode) => void) | null = null
export let onClose: (() => void) | null = null

const SIDES: CanvasSide[] = ['top', 'right', 'bottom', 'left']
const ENDS: CanvasEnd[] = ['none', 'arrow']

/**
 * JSON Canvas presets "1".."6" plus a cleared state.
 *
 * The preset numbers are written rather than hex, because Obsidian renders those with its
 * own theme-aware palette -- writing hex would pin the colour to whatever theme we happened
 * to be in and look wrong in the other app.
 */
const PRESETS: { value: string | undefined, label: string, css: string }[] = [
	{ value: undefined, label: 'None', css: 'transparent' },
	{ value: '1', label: 'Red', css: '#e5534b' },
	{ value: '2', label: 'Orange', css: '#e08c39' },
	{ value: '3', label: 'Yellow', css: '#d9a406' },
	{ value: '4', label: 'Green', css: '#4a9d5f' },
	{ value: '5', label: 'Cyan', css: '#3d9fa8' },
	{ value: '6', label: 'Purple', css: '#8b62c9' },
]

function setEdge(changes: Partial<CanvasEdge>) {
	if (edge) store.updateEdge(edge.id, changes)
}

function setNode(changes: Partial<CanvasNode>) {
	if (node) store.updateNode(node.id, changes as Partial<CanvasNode>)
}
</script>

<aside class="CanvasInspector">
	<header>
		<span class="title">
			{#if edge}Connection
			{:else if node}{node.type === 'file' ? 'Card' : node.type} card
			{:else}Nothing selected{/if}
		</span>
		{#if onClose}<button class="close" title="Close" on:click={onClose}>×</button>{/if}
	</header>

	{#if edge}
		<label class="field">
			<span>Label</span>
			<input
				type="text"
				placeholder="e.g. paid, met, owns"
				value={edge.label ?? ''}
				on:input={(e) => setEdge({ label: e.currentTarget.value || undefined })}
			/>
		</label>

		<div class="field">
			<span>Colour</span>
			<div class="swatches">
				{#each PRESETS as preset (preset.label)}
					<button
						class="swatch"
						class:active={edge.color === preset.value}
						class:none={preset.value === undefined}
						style:background={preset.css}
						title={preset.label}
						on:click={() => setEdge({ color: preset.value })}
					></button>
				{/each}
			</div>
		</div>

		<div class="field two">
			<label>
				<span>From side</span>
				<select
					value={edge.fromSide ?? ''}
					on:change={(e) => setEdge({ fromSide: (e.currentTarget.value || undefined) as CanvasSide })}
				>
					<option value="">Automatic</option>
					{#each SIDES as side (side)}<option value={side}>{side}</option>{/each}
				</select>
			</label>
			<label>
				<span>To side</span>
				<select
					value={edge.toSide ?? ''}
					on:change={(e) => setEdge({ toSide: (e.currentTarget.value || undefined) as CanvasSide })}
				>
					<option value="">Automatic</option>
					{#each SIDES as side (side)}<option value={side}>{side}</option>{/each}
				</select>
			</label>
		</div>

		<div class="field two">
			<label>
				<span>Start</span>
				<select
					value={edge.fromEnd ?? 'none'}
					on:change={(e) => setEdge({ fromEnd: e.currentTarget.value as CanvasEnd })}
				>
					{#each ENDS as end (end)}<option value={end}>{end}</option>{/each}
				</select>
			</label>
			<label>
				<span>End</span>
				<select
					value={edge.toEnd ?? 'arrow'}
					on:change={(e) => setEdge({ toEnd: e.currentTarget.value as CanvasEnd })}
				>
					{#each ENDS as end (end)}<option value={end}>{end}</option>{/each}
				</select>
			</label>
		</div>

		<p class="note">
			A connection here is a drawing. It is not written to the entity graph.
		</p>

		<button class="danger" on:click={() => store.removeEdges(new Set([edge.id]))}>
			Delete connection
		</button>

	{:else if node}
		{#if node.type === 'link'}
			<label class="field">
				<span>URL</span>
				<input
					type="text"
					value={node.url}
					on:change={(e) => setNode({ url: e.currentTarget.value } )}
				/>
			</label>
			<div class="field">
				<span>Preview</span>
				<p class="note">
					{#if node.extra.osintLinkTitle}
						Saved from {displayHost(node.url)}. Refreshing fetches the page again.
					{:else}
						No preview saved. Fetching requests the page from {displayHost(node.url)}.
					{/if}
				</p>
				<button on:click={() => onRefetchLink?.(node)}>
					{node.extra.osintLinkTitle ? 'Refresh preview' : 'Fetch preview'}
				</button>
			</div>
		{:else if node.type === 'text'}
			<label class="field">
				<span>Text</span>
				<textarea
					rows="6"
					value={node.text}
					on:input={(e) => setNode({ text: e.currentTarget.value })}
				></textarea>
			</label>
		{:else if node.type === 'group'}
			<label class="field">
				<span>Label</span>
				<input
					type="text"
					value={node.label ?? ''}
					on:input={(e) => setNode({ label: e.currentTarget.value || undefined })}
				/>
			</label>
		{:else if node.type === 'file'}
			<div class="field">
				<span>File</span>
				<p class="path">{node.file}</p>
			</div>
		{/if}

		<div class="field">
			<span>Colour</span>
			<div class="swatches">
				{#each PRESETS as preset (preset.label)}
					<button
						class="swatch"
						class:active={node.color === preset.value}
						class:none={preset.value === undefined}
						style:background={preset.css}
						title={preset.label}
						on:click={() => setNode({ color: preset.value })}
					></button>
				{/each}
			</div>
		</div>

		<button class="danger" on:click={() => store.removeNodes(new Set([node.id]))}>
			Delete card
		</button>
	{/if}
</aside>

<style>
.CanvasInspector {
	position: absolute;
	top: 8px;
	right: 8px;
	width: 260px;
	max-height: calc(100% - 16px);
	overflow-y: auto;
	padding: 10px 12px 14px;
	box-sizing: border-box;
	background: var(--background-secondary);
	border: 1px solid var(--background-modifier-border);
	border-radius: 8px;
	box-shadow: 0 2px 10px rgba(0, 0, 0, .25);
	font-size: 12px;
	z-index: 10;
}
header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 8px;
}
.title { font-weight: 600; text-transform: capitalize; }
.close {
	border: none;
	background: none;
	color: var(--text-muted);
	font-size: 16px;
	line-height: 1;
	cursor: pointer;
	padding: 0 2px;
}
.field { display: block; margin-bottom: 10px; }
.field > span { display: block; color: var(--text-muted); margin-bottom: 3px; }
.field.two { display: flex; gap: 8px; }
.field.two label { flex: 1; }
.field.two label span { display: block; color: var(--text-muted); margin-bottom: 3px; }
input[type="text"], select, textarea {
	width: 100%;
	box-sizing: border-box;
	font: inherit;
	padding: 4px 6px;
	background: var(--background-primary);
	color: var(--text-normal);
	border: 1px solid var(--background-modifier-border);
	border-radius: 4px;
}
textarea { resize: vertical; }
.swatches { display: flex; gap: 5px; flex-wrap: wrap; }
.swatch {
	width: 20px;
	height: 20px;
	border-radius: 50%;
	border: 2px solid transparent;
	cursor: pointer;
	padding: 0;
}
.swatch.none {
	border-color: var(--background-modifier-border);
	position: relative;
}
/* A diagonal bar, so "no colour" is not an invisible button. */
.swatch.none::after {
	content: '';
	position: absolute;
	inset: 3px;
	border-top: 2px solid var(--text-faint, var(--text-muted));
	transform: rotate(-45deg);
	transform-origin: center;
}
.swatch.active { border-color: var(--text-accent); }
.note { color: var(--text-muted); margin: 4px 0 6px; line-height: 1.35; }
.path { word-break: break-all; color: var(--text-muted); margin: 0; }
button {
	font: inherit;
	padding: 4px 8px;
	border-radius: 4px;
	border: 1px solid var(--background-modifier-border);
	background: var(--background-primary);
	color: var(--text-normal);
	cursor: pointer;
}
button.danger { color: var(--text-error, #e5534b); width: 100%; }
</style>
