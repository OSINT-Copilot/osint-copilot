<script lang="ts">
/**
 * The browser extension's settings: the switch, the channel's status, pairing, the paired
 * extensions, and this investigation's Wayback choice for what they send.
 *
 * Everything but the Wayback toggle lives in main (osint:extension.*) and is app-wide;
 * no call here returns a key. The Wayback toggle is per investigation, in the plugin's
 * settings, because whether a case may tell archive.org what it is looking at is a
 * decision about that case.
 *
 * Markup reuses the setting-item classes the plugin's tab renders with, so this section
 * reads as part of the same page.
 */
import { onDestroy, onMount } from 'svelte'
import { host } from '../host'
import type { ExtensionPairing, ExtensionStatus } from '../host/types'
import { extensionStatusLine, formatCountdown, formatLastSeen } from './extension-settings-format'
import { osintPluginState } from './osint-plugin-state'

let status: ExtensionStatus = null
let error: string = null
let busy = false
let pairing: ExtensionPairing = null
let now = Date.now()
let copied = false
let timer: ReturnType<typeof setInterval> = null

$: msLeft = pairing ? pairing.expiresAt - now : 0
$: allowWayback = $osintPluginState.settings?.extensionAllowWayback === true

async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
	busy = true
	error = null
	try {
		return await task()
	}
	catch (e) {
		error = e instanceof Error ? e.message : String(e)
		return undefined
	}
	finally {
		busy = false
	}
}

async function refresh() {
	const next = await run(() => host.extension.status())
	if (next) status = next
}

async function toggleEnabled(event: Event) {
	const box = event.currentTarget as HTMLInputElement
	const enabled = box.checked
	const next = await run(() => host.extension.setEnabled(enabled))
	if (next) status = next
	// On failure the box would keep the state that was clicked, not the one main has;
	// Svelte would not reset it, since `status` did not change.
	box.checked = status?.enabled ?? false
	if (!(status?.enabled)) pairing = null
}

async function beginPairing() {
	copied = false
	const next = await run(() => host.extension.pairBegin())
	if (next) pairing = next
}

async function cancelPairing() {
	pairing = null
	await run(() => host.extension.pairCancel())
}

async function copyPairing() {
	if (!pairing) return
	try {
		await navigator.clipboard.writeText(pairing.pairingString)
		copied = true
	}
	catch (e) {
		error = 'Could not copy. Select the string and copy it by hand.'
	}
}

async function revoke(clientId: string, origin: string) {
	// Not undoable: the extension would have to be paired again. The plugin's dialog, so
	// this component does not pull the modal code into the settings page's bundle.
	const plugin = (globalThis as any).osint?.plugin
	if (plugin?.confirmExtensionRevoke && !(await plugin.confirmExtensionRevoke(origin))) return
	await run(() => host.extension.revoke(clientId))
	await refresh()
}

async function toggleWayback(event: Event) {
	const plugin = (globalThis as any).osint?.plugin
	if (!plugin?.setExtensionAllowWayback) return
	const box = event.currentTarget as HTMLInputElement
	const allow = box.checked
	// Through the plugin, which saves this key on top of what is on disk: the settings
	// file is shared by every window on the investigation.
	await run(() => plugin.setExtensionAllowWayback(allow))
	box.checked = $osintPluginState.settings?.extensionAllowWayback === true
}

onMount(() => {
	void refresh()
	// One clock for the countdown, and a status refresh now and then so "last seen" and
	// a newly paired extension appear without leaving the page.
	let ticks = 0
	timer = setInterval(() => {
		now = Date.now()
		// Main has already forgotten an expired string; stop showing it.
		if (pairing && pairing.expiresAt <= now) pairing = null
		// Quietly: a failed poll must not replace the message of a failed click.
		if (++ticks % 10 === 0 && !busy) {
			void host.extension.status().then(next => { status = next }, () => undefined)
		}
	}, 1000)
})

onDestroy(() => {
	if (timer) clearInterval(timer)
	// A pairing string nobody is looking at should not stay valid.
	if (pairing) void host.extension.pairCancel().catch(() => undefined)
})
</script>

<div class="ExtensionSettings">
	<div class="setting-item setting-item-heading">
		<div class="setting-item-info"><div class="setting-item-name">Browser extension</div></div>
	</div>

	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Accept items from the browser extension</div>
			<div class="setting-item-description">
				{status ? extensionStatusLine(status) : 'Checking…'}
			</div>
			{#if status && !status.secretsEncrypted && !status.problem}
				<div class="setting-item-description warning">
					This system has no OS keychain available, so the extension's keys are stored unencrypted
					(readable only by your user account).
				</div>
			{/if}
		</div>
		<div class="setting-item-control">
			<input type="checkbox" checked={status?.enabled ?? false} disabled={busy || !status || !!status.problem}
				on:change={toggleEnabled} aria-label="Accept items from the browser extension" />
		</div>
	</div>

	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Pair new extension</div>
			<div class="setting-item-description">
				Paste this one-time string into the extension's settings. It works once, for five minutes.
			</div>
			{#if pairing}
				<div class="pairing">
					<code class="pairing-string">{pairing.pairingString}</code>
					<span class="countdown" aria-live="off">expires in {formatCountdown(msLeft)}</span>
				</div>
			{/if}
		</div>
		<div class="setting-item-control">
			{#if pairing}
				<button on:click={copyPairing}>{copied ? 'Copied' : 'Copy'}</button>
				<button on:click={cancelPairing}>Cancel</button>
			{:else}
				<button class="mod-cta" on:click={beginPairing}
					disabled={busy || !status?.running}>Pair new extension</button>
			{/if}
		</div>
	</div>

	{#if status?.clients?.length}
		{#each status.clients as client (client.clientId)}
			<div class="setting-item">
				<div class="setting-item-info">
					<div class="setting-item-name">{client.origin}</div>
					<div class="setting-item-description">
						Version {client.extVersion} · last seen {formatLastSeen(client.lastSeenAt, now)}
					</div>
				</div>
				<div class="setting-item-control">
					<button class="mod-warning" disabled={busy} on:click={() => revoke(client.clientId, client.origin)}>Revoke</button>
				</div>
			</div>
		{/each}
	{:else if status}
		<div class="setting-item">
			<div class="setting-item-info">
				<div class="setting-item-description">No extension is paired.</div>
			</div>
		</div>
	{/if}

	<div class="setting-item">
		<div class="setting-item-info">
			<div class="setting-item-name">Allow Wayback lookups for items from the extension</div>
			<div class="setting-item-description">
				For this investigation only. Off by default: a lookup tells the Internet Archive which pages the
				case is looking at.
			</div>
		</div>
		<div class="setting-item-control">
			<input type="checkbox" checked={allowWayback} disabled={!$osintPluginState.settings}
				on:change={toggleWayback} aria-label="Allow Wayback lookups for items from the extension" />
		</div>
	</div>

	{#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
.ExtensionSettings { margin-bottom: 1.5em; }
.warning { color: var(--text-warning, #b45309); }
.pairing {
	display: flex;
	flex-wrap: wrap;
	gap: .5em;
	align-items: center;
	margin-top: .5em;
}
.pairing-string {
	user-select: all;
	word-break: break-all;
}
.countdown { opacity: .7; font-variant-numeric: tabular-nums; }
.error { color: var(--text-error, #b91c1c); }
</style>
