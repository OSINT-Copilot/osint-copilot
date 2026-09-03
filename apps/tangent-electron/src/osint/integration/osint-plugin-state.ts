/**
 * What the shell needs to know about the plugin, as a store.
 *
 * The toolbar hides the graph-backed views while enableGraphFeatures is off, and it used to
 * read that flag once, when the ribbon first rendered -- so flipping the setting changed
 * nothing until a restart. The plugin mutates its settings object in place, so identity
 * never changes and nothing downstream could notice on its own. Hence an explicit publish,
 * which always notifies.
 *
 * Svelte's store contract, hand-rolled: no imports from common/ or app/, so this stays
 * inside the strict osint typecheck and can be consumed from Tangent's command layer too.
 */
import type { VaultAISettings } from '../settings/vault-ai-settings';

export interface OsintPluginState {
    /** True once the plugin has finished starting; false again after dispose. */
    ready: boolean;
    settings: VaultAISettings | null;
}

type Subscriber = (state: OsintPluginState) => void;

let current: OsintPluginState = { ready: false, settings: null };
const subscribers = new Set<Subscriber>();

export const osintPluginState = {
    get value(): OsintPluginState {
        return current;
    },
    subscribe(run: Subscriber): () => void {
        subscribers.add(run);
        run(current);
        return () => { subscribers.delete(run); };
    },
};

/** Merges and notifies -- unconditionally, because settings are edited in place. */
export function publishOsintPluginState(patch: Partial<OsintPluginState>): void {
    current = { ...current, ...patch };
    for (const run of subscribers) run(current);
}

/** The gate the toolbar and the view commands agree on. Defaults open, like the setting. */
export function graphFeaturesEnabled(state: OsintPluginState = current): boolean {
    return state.settings?.enableGraphFeatures ?? true;
}
