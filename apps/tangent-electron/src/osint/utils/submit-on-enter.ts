/**
 * Submit a dialog from one of its text fields on Enter.
 *
 * Enter in a bare <input> does nothing outside a <form>, and these dialogs are not in
 * one, so the only way to confirm was to reach for the mouse. Key repeat is ignored --
 * holding the key must not create the file three times -- and so is a composition
 * commit, which an IME delivers as Enter too.
 */
export function submitOnEnter(input: HTMLInputElement, submit: () => void): void {
	input.addEventListener("keydown", (event: KeyboardEvent) => {
		if (event.key !== "Enter" || event.repeat || event.isComposing) return;
		event.preventDefault();
		submit();
	});
}
