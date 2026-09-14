<script lang="ts">
/**
 * The browsing lens: a live web page in a Tangent pane, browsed as a chosen identity.
 *
 * The `<webview>` element is confined to THIS component on purpose; everything main-side
 * keys on `webContentsId`, so replacing the vehicle later is one file plus a bounds
 * module. See the spike commit for why a native WebContentsView cannot follow the thread's
 * sticky columns and flip animations.
 *
 * What this component may NOT do: choose its own partition, proxy or user-agent. It names
 * a profile by id and main decides everything else -- a renderer-chosen cookie jar would
 * mean a bug in pane bookkeeping could log one investigation's identity into another's
 * site. `partition` here carries an opaque token, which main swaps for the real jar in
 * `will-attach-webview`.
 */
import { onDestroy, onMount } from 'svelte'
import { BrowseDocumentStore } from './browse-document'
import { promoteCapture } from './capture-to-entity'
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

interface Profile {
	id: string
	name: string
	colour: string
	userAgent?: string
	acceptLanguages?: string
	proxy?: string
}

interface Finding {
	label: string
	value: string
	verdict: 'ok' | 'warn' | 'leak'
	note: string
}

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
let parkedUrl: string | null = null

let profiles: Profile[] = []
let profile: Profile | null = null
let selectedProfileId = 'default'
/**
 * True once this pane has actually been somewhere.
 *
 * Switching identity mid-history is refused: the cookies, referrer and history that got
 * you to this page belong to the identity that walked that path, and continuing it as
 * someone else is the silent identity swap this feature must never perform.
 */
let hasHistory = false

let checking = false
let findings: Finding[] | null = null
let checkError: string | null = null
let showCheck = false

let armed = false
let capturing = false
let lastCapture: any = null
let captureNote: string | null = null
let promoted = false
let promoteError: string | null = null

$: colour = profile?.colour ?? '#6b7280'

onMount(async () => {
	// Idempotent, and cheap: the first browsing pane in a window turns it on.
	installShortcutRelay(api)

	try {
		profiles = await api?.osint?.browse?.profiles?.() ?? []
	}
	catch {
		profiles = []
	}

	let wanted = 'default'
	try {
		const doc = await store.load()
		if (doc.profileId) wanted = doc.profileId
		if (doc.url) {
			parkedUrl = doc.url
			currentTitle = doc.title ?? ''
			typedAddress = doc.url
			hasHistory = true
		}
	}
	catch {
		// The vault was not ready. The pane still works; it just does not remember.
	}

	await claim(wanted)

	// Capture results are pushed to the window, so each pane filters to its own guest.
	api?.osint?.browse?.onCapture?.((event: any) => {
		if (event?.webContentsId !== webContentsId) return
		capturing = false
		const outcome = event.outcome
		if (outcome?.status === 'captured') {
			lastCapture = outcome.record
			promoted = false
			promoteError = null
			captureNote = outcome.record.screenshotFailure
				? `Captured — no screenshot: ${outcome.record.screenshotFailure}`
				: 'Captured'
		}
		else if (outcome?.status === 'duplicate') captureNote = 'Unchanged since the last capture'
		else if (outcome?.status === 'over-budget') captureNote = outcome.reason
		else captureNote = outcome?.reason ? `Not captured: ${outcome.reason}` : null
	})

	onViewReady?.()
})

onDestroy(() => {
	// Flush before the session token goes, so a pane closed straight after navigating
	// still remembers where it was.
	void store.flush()
	if (token) void api?.osint?.browse?.release?.(token)
})

/**
 * Asks main to prepare an identity and hand back a token for it.
 *
 * A rejection is shown rather than swallowed. The most likely cause is a profile whose
 * proxy this build will not use, and main deliberately refuses to start such a session
 * instead of quietly browsing direct -- so the pane must not paper over it either.
 */
