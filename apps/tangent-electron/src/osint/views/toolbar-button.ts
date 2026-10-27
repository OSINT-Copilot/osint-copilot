import { setIcon } from 'obsidian';

/**
 * A toolbar button with a lucide glyph and a text label, in place of the emoji that used
 * to stand in for icons. The label is a span of its own so a busy state can relabel the
 * button without discarding the icon. `clsPrefix` is the view's button class stem, e.g.
 * 'graph_copilot-map-btn' gives the spans graph_copilot-map-btn-icon and -label.
 */
export function iconButton(parent: HTMLElement, icon: string, label: string, clsPrefix: string): HTMLButtonElement {
    const btn = parent.createEl('button');
    setIcon(btn.createSpan({ cls: `${clsPrefix}-icon` }), icon);
    btn.createSpan({ cls: `${clsPrefix}-label`, text: label });
    return btn;
}

export function setButtonLabel(btn: HTMLButtonElement, label: string, clsPrefix: string): void {
    const labelEl = btn.querySelector(`.${clsPrefix}-label`);
    if (labelEl) labelEl.textContent = label;
}
