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
	return commands
}
