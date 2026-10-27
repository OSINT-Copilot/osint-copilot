<script lang="ts">
/**
 * Settings > Licence: what the current key entitles you to, and how to replace it.
 *
 * The gate (LicenseGate.svelte) is only ever seen once. Without this page there would be
 * no way to read your plan, see how many credits are left, move a licence to a new key,
 * or clear one from a shared machine.
 *
 * The key itself is never shown: main stores it and returns status only, so there is
 * nothing here to leak. Replacing one means pasting the new one.
 */
import { getContext } from 'svelte'
import { slide } from 'svelte/transition'
import type Workspace from 'app/model/Workspace'
import {
	graceDaysRemaining,
	tierDisplayName,
	type Entitlements,
	type LicenseStatus,
} from 'common/license'

const workspace = getContext('workspace') as Workspace
const api = workspace.api

let status: LicenseStatus = null
let entering = false
let key = ''
let busy = false
let refreshing = false
let error = ''

refresh()
function refresh() {
	api.license.status()
		.then(apply)
		.catch(e => console.error('Could not read the licence status', e))
}

/**
 * Asks the dashboard again rather than reading the cache.
 *
 * Here because the cached answer is honoured for the best part of a day: someone who has
 * just upgraded, or just bought credits, would otherwise see yesterday's plan and conclude
 * the purchase failed.
 */
async function refreshFromServer() {
	if (refreshing) return
	refreshing = true
	try {
		apply(await api.license.refresh())
	}
	catch (e) {
		console.error('Could not refresh the licence', e)
	}
	finally {
		refreshing = false
	}
}

function apply(next: LicenseStatus) {
	status = next
}

$: subscription = status?.subscription
$: expires = subscription?.expires ?? status?.payload?.expires
$: perpetual = status?.valid && !expires
$: offlineKey = status?.source === 'offline'

/**
 * A date the user can read, from either kind of key. Falls back to the raw string.
 *
 * A bare `YYYY-MM-DD` is built as a *local* date rather than handed to `new Date`, which
 * reads that form as UTC midnight -- so a subscription ending on the 7th renders as the
 * 6th anywhere behind UTC, and the 7th only by luck anywhere ahead of it. A calendar date
 * has no timezone, and pretending otherwise moves it by a day for half the world.
 */