async function claim(profileId: string) {
	claimFailed = null
	try {
		const result = await api?.osint?.browse?.claim?.(profileId)
		token = result?.token ?? null
		profile = result?.profile ?? null
		selectedProfileId = profile?.id ?? profileId
		if (profile) store.recordProfile(profile.id)
	}
	catch (e) {
		token = null
		claimFailed = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': /, '')
	}
}

async function switchProfile(event: Event) {
	const next = (event.target as HTMLSelectElement).value
	if (next === profile?.id || hasHistory) return
	if (token) void api?.osint?.browse?.release?.(token)
	token = null
	findings = null
	await claim(next)
}

function onDomReady() {
	try {
		webContentsId = guest?.getWebContentsId?.() ?? null
	}
	catch {
		webContentsId = null
	}
	// Main learns which identity this guest belongs to from the token it issued, not from
	// a name the renderer supplies -- so a pane cannot claim to be a profile it never
	// claimed. Re-sent on every dom-ready because a guest gets a new id when it remounts.
	if (webContentsId != null && token) {
		void api?.osint?.browse?.bindGuest?.(webContentsId, token)
			.then(() => api?.osint?.browse?.isArmed?.(token))
			.then((value: boolean) => { armed = !!value })
	}
}

/** A guest that goes away must stop being addressable, or main is asked about a dead id. */
function onDestroyed() {
	webContentsId = null
}

