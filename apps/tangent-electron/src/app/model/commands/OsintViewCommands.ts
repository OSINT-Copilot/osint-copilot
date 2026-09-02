/**
 * Commands that open OSINT Copilot's views.
 *
 * A new file in Tangent's commands directory rather than an edit to an existing one:
 * new files never conflict on a merge from upstream. Registering here rather than in the
 * plugin's own command list is what gets these into Tangent's command palette and its
 * shortcut editor, so they behave like every other command in the app.
 *
 * Imports only the dependency-free descriptor module. Pulling in the real view modules
 * would put cytoscape, leaflet and ~9,700 lines of view code into the startup path for
 * users who never open an OSINT view.
 */
import type Workspace from '../Workspace'
import WorkspaceCommand from './WorkspaceCommand'
import type { CommandContext } from './Command'
import { OSINT_VIEWS, type OsintViewDescriptor } from 'osint/integration/osint-view-types'

export class OpenOsintViewCommand extends WorkspaceCommand {
	readonly view: OsintViewDescriptor

	constructor(workspace: Workspace, view: OsintViewDescriptor) {
		super(workspace)
		this.view = view
	}

	async execute(_context?: CommandContext) {
		// Imported lazily so the view layer only loads once a view is actually opened.
		const { openOsintView } = await import('osint/integration/open-view')
		openOsintView(this.view.viewType)
	}

	getLabel(_context?: CommandContext) {
		return `OSINT: Open ${this.view.title}`
	}

	getTooltip(_context?: CommandContext) {
		return `Opens OSINT Copilot's ${this.view.title} view.`
	}
}

/** Keyed by the descriptor's commandKey, ready to spread into the command registry. */
export function createOsintViewCommands(workspace: Workspace) {
	const commands: Record<string, OpenOsintViewCommand> = {}
	for (const view of OSINT_VIEWS) {
		commands[view.commandKey] = new OpenOsintViewCommand(workspace, view)
	}
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
			console.log(`[osint] registered ${keys.length} plugin commands with Tangent`)
			return
		}
		await new Promise(resolve => setTimeout(resolve, 100))
	}
}


/**
 * Bridges the plugin's own commands into Tangent's registry.
 *
 * The plugin registers ~20 commands through Obsidian's addCommand(); this wraps each one
 * so it shows up in Tangent's command palette and can be given a keyboard shortcut in
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
	checkCallback?: (checking: boolean) => boolean | void
}

export class PluginCommand extends WorkspaceCommand {
	readonly command: ObsidianCommand

	constructor(workspace: Workspace, command: ObsidianCommand) {
		super(workspace)
		this.command = command
	}

	canExecute(_context?: CommandContext) {
		// checkCallback(true) is Obsidian's "is this available right now?" probe.
		if (this.command.checkCallback) return this.command.checkCallback(true) !== false
		return true
	}

	execute(_context?: CommandContext) {
		if (this.command.checkCallback) {
			this.command.checkCallback(false)
			return
		}
		this.command.callback?.()
	}

	getLabel(_context?: CommandContext) {
		return `OSINT: ${this.command.name}`
	}
}

/** Adds one Tangent command per plugin command. Returns the keys it registered. */
export function registerPluginCommands(
	workspace: Workspace,
	commands: Iterable<ObsidianCommand>,
): string[] {
	const registered: string[] = []
	for (const command of commands) {
		// camelCase the Obsidian id so it reads like the rest of the registry.
		const key = 'osintCmd_' + command.id.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
		;(workspace.commands as Record<string, WorkspaceCommand>)[key] = new PluginCommand(workspace, command)
		registered.push(key)
	}
	return registered
}