function formatDate(value: string | null | undefined): string {
	if (!value) return 'Never'

	const plainDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
	const date = plainDate
		? new Date(Number(plainDate[1]), Number(plainDate[2]) - 1, Number(plainDate[3]))
		: new Date(value)

	if (Number.isNaN(date.getTime())) return value
	return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

const FEATURE_LABELS: [keyof Entitlements, string][] = [
	['osint', 'OSINT tools'],
	['chat', 'Chat view'],
	['graphAutomation', 'AI entity extraction'],
	['customModels', 'Custom model endpoints'],
	['localAgent', 'Local agent'],
]

async function activate() {
	if (!key.trim() || busy) return
	busy = true
	error = ''
	try {
		const result = await api.license.activate(key)
		if (result.valid) {
			apply(result)
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
		apply(await api.license.clear())
	}
	catch (e) {
		console.error('Could not clear the licence', e)
	}
}
</script>

<main>
	{#if status == null}
		<p class="muted">Checking…</p>
	{:else}
		{#if status.tier}
			<div class="plan">
				<span class="tier tier-{status.tier}">{tierDisplayName(status.tier)}</span>
				{#if subscription}
					<span class="planName">{subscription.planDisplayName}</span>
				{/if}
			</div>
		{/if}

		{#if !status.valid}
			<p class="warning" role="alert">{status.message}</p>
		{/if}

		{#if status.stale}
			<!-- Not an error: the licence is being honoured. It says how long that lasts. -->
			<p class="muted stale">
				Working offline — showing the last known plan.
				{#if subscription}
					Reconnect within {graceDaysRemaining(subscription.checkedAt)} days to keep working.
				{/if}
			</p>
		{/if}

		<dl>
			<dt>Status</dt>
			<dd class:good={status.valid} class:bad={!status.valid}>
				{status.valid ? (status.stale ? 'Active (offline)' : 'Active') : 'Not active'}
			</dd>

			{#if subscription}
				<dt>Account</dt>
				<dd>{subscription.email ?? subscription.name ?? 'Unknown'}</dd>

				<dt>Credits</dt>
				<dd>{subscription.credits}</dd>

				<dt>{subscription.isTrial ? 'Trial ends' : 'Renews'}</dt>
				<!-- The plain date, not `expires`: that is the end of the last day, and
				     renders as the day after in any timezone ahead of the server's. -->
				<dd>{formatDate(subscription.endDate ?? subscription.expires)}</dd>

				<dt>Last checked</dt>
				<dd>{formatDate(subscription.checkedAt)}</dd>
			{:else if status.payload}
				<dt>Issued to</dt>
				<dd>{status.payload.name ?? 'Unknown'}</dd>

				{#if status.payload.email}
					<dt>Email</dt>
					<dd>{status.payload.email}</dd>
				{/if}

				<dt>Expires</dt>
				<dd>{perpetual ? 'Never' : formatDate(expires)}</dd>

				{#if status.payload.seats}
					<dt>Seats</dt>
					<dd>{status.payload.seats}</dd>
				{/if}
			{/if}
		</dl>

		{#if status.valid && status.entitlements}
			<h3>Included in your plan</h3>
			<ul class="features">
				{#each FEATURE_LABELS as [feature, label] (feature)}
					<li class:on={status.entitlements[feature]}>
						<span class="mark">{status.entitlements[feature] ? '✓' : '—'}</span>{label}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}

	{#if entering}
		<div class="entry" transition:slide={{ duration: 200 }}>
			<textarea
				bind:value={key}
				rows="4"
				spellcheck="false"
				placeholder="Paste your licence key"
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
		{#if subscription || status?.source === 'subscription'}
			<div class="buttons">
				<button on:click={refreshFromServer} disabled={refreshing}>
					{refreshing ? 'Checking…' : 'Check for changes'}
				</button>
			</div>
		{/if}
	{/if}

	<p class="note">
		{#if offlineKey}
			This key is checked on this computer. Nothing about your licence is sent anywhere.
		{:else}
			Your plan is checked against your dashboard account. Only the key is sent, and
			the app keeps working for a while without a connection.
		{/if}
	</p>
</main>

<style lang="scss">
main {
	width: 350px;
	margin: 0 auto;
}

.plan {
	display: flex;
	align-items: center;
	gap: .6em;
	margin-bottom: 1em;
}

.tier {
	font-size: 75%;
	font-weight: 600;
	letter-spacing: .06em;
	text-transform: uppercase;
	padding: .2em .6em;
	border-radius: 999px;
	border: 1px solid currentColor;
	color: var(--deemphasizedTextColor);

	&.tier-basic { color: var(--accentTextColor); }
	&.tier-premium {
		background: var(--accentTextColor);
		border-color: transparent;
		color: var(--backgroundColor);
	}
}

.planName {
	font-size: 95%;
	color: var(--textColor);
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
dd.bad {
	color: var(--warningTextColor);
}

h3 {
	font-size: 85%;
	font-weight: 600;
	color: var(--deemphasizedTextColor);
	margin: 0 0 .5em;
}

.features {
	list-style: none;
	margin: 0 0 1.5em;
	padding: 0;
	font-size: 90%;

	li {
		display: flex;
		gap: .6em;
		padding: .15em 0;
		color: var(--deemphasizedTextColor);
	}
	li.on {
		color: var(--textColor);
	}
	.mark {
		width: 1em;
		text-align: center;
	}
	li.on .mark {
		color: var(--accentTextColor);
	}
}

.muted {
	color: var(--deemphasizedTextColor);
}
.stale {
	font-size: 85%;
	margin: 0 0 1em;
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
