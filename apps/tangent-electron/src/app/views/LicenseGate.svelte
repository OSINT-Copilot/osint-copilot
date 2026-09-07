<script lang="ts">
/**
 * The licence gate: what the window shows before a valid key has been entered.
 *
 * Rendered instead of the workspace, not over it, so nothing behind it has been built
 * yet -- no vault is opened, no OSINT plugin starts, no file is read. The check itself
 * happens in main (src/main/license.ts); this only collects a key and reports what main
 * says about it.
 */
import type WindowApi from 'common/WindowApi'
import type { LicenseStatus } from 'common/license'
import SvgIcon from './smart-icons/SVGIcon.svelte'

export let api: WindowApi
/** Told when a key has been accepted, so the app can carry on booting. */
export let onLicensed: (status: LicenseStatus) => void
/** The status that put us here; its message explains why. */
export let status: LicenseStatus

let key = ''
let busy = false
let message: string = status?.message ?? ''
/** An outright refusal reads differently from "you have not entered one yet". */
let isRefusal = status?.reason != null && status.reason !== 'missing'

$: canSubmit = key.trim().length > 0 && !busy

async function activate() {
	if (!canSubmit) return
	busy = true
	try {
		const result = await api.license.activate(key)
		if (result.valid) {
			onLicensed(result)
			return
		}
		message = result.message ?? 'That licence key could not be used.'
		isRefusal = true
	}
	catch (e) {
		console.error('Licence activation failed', e)
		message = 'The licence could not be checked. Please restart OSINT Copilot.'
		isRefusal = true
	}
	finally {
		busy = false
	}
}

function onKeydown(event: KeyboardEvent) {
	// Enter submits; Shift+Enter does not, so a pasted multi-line key can still be edited.
	if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
		event.preventDefault()
		activate()
	}
}
</script>

<main class="LicenseGate">
	<div class="card">
		<SvgIcon
			ref="tangent-icon-nocolor.svg#icon"
			size="96"
			styleString="--iconStroke: var(--embossedBackgroundColor);"
		/>

		<h1>OSINT Copilot</h1>
		<p class="lede">Enter your licence key to continue.</p>

		<!-- A textarea, not an input: keys are long and arrive wrapped across lines. -->
		<textarea
			class="key"
			class:invalid={isRefusal}
			bind:value={key}
			on:keydown={onKeydown}
			placeholder="OSINT-…"
			spellcheck="false"
			autocapitalize="off"
			autocorrect="off"
			rows="4"
			disabled={busy}
			aria-label="Licence key"
			aria-invalid={isRefusal}
		></textarea>

		{#if message}
			<p class="message" class:error={isRefusal} role={isRefusal ? 'alert' : undefined}>
				{message}
			</p>
		{/if}

		<button class="activate" on:click={activate} disabled={!canSubmit}>
			{busy ? 'Checking…' : 'Activate'}
		</button>

		<p class="help">
			Your key was sent with your purchase. It works offline and is stored on this
			computer only.
		</p>
	</div>
</main>

<style lang="scss">
.LicenseGate {
	position: fixed;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	background: var(--backgroundColor);
	/* The window is frameless until the workspace mounts its own bar; keep it draggable. */
	-webkit-app-region: drag;
}

.card {
	-webkit-app-region: no-drag;
	width: min(420px, calc(100vw - 4em));
	display: flex;
	flex-direction: column;
	align-items: center;
	text-align: center;
	gap: .75em;
}

h1 {
	margin: 0;
	font-size: 1.5em;
	font-weight: 500;
	color: var(--textColor);
}

.lede {
	margin: 0;
	color: var(--deemphasizedTextColor);
}

.key {
	width: 100%;
	box-sizing: border-box;
	resize: vertical;
	font-family: var(--codeFontFamily, monospace);
	font-size: .85em;
	line-height: 1.5;
	padding: .6em .7em;
	border-radius: 4px;
	border: 1px solid var(--borderColor);
	background: var(--noteBackgroundColor, var(--backgroundColor));
	color: var(--textColor);

	&:focus {
		outline: none;
		border-color: var(--accentTextColor);
	}

	&.invalid {
		border-color: var(--warningTextColor);
	}
}

.message {
	margin: 0;
	font-size: .85em;
	color: var(--deemphasizedTextColor);

	&.error {
		color: var(--warningTextColor);
	}
}

.activate {
	width: 100%;
	padding: .6em;
	font-size: 1em;
}

.help {
	margin: .5em 0 0;
	font-size: .75em;
	line-height: 1.5;
	color: var(--heavilyDeemphasizedTextColor, var(--deemphasizedTextColor));
}
</style>
