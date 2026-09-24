/**
 * Commands that open OSINT Copilot's views.
 *
 * A new file in OSINT Copilot's commands directory rather than an edit to an existing one:
 * new files never conflict on a merge from upstream. Registering here rather than in the
 * plugin's own command list is what gets these into OSINT Copilot's command palette and its
 * shortcut editor, so they behave like every other command in the app.
 *
 * Imports only the dependency-free descriptor module. Pulling in the real view modules
 * would put cytoscape, leaflet and ~9,700 lines of view code into the startup path for
 * users who never open an OSINT view.
 */
import type Workspace from '../Workspace'
import WorkspaceCommand from './WorkspaceCommand'
import type { CommandContext } from './Command'
import { OSINT_VIEWS, nodePathFor, type OsintViewDescriptor } from 'osint/integration/osint-view-types'
import { osintPluginState, graphFeaturesEnabled } from 'osint/integration/osint-plugin-state'

/**
 * Opens one OSINT view. Also what the toolbar pill is built from.
 *
 * The pill renders each of these through OSINT Copilot's `use:command` action -- the same one
 * the Map/Thread/Focus buttons use -- so the tooltip, the shortcut in it, and the
 * `checked` highlight all come from this class rather than from any toolbar code.
 * getChecked() says whether the view is the current node. canExecute() deliberately does
 * NOT also disable the current one: use:command sets both `checked` and `disabled` on the
 * same element, so the "you are here" button was the dimmest icon in the group.
 * Re-opening the current view is a no-op in open-view.ts anyway. Both are re-evaluated
 * when the thread moves or a setting changes, because the constructor subscribes and
 * calls alertDirty(), which is how SetFocusLevelCommand keeps its buttons live.
 *
 * A view the graph-features setting has turned off stays executable: the pill hides its
 * button, but the palette and the shortcut still reach it, and a silent no-op there told
 * the user nothing. Executing it opens the settings page and says why.
 */
export class OpenOsintViewCommand extends WorkspaceCommand {
	readonly view: OsintViewDescriptor

	constructor(workspace: Workspace, view: OsintViewDescriptor) {
		// A default shortcut, so it shows in the tooltip and in Preferences > Shortcuts.
		super(workspace, { shortcut: view.shortcut })
		this.view = view
		// viewState exists before the registry is built (Workspace.ts constructs it first),
		// which is what makes subscribing here safe -- and it is exactly what
		// SetFocusLevelCommand does with focusLevel.
		workspace.viewState?.tangent?.currentNode?.subscribe?.(() => this.alertDirty())
		osintPluginState.subscribe(() => this.alertDirty())
	}

	/**
	 * Whether the thread's current node is this view's marker file -- the marker, not any
	 * file with the extension, so a stray .osintchat elsewhere in the vault does not light
	 * the Chat button.
	 */
	get isCurrent(): boolean {
		const node = this.workspace.viewState?.tangent?.currentNode?.value
		if (!node) return false
		const root = this.workspace.directoryStore?.files?.path
		if (root) return node.path === `${root}/${nodePathFor(this.view)}`
		return node.fileType === this.view.fileType
	}

	/** Off while the graph-features setting hides it. */
	get isEnabled(): boolean {
		return !this.view.requiresGraphFeatures || graphFeaturesEnabled()
	}

	canExecute(_context?: CommandContext) {
		// Not before the plugin is up: clicking earlier landed in a 60-second wait.
		return osintPluginState.value.ready
	}

	getChecked(_context?: CommandContext) {
		return this.isCurrent
	}

	async execute(_context?: CommandContext) {
		// Imported lazily so the view layer only loads once a view is actually opened.
		const { openOsintView, openOsintSettings } = await import('osint/integration/open-view')
		if (!this.isEnabled) {
			const { Notice } = await import('osint/obsidian-shim/ui/notice')
			new Notice(`${this.view.label} is turned off. Enable graph features under OSINT Copilot → Graph view.`, 7000, 'warning')
			openOsintSettings()
			return
		}
		openOsintView(this.view.viewType)
	}

	getLabel(_context?: CommandContext) {
		return `OSINT: Open ${this.view.label}`
	}

	getTooltip(_context?: CommandContext) {
		// use:command appends the shortcut itself.
		return `Open ${this.view.label}`
	}
}

/**
 * Creates a canvas board and opens it.
 *
 * Not a view: a board is a real .canvas file, and there can be any number of them. That is
 * why it lives in the New Note menu next to the creation rules rather than in the views
 * pill, and why it is not gated by the graph-features setting.
 */
export class NewOsintCanvasCommand extends WorkspaceCommand {
	constructor(workspace: Workspace) {
		super(workspace)
		osintPluginState.subscribe(() => this.alertDirty())
	}

	canExecute(_context?: CommandContext) {
		// createCanvasBoard needs the plugin's vault adapter, which exists once it is up.
		return osintPluginState.value.ready
	}

	async execute(_context?: CommandContext) {
		const { osintRuntime } = await import('osint/integration/bootstrap')
		const plugin = osintRuntime()?.plugin
		if (!plugin) {
			// canExecute gates on ready, so this is a real fault, not a race; say so.
			console.error('[osint] New Canvas Board: the plugin is not available')
			return
		}
		await plugin.createCanvasBoard()
	}

	getLabel(_context?: CommandContext) {
		return 'OSINT: New Canvas Board'
	}

	getTooltip(_context?: CommandContext) {
		return 'Create a new canvas board and open it.'
	}
}