function onDidNavigate(event: any) {
	const url = event?.url ?? guest?.getURL?.() ?? currentUrl

	// A guest navigates to about:blank the moment it attaches, including on every remount.
	// Treating that as a navigation the operator made would clear the parked state a
	// restored pane just put up, AND record "nowhere" over the address the pane was
	// supposed to remember -- so reopening a pane twice would forget where it had been.
	if (!url || url === 'about:blank') return

	currentUrl = url
	parkedUrl = null
	hasHistory = true
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

async function toggleArmed() {
	if (!token) return
	armed = await api?.osint?.browse?.setArmed?.(token, !armed) ?? false
	captureNote = armed
		? 'Every page you load as this identity will be written to the vault.'
		: 'Automatic capture is off.'
}

async function captureNow() {
	if (webContentsId == null) return
	capturing = true
	captureNote = 'Capturing…'
	try {
		const outcome = await api?.osint?.browse?.captureNow?.(webContentsId)
		if (outcome?.status === 'captured') {
			lastCapture = outcome.record
			promoted = false
			captureNote = outcome.record.screenshotFailure
				? `Captured — no screenshot: ${outcome.record.screenshotFailure}`
				: 'Captured'
		}
		else if (outcome?.status === 'duplicate') captureNote = 'Unchanged since the last capture'
		else captureNote = outcome?.reason ?? 'Not captured'
	}
	catch (e) {
		captureNote = `Capture failed: ${String((e as Error)?.message ?? e)}`
	}
	finally {
		capturing = false
	}
}

/**
 * Promotion is an act, not a side effect of capturing. An armed profile writes archives
 * and stops; one entity per capture makes the graph unreadable within an hour.
 */
async function promote() {
	if (!lastCapture) return
	promoteError = null
	try {
		const { osintRuntime } = await import('../integration/bootstrap')
		const entityManager = (osintRuntime() as any)?.plugin?.entityManager
		if (!entityManager) throw new Error('the OSINT plugin is not ready')
		await promoteCapture(entityManager, lastCapture)
		promoted = true
	}
	catch (e) {
		promoteError = String((e as Error)?.message ?? e)
	}
}

async function runRealityCheck() {
	if (webContentsId == null || !profile) return
	checking = true
	checkError = null
	showCheck = true
	try {
		const result = await api?.osint?.browse?.realityCheck?.(webContentsId, profile.id)
		findings = result?.findings ?? []
	}
	catch (e) {
		checkError = String((e as Error)?.message ?? e)
	}
	finally {
		checking = false
	}
}
</script>

<div class="BrowserPaneView" class:fill={layout === 'fill'}
	style:--profile-colour={colour}
	style:padding-top={extraTop ? `${extraTop}px` : null}
	style:padding-bottom={extraBottom ? `${extraBottom}px` : null}>

	<!--
		A full-height bar in the profile's colour. The pane collapses to a narrow strip in
		the thread, and a collapsed pane must still say which identity is loaded in it --
		that is the difference between "the wrong tab" and "logged in as the wrong person".
	-->
	<div class="identity-bar" title={profile ? `Browsing as ${profile.name}` : 'No identity'}></div>

	<div class="chrome">
		<select
			class="profile"
			title={hasHistory
				? 'This pane has already been somewhere as this identity. Open a new pane to browse as someone else.'
				: 'Which identity to browse as'}
			disabled={hasHistory || profiles.length < 2}
			value={selectedProfileId}
			on:change={switchProfile}>
			{#each profiles as option (option.id)}
				<option value={option.id}>{option.name}</option>
			{/each}
		</select>
		<input
			class="address"
			type="text"
			placeholder="Search or enter address"
			bind:value={typedAddress}
			on:keydown={e => { if (e.key === 'Enter') go() }} />
		<button on:click={go} disabled={!token}>Go</button>
		<button
			class="check"
			title="Measure what this identity is actually exposing"
			disabled={webContentsId == null}
			on:click={runRealityCheck}>Check</button>
		<button
			class="capture"
			title="Archive this page now"
			disabled={webContentsId == null || capturing}
			on:click={captureNow}>Capture</button>
		<button
			class="arm"
			class:armed
			data-testid="browse-arm"
			title={armed
				? 'Automatic capture is ON for this identity. Click to stop.'
				: 'Capture every page loaded as this identity'}
			disabled={!token}
			on:click={toggleArmed}>{armed ? '● Recording' : '○ Record'}</button>
	</div>

	<!--
		Stated in the interface, not in documentation. Someone's physical safety can rest
		on what they believe this feature does, and "profiles" reads as "anonymity" unless
		the product says otherwise where they are choosing one.
	-->
	<p class="disclaimer">
		Separate cookies, logins and cache{profile?.proxy ? ', and a separate proxy' : ''}.
		<strong>Not anonymity</strong> — sites can still link your profiles by browser
		fingerprint{profile?.proxy ? '' : ', and by your IP address'}.
	</p>

	{#if captureNote}
		<div class="capture-note" data-testid="browse-capture-note">
			<span>{captureNote}</span>
			{#if lastCapture && !promoted}
				<button on:click={promote} data-testid="browse-promote">Add to graph</button>
			{:else if promoted}
				<span class="promoted">Added as evidence</span>
			{/if}
		</div>
		{#if promoteError}<p class="error">{promoteError}</p>{/if}
	{/if}

	{#if parkedUrl}
		<div class="parked" data-testid="browse-parked">
			<span class="parked-label">Not loaded yet ·</span>
			<span class="parked-url">{parkedUrl}</span>
			<button on:click={loadParked}>Load page</button>
		</div>
	{/if}

	{#if showCheck}
		<div class="check-panel" data-testid="browse-reality-check">
			<div class="check-head">
				<strong>What {profile?.name ?? 'this profile'} is exposing</strong>
				<button class="subtle" on:click={() => showCheck = false}>Close</button>
			</div>
			{#if checking}
				<p class="muted">Measuring…</p>
			{:else if checkError}
				<p class="error">{checkError}</p>
			{:else if findings}
				{#each findings as finding}
					<div class="finding {finding.verdict}">
						<div class="finding-head">
							<span class="finding-label">{finding.label}</span>
							<span class="finding-value">{finding.value}</span>
						</div>
						<p class="finding-note">{finding.note}</p>
					</div>
				{/each}
			{/if}
		</div>
	{/if}

	{#if claimFailed}
		<p class="error" data-testid="browse-claim-error">
			This pane will not browse as “{selectedProfileId}”: {claimFailed}
		</p>
	{:else if token}
		<!-- svelte-ignore a11y_missing_attribute -->
		<webview
			bind:this={guest}
			class="guest"
			data-testid="browse-guest"
			partition={token}
			src="about:blank"
			data-guest-id={webContentsId ?? ''}
			on:dom-ready={onDomReady}
			on:destroyed={onDestroyed}
			on:did-navigate={onDidNavigate}
			on:did-navigate-in-page={onDidNavigate}
			on:page-title-updated={onTitleUpdated}></webview>
	{:else}
		<p class="waiting">Starting a browsing session…</p>
	{/if}

	<div class="status" data-testid="browse-status">
		<span class="dot" title={profile?.name}></span>
		{#if loading}Loading…{:else if webContentsId != null}Ready · guest {webContentsId}{:else}Idle{/if}
	</div>
</div>

<style lang="scss">
.BrowserPaneView {
	position: relative;
	display: flex;
	flex-direction: column;
	height: 100%;
	width: 100%;
	min-width: 0;
	background: var(--backgroundColor);
	padding-left: 4px;
}
.identity-bar {
	position: absolute;
	left: 0;
	top: 0;
	bottom: 0;
	width: 4px;
	background: var(--profile-colour);
}
.chrome {
	display: flex;
	gap: 4px;
	padding: 6px;
	border-bottom: 1px solid var(--borderColor, rgba(128, 128, 128, 0.3));
	// A tint of the identity's colour, so the pane reads as "this one" at a glance.
	background: color-mix(in srgb, var(--profile-colour) 12%, transparent);
}
.profile { max-width: 9em; }
.address {
	flex: 1;
	min-width: 0;
}
.disclaimer {
	margin: 0;
	padding: 4px 8px;
	font-size: 11px;
	line-height: 1.35;
	color: var(--deemphasizedTextColor, #888);
	border-bottom: 1px solid var(--borderColor, rgba(128, 128, 128, 0.2));
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
.capture-note {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 8px;
	font-size: 11px;
	background: var(--noteBackgroundColor, rgba(128, 128, 128, 0.08));
	border-bottom: 1px solid var(--borderColor, rgba(128, 128, 128, 0.2));
	span:first-child { flex: 1; min-width: 0; }
}
.promoted { color: #2f9e44; }
.arm.armed {
	// Recording must be unmistakable at a glance: this writes every page the operator
	// looks at, as this identity, to disk.
	color: #e03131;
	font-weight: 600;
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
.check-panel {
	max-height: 45%;
	overflow-y: auto;
	padding: 8px;
	font-size: 12px;
	border-bottom: 1px solid var(--borderColor, rgba(128, 128, 128, 0.3));
	background: var(--noteBackgroundColor, rgba(128, 128, 128, 0.06));
}
.check-head {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 6px;
}
.finding {
	padding: 4px 6px;
	margin-bottom: 4px;
	border-left: 3px solid var(--deemphasizedTextColor, #888);
	&.ok { border-left-color: #2f9e44; }
	&.warn { border-left-color: #f08c00; }
	&.leak { border-left-color: #e03131; }
}
.finding-head {
	display: flex;
	gap: 8px;
	justify-content: space-between;
}
.finding-label { font-weight: 600; }
.finding-value {
	font-family: var(--monospaceFontFamily, monospace);
	text-align: right;
	word-break: break-all;
}
.finding-note {
	margin: 2px 0 0;
	color: var(--deemphasizedTextColor, #888);
	line-height: 1.35;
}
.status {
	display: flex;
	align-items: center;
	gap: 6px;
}
.dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--profile-colour);
	flex: 0 0 auto;
}
.status, .waiting, .error, .muted {
	padding: 4px 8px;
	font-size: 11px;
	color: var(--deemphasizedTextColor, #888);
}
.error { color: var(--errorColor, #c33); }
</style>
