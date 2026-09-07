<script lang="ts">
/**
 * Settings > Licence: what the current key says, and how to replace it.
 *
 * The gate (LicenseGate.svelte) is only ever seen once. Without this page there would be
 * no way to read your expiry date, move a licence to a new key, or clear one from a shared
 * machine.
 *
 * The key itself is never shown: main stores it and returns status only, so there is
 * nothing here to leak. Replacing one means pasting the new one.
 */
import { getContext } from 'svelte'
import { slide } from 'svelte/transition'
import type Workspace from 'app/model/Workspace'
import type { LicenseStatus } from 'common/license'

const workspace = getContext('workspace') as Workspace
const api = workspace.api

let status: LicenseStatus = null
let entering = false
let key = ''
let busy = false
let error = ''

refresh()
function refresh() {
	api.license.status()
		.then(next => { status = next })
		.catch(e => console.error('Could not read the licence status', e))
}

$: expires = status?.payload?.expires
$: perpetual = status?.valid && !expires

async function activate() {
	if (!key.trim() || busy) return
	busy = true
	error = ''
	try {
		const result = await api.license.activate(key)
		if (result.valid) {
			status = result
			entering = false
			key = ''
		}
		else {
			error = result.message ?? 'That licence key could not be used.'
		}
	}
	catch (e) {
		console.error('Licence activation failed', e)
		error = 'The licence could not be checked.'
	}
	finally {
		busy = false
	}
}

async function clear() {
	// The next launch will show the gate. Said plainly, because it is not obvious that
	// removing a key from settings locks the application on restart.
	if (!confirm('Remove this licence key from this computer?\n\nOSINT Copilot will ask for a key the next time it starts.')) return
	try {
		status = await api.license.clear()
	}
	catch (e) {
		console.error('Could not clear the licence', e)
	}
}
</script>

<main>
	{#if status == null}
		<p class="muted">Checking…</p>
	{:else if status.valid}
		<dl>
			<dt>Status</dt>
			<dd class="good">Active</dd>

			<dt>Issued to</dt>
			<dd>{status.payload?.name ?? 'Unknown'}</dd>

			{#if status.payload?.email}
				<dt>Email</dt>
				<dd>{status.payload.email}</dd>
			{/if}

			<dt>Expires</dt>
			<dd>{perpetual ? 'Never' : expires}</dd>

			{#if status.payload?.seats}
				<dt>Seats</dt>
				<dd>{status.payload.seats}</dd>
			{/if}
		</dl>
	{:else}
		<p class="warning">{status.message}</p>
	{/if}

	{#if entering}
		<div class="entry" transition:slide={{ duration: 200 }}>
			<textarea
				bind:value={key}
				rows="4"
				spellcheck="false"
				placeholder="OSINT-…"
				aria-label="Licence key"
				disabled={busy}
			></textarea>
			{#if error}
				<p class="warning" role="alert">{error}</p>
			{/if}
			<div class="buttons">
				<button on:click={() => { entering = false; key = ''; error = '' }}>Cancel</button>
				<button on:click={activate} disabled={!key.trim() || busy}>
					{busy ? 'Checking…' : 'Activate'}
				</button>
			</div>
		</div>
	{:else}
		<div class="buttons">
			<button on:click={() => { entering = true }}>
				{status?.valid ? 'Replace licence key' : 'Enter licence key'}
			</button>
			{#if status?.valid}
				<button class="danger" on:click={clear}>Remove from this computer</button>
			{/if}
		</div>
	{/if}

	<p class="note">
		Licence keys are checked on this computer. Nothing about your licence is sent
		anywhere.
	</p>
</main>

<style lang="scss">
main {
	width: 350px;
	margin: 0 auto;
}

dl {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: .4em 1em;
	margin: 0 0 1.5em;
	font-size: 90%;
}
dt {
	color: var(--deemphasizedTextColor);
}
dd {
	margin: 0;
}
dd.good {
	color: var(--accentTextColor);
}

.muted {
	color: var(--deemphasizedTextColor);
}
.warning {
	color: var(--warningTextColor);
	font-size: 85%;
}

textarea {
	width: 100%;
	box-sizing: border-box;
	resize: vertical;
	font-family: var(--codeFontFamily, monospace);
	font-size: 80%;
	line-height: 1.5;
	padding: .5em;
	border-radius: 4px;
	border: 1px solid var(--borderColor);
	background: var(--noteBackgroundColor, var(--backgroundColor));
	color: var(--textColor);
}

.buttons {
	display: flex;
	gap: .5em;
	margin-top: .75em;
}
.buttons button {
	flex: 1;
}
.danger {
	color: var(--warningTextColor);
}

.note {
	margin-top: 2em;
	font-size: 75%;
	line-height: 1.5;
	color: var(--deemphasizedTextColor);
}
</style>
