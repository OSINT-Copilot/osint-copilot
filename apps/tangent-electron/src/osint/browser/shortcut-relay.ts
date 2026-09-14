/**
 * Gives the app back the chords a browsing guest swallowed.
 *
 * A `<webview>` runs in its own process, so keyboard events inside it never reach the host
 * document, and listeners cannot be attached to the element either. Main catches the
 * narrow set of chords the app claims (see isApplicationChord in
 * main/osint/browser/index.ts) and sends them here; this re-dispatches them as if they had
 * been pressed in the window, which is what Tangent's shortcut handling is already
 * listening for.
 *
 * Installed once per window rather than once per pane: the message is delivered to the
 * window, so a second subscription would fire every shortcut twice.
 */
let installed = false;

export function installShortcutRelay(api: unknown): void {
	if (installed) return;
	const browse = (api as any)?.osint?.browse;
	if (typeof browse?.onShortcut !== 'function') return;
	installed = true;

	browse.onShortcut((input: {
		key: string, code: string,
		control: boolean, meta: boolean, alt: boolean, shift: boolean,
	}) => {
		document.dispatchEvent(new KeyboardEvent('keydown', {
			key: input.key,
			code: input.code,
			ctrlKey: input.control,
			metaKey: input.meta,
			altKey: input.alt,
			shiftKey: input.shift,
			bubbles: true,
			cancelable: true,
		}));
	});
}

/** Test seam: the relay is module state, and tests need a fresh one. */
export function resetShortcutRelayForTests(): void {
	installed = false;
}
