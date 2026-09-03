<script lang="ts">
/**
 * The OSINT views, as one button group in Tangent's top bar.
 *
 * Sits right after the Map/Thread/Focus group and is built the same way: a `.buttonGroup`
 * of `.subtle` buttons driven by `use:command`. That one action gives every button its
 * Tangent tooltip with the shortcut in it, its disabled state, and the `checked`
 * highlight for the current view -- all from OpenOsintViewCommand, none from here.
 *
 * This replaces OsintRibbon, which rendered lucide at 18px in a different grey with OS
 * tooltips and no active state, on the far side of the bar next to search.
 */
import { getContext } from 'svelte'
import command from 'app/model/commands/CommandAction'
import { OSINT_VIEWS } from './osint-view-types'
import { lucideSvg } from './lucide-svg'
import { osintPluginState, graphFeaturesEnabled } from './osint-plugin-state'

const workspace: any = getContext('workspace')

// Hidden rather than disabled while graph features are off: three permanently grey
// buttons would cost toolbar width for nothing, and the ribbon hid them too. The store
// makes this live, where the ribbon read the setting once at startup.
$: views = OSINT_VIEWS.filter(v => !v.requiresGraphFeatures || graphFeaturesEnabled($osintPluginState))
</script>

<!--
  The spacer carries its own drag region. WorkspaceView's `nav .spacer { -webkit-app-region:
  drag }` is component-scoped and does not reach into a child, so without this the gap
  before the pill would be the one place in the bar you could not drag the window from.
-->
<div class="spacer"></div>
<span class="buttonGroup OsintViewsPill">
	{#each views as view (view.viewType)}
		<!-- svelte-ignore a11y_consider_explicit_label -->
		<button
			class="subtle"
			aria-label={view.label}
			use:command={{ command: workspace.commands[view.commandKey] }}
		>{@html lucideSvg(view.icon)}</button>
	{/each}
</span>

<style>
.spacer {
	-webkit-app-region: drag;
}
/*
 * Lucide drawn to Tangent's icon metrics. Tangent's sprites are 32-unit with a 2-unit
 * stroke, rendered at 24px -- a 1.5px line. Lucide is 24-unit with a 2-unit stroke, so
 * at 24px it needs stroke-width 1.5 to match, and --iconStroke rather than currentColor
 * to be the same grey as its neighbours. CSS wins over the SVG's own attributes.
 */
.OsintViewsPill :global(svg) {
	width: 24px;
	height: 24px;
	stroke: var(--iconStroke);
	stroke-width: 1.5;
	fill: none;
}
</style>