/**
 * Opens the board picker: which canvas board to open, or a new one.
 *
 * In the toolbar pill rather than only the New Note menu, because a board is one of the
 * places an investigation actually lives. It is a picker and not a create button for the
 * reason spelled out in BoardPickerModal: every other button in the pill opens something,
 * and clicking a create button twice leaves an empty "Board 2" behind.
 *
 * Its shortcut is Mod+Alt+7, the seventh position in the pill -- the boards button sits
 * after the six views, so the "shortcut digit = position in the bar" rule still holds for
 * the whole strip even though this is not an OSINT_VIEWS entry.
 */
export class OpenOsintCanvasCommand extends WorkspaceCommand {
	constructor(workspace: Workspace) {
		super(workspace, { shortcut: 'Mod+Alt+7' })
		workspace.viewState?.tangent?.currentNode?.subscribe?.(() => this.alertDirty())
		osintPluginState.subscribe(() => this.alertDirty())
	}

	canExecute(_context?: CommandContext) {
		// The picker reads the vault index and can create a board; both need the plugin.
		return osintPluginState.value.ready
	}

	/** Lit while a board is the current node, the way the view buttons light for theirs. */
	getChecked(_context?: CommandContext) {
		const node = this.workspace.viewState?.tangent?.currentNode?.value
		return node?.fileType === '.canvas'
	}

	async execute(_context?: CommandContext) {
		const { osintRuntime } = await import('osint/integration/bootstrap')
		const runtime = osintRuntime()
		if (!runtime) {
			// canExecute gates on ready, so reaching here is a fault rather than a race.
			console.error('[osint] Canvas: the plugin is not available')
			return
		}
		const [{ BoardPickerModal }, { openIndexedVaultNode }] = await Promise.all([
			import('osint/modals/board-picker-modal'),
			import('osint/integration/open-view'),
		])
		new BoardPickerModal(runtime.app as never, {
			openBoard: (path: string) => {
				if (!openIndexedVaultNode(path)) {
					console.error('[osint] Canvas: board is not indexed', path)
				}
			},
			createBoard: () => runtime.plugin.createCanvasBoard(),
		}).open()
	}

	getLabel(_context?: CommandContext) {
		return 'OSINT: Canvas boards'
	}

	getTooltip(_context?: CommandContext) {
		return 'Open a canvas board'
	}
}

/** Keyed by the descriptor's commandKey, ready to spread into the command registry. */
export function createOsintViewCommands(workspace: Workspace) {
	const commands: Record<string, WorkspaceCommand> = {}
	for (const view of OSINT_VIEWS) {
		commands[view.commandKey] = new OpenOsintViewCommand(workspace, view)
	}
	commands.osintNewCanvas = new NewOsintCanvasCommand(workspace)
	commands.osintOpenCanvas = new OpenOsintCanvasCommand(workspace)
	// The plugin's own commands only exist after its async startup, so they are added
	// later. CommandPalette reads Object.keys(workspace.commands) each time it opens.
	void attachPluginCommandsWhenReady(workspace)
	return commands
}

async function attachPluginCommandsWhenReady(workspace: Workspace, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const plugin = (globalThis as any).osint?.plugin
		if (plugin?.commands) {
			const keys = registerPluginCommands(workspace, plugin.commands.values())
			console.debug(`[osint] registered ${keys.length} plugin commands with OSINT Copilot`)
			return
		}
		await new Promise(resolve => setTimeout(resolve, 100))
	}
}


/**
 * Bridges the plugin's own commands into OSINT Copilot's registry.
 *
 * The plugin registers ~20 commands through Obsidian's addCommand(); this wraps each one
 * so it shows up in OSINT Copilot's command palette and can be given a keyboard shortcut in
 * Preferences > Shortcuts, alongside every other command in the app.
 *
 * Registered at runtime rather than in createAllCommands(), because the commands only
 * exist once the plugin's async onload() has run. CommandPalette reads
 * Object.keys(workspace.commands) each time it opens, so late additions are picked up.
 */
export interface ObsidianCommand {
	id: string
	name: string
	callback?: () => unknown
}

class PluginCommand extends WorkspaceCommand {
	readonly command: ObsidianCommand

	constructor(workspace: Workspace, command: ObsidianCommand) {
		super(workspace)
		this.command = command
	}

	execute(_context?: CommandContext) {
		this.command.callback?.()
	}

	getLabel(_context?: CommandContext) {
		return `OSINT: ${this.command.name}`
	}
}

/** Adds one OSINT Copilot command per plugin command. Returns the keys it registered. */
function registerPluginCommands(
	workspace: Workspace,
	commands: Iterable<ObsidianCommand>,
): string[] {
	const registered: string[] = []
	// The saved keymap was applied to the registry at construction (Workspace.ts), before
	// these existed, so a shortcut the user assigned to one of them was never applied on
	// the next launch. Read it here for the late arrivals.
	const keymap = workspace.settings?.keymap?.value as { get?(key: string): string[] | undefined } | undefined
	for (const command of commands) {
		// camelCase the Obsidian id so it reads like the rest of the registry.
		const key = 'osintCmd_' + command.id.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
		const wrapped = new PluginCommand(workspace, command)
		// Workspace.ts assigns ids in workspaceCommands(); a late registration has to do it
		// itself, or menu-state updates for these commands collide on the key "undefined".
		;(wrapped as unknown as { id: string }).id = key
		const saved = keymap?.get?.(key)
		if (saved) wrapped.shortcuts = saved
		;(workspace.commands as Record<string, WorkspaceCommand>)[key] = wrapped
		registered.push(key)
	}
	return registered
}
