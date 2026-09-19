import type { CommandContext } from './Command'
import WorkspaceCommand from './WorkspaceCommand'
import type Workspace from '../Workspace'

/**
 * One button for the whole update flow.
 *
 * The machinery already existed -- UpdateState wraps the electron-updater events, and
 * Settings > Updates drives it -- but reaching it meant opening settings and finding the
 * right page, so in practice nobody checked. This puts the same three actions on the
 * toolbar, and which one it performs depends on where the flow currently is:
 *
 *   idle / up-to-date / error   ->  check
 *   ready                       ->  quit and install
 *   checking / downloading      ->  nothing to do; the button reports progress instead
 *
 * 'available' is deliberately not a click target: autoUpdater.autoDownload is on, so that
 * state lasts only until the first progress event arrives on its own.
 */
export class UpdateAppCommand extends WorkspaceCommand {

	constructor(workspace: Workspace) {
		super(workspace)
		// The label, tooltip and enabled state are all derived from the mode, so the
		// button has to be re-evaluated whenever it moves. Same pattern as
		// SetFocusLevelCommand subscribing to focusLevel.
		workspace.updateState.mode.subscribe(() => this.alertDirty())
	}

	private get mode() {
		return this.workspace.updateState.mode.value
	}

	canExecute(_context?: CommandContext) {
		const mode = this.mode
		// In flight: clicking again would either start a second check or do nothing at
		// all, and a button that looks live but is not is worse than a disabled one.
		return mode !== 'checking' && mode !== 'downloading' && mode !== 'available'
	}

	execute(_context?: CommandContext) {
		const state = this.workspace.updateState
		if (this.mode === 'ready') {
			// Saves and closes workspaces on the main side before relaunching.
			state.updateNow()
			return
		}
		state.checkForUpdate()
	}

	getLabel(_context?: CommandContext) {
		const version = this.workspace.updateState.nextUpdate.value?.version
		switch (this.mode) {
			case 'checking': return 'Checking for Updates…'
			case 'available': return version ? `Downloading ${version}…` : 'Downloading Update…'
			case 'downloading': return version ? `Downloading ${version}…` : 'Downloading Update…'
			case 'ready': return version ? `Restart and Update to ${version}` : 'Restart and Update'
			default: return 'Check for Updates'
		}
	}

	getTooltip(_context?: CommandContext) {
		switch (this.mode) {
			case 'up-to-date':
				return `You are up to date on v${this.workspace.version}.`
			case 'error':
				return 'The last update check failed. Click to try again.'
			case 'ready':
				return 'The update is downloaded. Click to restart and apply it.'
			default:
				return this.getLabel()
		}
	}
}
