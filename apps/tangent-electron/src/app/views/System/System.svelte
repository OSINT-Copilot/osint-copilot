<script lang="ts">
import { getContext } from 'svelte';
import { isMac } from 'common/platform'
import type Workspace from 'app/model/Workspace'
import PopUpButton from 'app/utils/PopUpButton.svelte'

import Appearance from './Appearance.svelte'
import Attachments from './Attachments.svelte'
import CreationRules from './CreationRules.svelte'
import Database from './Database.svelte'
import Updates from './Updates.svelte'
import About from './About.svelte'
import License from './License.svelte'
import Maps from './Maps.svelte'
import Notes from './Notes.svelte'
import Styles from './Styles.svelte'
import Dictionary from './Dictionary.svelte'
import Shortcuts from './Shortcuts.svelte'
import Debug from './Debug.svelte'
import OsintSettings from 'osint/integration/OsintSettings.svelte'
import { anyShimModalIsOpen } from 'osint/obsidian-shim/ui/modal'
import DocumentationLink from 'app/utils/DocumentationLink.svelte'
import { PREMIUM_LICENSING_ENABLED } from 'common/premium'

export let detailsOpen = false

let workspace = getContext('workspace') as Workspace
let section = workspace.viewState.system.section

// Update Data
let updateState = workspace.updateState
let suppressUpdates = false
$: mode = updateState.mode

$: onModeChanged($mode)
function onModeChanged(_m?) {
	// anyShimModalIsOpen() as well as Tangent's own stack: Tangent's dialogs are
	// elements on document.body rather than entries in viewState.modal, so without it a
	// ready update threw the settings menu over the top of the first-run tour.
	if ($mode === 'ready' && !suppressUpdates && !detailsOpen
		&& workspace.viewState.modal.stack.length == 0 && !anyShimModalIsOpen()) {
		detailsOpen = true
		section.set('Updates')
	}
}

// Sub-menus
const menus = [
	{
		name: 'Appearance',
		component: Appearance
	},
	{
		name: 'OSINT Copilot',
		component: OsintSettings
	},
	{
		name: 'Attachments',
		component: Attachments
	},
	{
		name: 'Creation Rules',
		component: CreationRules
	},
	{
		name: 'Database',
		component: Database
	},
	{
		name: 'Maps',
		component: Maps
	},
	{
		name: 'Notes',
		component: Notes
	},
	{
		name: 'Shortcuts',
		component: Shortcuts
	},
	{
		name: 'Custom Styles',
		component: Styles
	},
	{
		name: 'Dictionary',
		component: Dictionary
	},
	{
		name: 'Updates',
		component: Updates
	},
	...(PREMIUM_LICENSING_ENABLED ? [{
		// No documentation page: this is product licensing, not an upstream setting.
		name: 'Licence',
		component: License,
		documentation: false
	}] : []),
	{
		name: 'About',
		component: About,
		documentation: false
	}
]

if (workspace.isPreviewBuild() || workspace.settings.updateChannel.value !== 'latest') {
	menus.push({
		name: 'Debug',
		component: Debug
	})
}

$: currentMenu = menus.find(m => m.name === $section) ?? menus[0]
</script>

<PopUpButton buttonClass="subtle"
	bind:showMenu={detailsOpen}
	menuMode="low-profile"
	tooltip={{
		tooltip: "Open settings",
		shortcut: isMac ? '⌘ ,' : 'Ctrl+,'
	}}
>
	<svelte:fragment slot="button">
		<!--
			A gear, and only a gear. This button used to carry the update state as well --
			swapping its glyph for an arrow, tinting itself, and drawing a progress bar --
			because it was the only way into the update flow. UpdateButton now sits
			immediately to its left and shows all three, so doing it here too put two
			identical green arrows side by side, reading as two things to click.

			onModeChanged below is untouched: opening this menu on the Updates page when an
			update is ready is behaviour, not a second indicator.
		-->
		<div class="buttonContent">
			<svg style={`width: 24px; height: 24px;`}>
				<use href="system.svg#gear" />
			</svg>
		</div>
	</svelte:fragment>
	<main class="SystemMenu">
		<nav>
			{#each menus as menu}
				<button
					on:click={() => $section = menu.name}
					class:current={menu === currentMenu}>
					{menu.name}
				</button>
			{/each}
		</nav>
		<article class="systemMenu">
			<h1>{currentMenu.name}</h1>
			{#if currentMenu.documentation !== false}
				<DocumentationLink
					pageName={currentMenu.documentation ?? currentMenu.name}
					pagePath={'Configuration/' + (currentMenu.documentation ?? currentMenu.name)}
					style="position: absolute;
						top: .5em;
						right: 10px;"
				/>
			{/if}
			<svelte:component this={currentMenu.component}/>
		</article>
	</main>
</PopUpButton>

<style lang="scss">
.buttonContent {
	display: flex;
	align-items: center;
	position: relative;
}

main {
	display: flex;
	background-color: var(--backgroundColor);

	max-height: calc(100vh - var(--topBarHeight) - 8px);
}

nav {
	background: var(--noteBackgroundColor);
	padding: 4px 0px 4px 4px;

	overflow: auto;
	border: 4px solid var(--backgroundColor);
	border-right: 0px solid transparent;

	button {
		display: block;
		width: 100%;
		font-size: 110%;
		border-top-right-radius: 0;
		border-bottom-right-radius: 0;

		background-color: transparent;
		text-align: right;

		&.current, &:active {
			background-color: var(--accentActiveBackgroundColor);
		}
	}
}

article {
	padding: 4px 4px 8px 8px;

	border-left: 4px solid var(--accentActiveBackgroundColor);
	border-top-left-radius: 2px;
	border-bottom-left-radius: 2px;

	display: flex;
	flex-direction: column;
	font-size: 90%;

	width: 500px;
	overflow: auto;
}

h1 {
	margin-top: 0;
	text-align: center;
	font-weight: 500;
}

:global {
	.systemMenu {
		h2 {
			margin: .25em;
			font-weight: 500;
		}

		.info {
			color: var(--deemphasizedTextColor);
			padding: 1em 3em;
			margin: 0;
		}

		.settingsGroup {
			margin-bottom: 1.5em;
			border-spacing: .25em .5em;

			display: grid;
			grid-template-columns: max-content auto;
			row-gap: .5em;
			column-gap: .25em;
			grid-auto-rows: auto;
			align-items: center;

			.SettingView {
				display: contents;

				h2 {
					grid-column: 1;
					text-align: right;
				}
				.value {
					grid-column: 2;
				}
			}

			> p {
				margin-bottom: 0;
			}

			.value-details {
				grid-column: 2;
			}

			.explanation {
				color: var(--deemphasizedTextColor);
				font-size: 90%;
			}
		}
	}
}

</style>
