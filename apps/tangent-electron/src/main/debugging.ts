import Logger from 'js-logger'

const log = Logger.get('debugging')

export async function initializeDebugging() {
	// Crash uploads in the upstream application targeted an account this project does not
	// control.  An OSINT workspace can contain sensitive investigation material, so a fork
	// must never inherit an upload destination or briefly enable uploads before settings
	// finish loading.  Keep this hook for a future project-owned, explicitly opt-in crash
	// service; for now Electron's network crash reporter is deliberately not started.
	log.info('Automatic crash reporting is disabled')
}
