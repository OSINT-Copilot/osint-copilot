/**
 * The pivot menu on a page, built in main.
 *
 * It has to be built here. Listeners cannot be attached to a `<webview>` element, so the
 * renderer never sees a selection inside a guest; `context-menu` on the guest's webContents
 * carries `params.selectionText` from Chromium's own selection model, which is the only
 * reliable source for "what did the analyst just highlight".
 *
 * Choosing a pivot does NOT open anything here. Main sends the chosen destinations to the
 * host and the renderer creates panes for them -- parked, because a pane whose document
 * carries a URL waits to be asked. A fan-out that fired eleven requests the moment someone
 * right-clicked would send the selected value to eleven third parties before they had
 * decided to ask any of them.
 */
import { Menu, MenuItem } from 'electron'
import Logger from 'js-logger'

import * as vaultFs from '../node/vault'
import {
	BUNDLED_PIVOTS, buildUrl, classify, cleanValue, mergePivots, parsePivots, pivotsFor,
	type Pivot, type ValueKind,
} from './pivot-policy'

export const PIVOTS_VAULT_PATH = 'OSINTCopilot/browsing/pivots.json'

/**
 * How many destinations one fan-out may open at once.
 *
 * Not a performance limit -- the panes are parked and cost nothing until loaded. It is
 * there because forty panes in a thread is not a usable investigation, and because a
 * number the analyst can see is easier to reason about than a menu that grows silently.
 */
export const FAN_OUT_CAP = 8

export async function loadPivots(): Promise<Pivot[]> {
	let user: Pivot[] = []
	try {
		user = parsePivots(await vaultFs.read(PIVOTS_VAULT_PATH))
	}
	catch {
		// No user file: the bundled list stands on its own.
	}
	return mergePivots(BUNDLED_PIVOTS, user)
}

export interface PivotTarget {
	pivotId: string
	label: string
	url: string
}

export interface PivotRequest {
	value: string
	kind: ValueKind
	targets: PivotTarget[]
}

/** Everything the menu would offer for this selection. */
export async function targetsFor(selection: string): Promise<PivotRequest> {
	const kind = classify(selection)
	const value = cleanValue(selection, kind)
	const pivots = pivotsFor(await loadPivots(), kind)
	return {
		value,
		kind,
		targets: pivots.map(pivot => ({
			pivotId: pivot.id,
			label: pivot.label,
			url: buildUrl(pivot, value),
		})),
	}
}

/**
 * Shows the pivot menu for a guest's current selection.
 *
 * Returns false when there is nothing to offer, so the caller can fall back to whatever
 * menu it would otherwise have shown.
 */
export async function showPivotMenu(
	guest: Electron.WebContents,
	host: Electron.WebContents,
	selectionText: string,
): Promise<boolean> {
	const selection = (selectionText ?? '').trim()
	if (!selection || selection.length > 500) return false

	const request = await targetsFor(selection)
	if (!request.targets.length) return false

	const shortened = request.value.length > 40 ? request.value.slice(0, 40) + '…' : request.value
	const menu = new Menu()

	menu.append(new MenuItem({
		label: `Pivot on “${shortened}” (${request.kind})`,
		enabled: false,
	}))
	menu.append(new MenuItem({ type: 'separator' }))

	for (const target of request.targets.slice(0, FAN_OUT_CAP)) {
		menu.append(new MenuItem({
			label: target.label,
			click: () => send(host, guest.id, request, [target]),
		}))
	}

	const fanOut = request.targets.slice(0, FAN_OUT_CAP)
	if (fanOut.length > 1) {
		menu.append(new MenuItem({ type: 'separator' }))
		menu.append(new MenuItem({
			// The count is in the label on purpose: this is the moment the analyst decides
			// how many third parties are about to be told about this value.
			label: `Open all ${fanOut.length} as unloaded panes`,
			click: () => send(host, guest.id, request, fanOut),
		}))
	}

	menu.popup({ window: undefined })
	Logger.info(`[osint] pivot menu for a ${request.kind} with ${request.targets.length} targets`)
	return true
}

/**
 * Carries the guest's id because the message goes to the WINDOW, not to a pane. Without
 * it every open browsing pane would act on the same pivot and the fan-out would be created
 * once per pane.
 */
function send(
	host: Electron.WebContents, webContentsId: number,
	request: PivotRequest, targets: PivotTarget[],
): void {
	if (host.isDestroyed()) return
	host.send('osint:browse.pivot', {
		webContentsId, value: request.value, kind: request.kind, targets,
	})
}
