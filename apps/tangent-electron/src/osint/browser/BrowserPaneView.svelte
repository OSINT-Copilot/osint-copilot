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
import { BrowseDocumentStore } from './browse-document'
import { installShortcutRelay } from './shortcut-relay'
import { vaultFileStore } from '../canvas/canvas-runtime'

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

// The ABSOLUTE path; the file layer resolves it per call, because a lens can be built
// before the vault runtime exists and a path resolved then would be wrong forever.
const store = new BrowseDocumentStore(state.browseNode.path, vaultFileStore())

let token: string | null = null
let claimFailed: string | null = null
let guest: any = null
let webContentsId: number | null = null
let typedAddress = ''
let loading = false
let currentUrl = 'about:blank'
let currentTitle = ''
/**
 * The address this pane was showing when it was last open, held back deliberately.
 *
 * A restored thread must not fire a live request per pane. The operator may not have the
 * profile they intend to browse as, they may be somewhere the traffic would be noticed,
 * and a request is not undoable. So a restored pane shows what it was on and waits to be
 * told to load it.
 */
let parkedUrl: string | null = null
/**
 * `src` is an INITIALISATION attribute, set once. Driving it reactively as well as
 * calling loadURL() makes the element navigate twice and, in the middle of that, hand out
 * a webContents id that is already gone -- which reads like the guest crashed. Every
 * later navigation goes through loadURL alone.
 */
const initialUrl = 'about:blank'

onMount(async () => {
	// Idempotent, and cheap: the first browsing pane in a window turns it on.
	installShortcutRelay(api)

	try {
		// Claimed before the element renders: an attach carrying a token main does not
		// recognise is refused, so there is no point mounting a guest without one.
		token = await api?.osint?.browse?.claim?.()
	}
	catch (e) {
		claimFailed = String((e as Error)?.message ?? e)
	}

	try {
		const doc = await store.load()
		if (doc.url) {
			parkedUrl = doc.url
			currentTitle = doc.title ?? ''
			typedAddress = doc.url
		}
	}
	catch {
		// The vault was not ready. The pane still works; it just does not remember.
	}

	onViewReady?.()
})

onDestroy(() => {
	// Flush before the session token goes, so a pane closed straight after navigating
	// still remembers where it was.
	void store.flush()
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

/**
 * Recorded on navigation rather than on every load event: `did-navigate` is the moment the
 * address actually changed, and it is what the pane should come back to.
 */
function onDidNavigate(event: any) {
	const url = event?.url ?? guest?.getURL?.() ?? currentUrl

	// A guest navigates to about:blank the moment it attaches, including on every remount.
	// Treating that as a navigation the operator made would clear the parked state a
	// restored pane just put up, AND record "nowhere" over the address the pane was
	// supposed to remember -- so reopening a pane twice would forget where it had been.
	if (!url || url === 'about:blank') return

	currentUrl = url
	parkedUrl = null
	typedAddress = url
	store.record(url, currentTitle || undefined)
}

function onTitleUpdated(event: any) {
	currentTitle = event?.title ?? ''
	if (!currentUrl || currentUrl === 'about:blank') return
	store.record(currentUrl, currentTitle || undefined)
}

function go() {
	const raw = typedAddress.trim()
	if (!raw) return
	const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
	guest?.loadURL?.(withScheme)
}

/** The explicit act that a parked pane is waiting for. */
function loadParked() {
	if (!parkedUrl) return
	const target = parkedUrl
	parkedUrl = null
	guest?.loadURL?.(target)
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

	{#if parkedUrl}
		<div class="parked" data-testid="browse-parked">
			<span class="parked-label">Not loaded yet ·</span>
			<span class="parked-url">{parkedUrl}</span>
			<button on:click={loadParked}>Load page</button>
		</div>
	{/if}

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
			on:did-navigate={onDidNavigate}
			on:did-navigate-in-page={onDidNavigate}
			on:page-title-updated={onTitleUpdated}
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
.parked {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 8px;
	font-size: 12px;
	background: var(--noteBackgroundColor, rgba(128, 128, 128, 0.08));
	border-bottom: 1px solid var(--borderColor, rgba(128, 128, 128, 0.3));
}
.parked-url {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-family: var(--monospaceFontFamily, monospace);
}
.parked-label { color: var(--deemphasizedTextColor, #888); }
.status, .waiting, .error {
	padding: 4px 8px;
	font-size: 11px;
	color: var(--deemphasizedTextColor, #888);
}
.error { color: var(--errorColor, #c33); }
</style>
