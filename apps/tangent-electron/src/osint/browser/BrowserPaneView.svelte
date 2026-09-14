<script lang="ts">
/**
 * The browsing lens: a live web page in a Tangent pane.
 *
 * SPIKE. This exists to answer one question before any of the rest is designed -- does a
 * `<webview>` guest survive the thread's pane machinery? The panes are `position: sticky`
 * columns inside a horizontal scroller, they enter with `in:fly` and reorder with
 * `animate:flip`, and they clip with `overflow: hidden`. A native `WebContentsView` cannot
 * follow any of that, which is why the element is a DOM node instead. If a guest detaches
 * or goes blank under those, the fallback is to suppress those two transitions for
 * browsing panes only -- not to change vehicle.
 *
 * The `<webview>` element is confined to THIS component on purpose. Everything else keys
 * on `webContentsId`, so replacing the vehicle later is one file plus a bounds module.
 *
 * What this component may NOT do, ever: choose its own partition. `partition` carries an
 * opaque token from main, which main swaps for the real cookie jar in
 * `will-attach-webview`. A renderer-chosen partition would mean a bug in pane bookkeeping
 * could log one investigation's identity into another's site.
 */
import { onDestroy, onMount } from 'svelte'
import { BROWSE_FILE_TYPE } from './browse-file-type'

/** The LENS. BrowseNodeViewState puts the node on it as `browseNode`. */
export let state: { browseNode: { path: string, name?: string } }
// Props NodeViewSelector passes to every lens. Accepted and mostly unused.
export let isCurrent: boolean = false
export let focusLevel: number = 0
export let layout: 'fill' | 'auto' = 'fill'
export let background: 'auto' | 'none' = 'auto'
export let extraTop: number = 0
export let extraBottom: number = 0
export let onNavigate: any = null
export let onViewReady: any = null
export let onScrollRequest: any = null
export let onKeyboardExit: any = null

const api = (globalThis as any).api

let token: string | null = null
let claimFailed: string | null = null
let guest: any = null
let webContentsId: number | null = null
let typedAddress = ''
let loading = false
/**
 * `src` is an INITIALISATION attribute, set once. Driving it reactively as well as
 * calling loadURL() makes the element navigate twice and, in the middle of that, hand out
 * a webContents id that is already gone -- which reads like the guest crashed. Every
 * later navigation goes through loadURL alone.
 */
const initialUrl = 'about:blank'

onMount(async () => {
	try {
		// Claimed before the element renders: an attach carrying a token main does not
		// recognise is refused, so there is no point mounting a guest without one.
		token = await api?.osint?.browse?.claim?.()
	}
	catch (e) {
		claimFailed = String((e as Error)?.message ?? e)
	}
	onViewReady?.()
})

onDestroy(() => {
	if (token) void api?.osint?.browse?.release?.(token)
})

/**
 * `dom-ready` is the first moment a guest has a webContents id. Everything main-side --
 * capture, selection, navigation policy -- is keyed on that id rather than on the
 * element, so this is the handshake that makes the pane addressable.
 */
function onDomReady() {
	try {
		webContentsId = guest?.getWebContentsId?.() ?? null
	}
	catch {
		webContentsId = null
	}
}

/** A guest that goes away must stop being addressable, or main is asked about a dead id. */
function onDestroyed() {
	webContentsId = null
}

function go() {
	const raw = typedAddress.trim()
	if (!raw) return
	const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
	guest?.loadURL?.(withScheme)
}

export function currentWebContentsId(): number | null {
	return webContentsId
}
</script>

<div class="BrowserPaneView" class:fill={layout === 'fill'}
	style:padding-top={extraTop ? `${extraTop}px` : null}
	style:padding-bottom={extraBottom ? `${extraBottom}px` : null}>

	<div class="chrome">
		<input
			class="address"
			type="text"
			placeholder="Search or enter address"
			bind:value={typedAddress}
			on:keydown={e => { if (e.key === 'Enter') go() }} />
		<button on:click={go} disabled={!token}>Go</button>
	</div>

	{#if claimFailed}
		<p class="error">This pane could not start a browsing session: {claimFailed}</p>
	{:else if token}
		<!-- svelte-ignore a11y_missing_attribute -->
		<webview
			bind:this={guest}
			class="guest"
			data-testid="browse-guest"
			partition={token}
			src={initialUrl}
			data-guest-id={webContentsId ?? ''}
			on:dom-ready={onDomReady}
			on:destroyed={onDestroyed}
			on:did-start-loading={() => loading = true}
			on:did-stop-loading={() => loading = false}></webview>
	{:else}
		<p class="waiting">Starting a browsing session…</p>
	{/if}

	<div class="status" data-testid="browse-status">
		{#if loading}Loading…{:else if webContentsId != null}Ready · guest {webContentsId}{:else}Idle{/if}
	</div>
</div>

<style lang="scss">
.BrowserPaneView {
	display: flex;
	flex-direction: column;
	height: 100%;
	width: 100%;
	min-width: 0;
	background: var(--backgroundColor);
}
.chrome {
	display: flex;
	gap: 4px;
	padding: 6px;
	border-bottom: 1px solid var(--borderColor, rgba(128, 128, 128, 0.3));
}
.address {
	flex: 1;
	min-width: 0;
}
.guest {
	// A <webview> is display:inline by default, which collapses it to nothing inside a
	// flex column. This is the whole reason a blank pane is usually a styling bug and
	// not a rendering failure.
	display: flex;
	flex: 1 1 auto;
	width: 100%;
	min-height: 0;
}
.status, .waiting, .error {
	padding: 4px 8px;
	font-size: 11px;
	color: var(--deemphasizedTextColor, #888);
}
.error { color: var(--errorColor, #c33); }
</style>
