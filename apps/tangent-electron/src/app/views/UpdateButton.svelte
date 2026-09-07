<script lang="ts">
/**
 * The toolbar's update button.
 *
 * Everything it does comes from UpdateAppCommand through `use:command` -- the click, the
 * tooltip with the current state in it, and the disabled state while a check or download
 * is in flight. What is left here is the part a command cannot express: the download
 * progress bar, and the accent that marks an update waiting to be applied.
 *
 * Built the same way as the gear beside it (System.svelte), down to the progress bar, so
 * the two read as one group rather than as a bolted-on extra.
 */
import { getContext } from 'svelte'
import type Workspace from 'app/model/Workspace'
import command from 'app/model/commands/CommandAction'

const workspace = getContext('workspace') as Workspace
const state = workspace.updateState

$: mode = state.mode
$: downloadProgress = state.downloadProgress
$: downloadPercent = $downloadProgress?.percent || 0
</script>

<!-- svelte-ignore a11y_consider_explicit_label -->
<button
	class="subtle UpdateButton"
	use:command={{ command: workspace.commands.updateApp, labelAsTooltip: true }}
>
	<div class={'buttonContent ' + $mode}>
		<svg style="width: 24px; height: 24px;">
			<use href="update.svg#arrow" />
		</svg>
		<div class="progressBar" class:show={downloadPercent}>
			<div class="progress" style={`width: ${downloadPercent}%;`}></div>
		</div>
	</div>
</button>

<style lang="scss">
.buttonContent {
	display: flex;
	align-items: center;
	position: relative;
	flex-direction: column;
}

/*
 * An update that is downloaded and waiting is the one state worth interrupting for, so it
 * is the only one that fills the glyph. --updateFill is the variable update.svg's path
 * already reads; System.svelte lights its gear from the same one.
 */
.buttonContent.ready {
	--updateFill: var(--accentTextColor);
}

/* Mid-flight, the arrow recedes and the bar underneath carries the information. */
.buttonContent.checking svg,
.buttonContent.downloading svg {
	opacity: .5;
}

.buttonContent.error {
	--iconStroke: var(--deemphasizedTextColor);
}

.progressBar {
	visibility: hidden;
	height: 4px;
	width: 100%;

	&.show {
		visibility: visible;
	}

	.progress {
		height: 100%;
		background-color: var(--accentTextColor);
		transition: width .1s;
	}
}
</style>
