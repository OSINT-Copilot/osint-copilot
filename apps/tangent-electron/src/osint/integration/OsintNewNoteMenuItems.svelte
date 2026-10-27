<script lang="ts">
/**
 * "New Canvas Board", in Tangent's New Note menu.
 *
 * A board is a document the user creates, not a view they switch to, so it belongs with
 * the creation rules rather than in the views pill where the old ribbon put it. The
 * command is not gated by the graph-features setting for the same reason.
 *
 * Styles are carried here because WorkspaceView's `.popUpButtonList.newNotes button`
 * rules are component-scoped and do not apply inside a child component.
 */
import { getContext } from 'svelte'
import command from 'app/model/commands/CommandAction'
import { lucideSvg } from './lucide-svg'

const workspace: any = getContext('workspace')
</script>

<div class="separator"></div>
<button
	class="no-callout new-canvas"
	use:command={{ command: workspace.commands.osintNewCanvas, tooltipShortcut: false }}
>
	<span class="icon">{@html lucideSvg('layout-dashboard')}</span>
	<span class="name">New Canvas Board</span>
</button>

<style>
.separator {
	border-top: 1px solid var(--borderColor);
	margin: .35em 0;
	opacity: .7;
}
.new-canvas {
	display: flex;
	width: 100%;
	align-items: center;
	font-size: .9rem;
	padding-top: .1em;
	padding-bottom: .1em;
}
.icon {
	display: inline-flex;
	margin: 0 .6em 0 .25em;
}
.icon :global(svg) {
	width: 1.2em;
	height: 1.2em;
	stroke: var(--iconStroke);
	stroke-width: 1.5;
	fill: none;
}
.name {
	flex-grow: 1;
	text-align: left;
}
</style>
