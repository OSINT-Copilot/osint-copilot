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
    /** Set when startup threw: the message, so a view can say so instead of waiting 60s. */
    failed?: string;
}

type Subscriber = (state: OsintPluginState) => void;

/**
 * Backed by a globalThis singleton for the same reason bootstrap.ts is: this module is
 * reached both dynamically (App.svelte) and statically (Tangent.ts -> view-states), so
 * module-local state is bundler-dependent. Two copies would leave the toolbar's gate and
 * the canvas command's `ready` check frozen at their defaults, with no error.
 */
interface Shared { current: OsintPluginState; subscribers: Set<Subscriber> }
const shared: Shared = ((globalThis as unknown as { __osintPluginState?: Shared }).__osintPluginState ??= {
    current: { ready: false, settings: null },
    subscribers: new Set<Subscriber>(),
});

export const osintPluginState = {
    get value(): OsintPluginState {
        return shared.current;
    },
    subscribe(run: Subscriber): () => void {
        shared.subscribers.add(run);
        run(shared.current);
        return () => { shared.subscribers.delete(run); };
    },
};

/** Merges and notifies -- unconditionally, because settings are edited in place. */
export function publishOsintPluginState(patch: Partial<OsintPluginState>): void {
    shared.current = { ...shared.current, ...patch };
    for (const run of shared.subscribers) run(shared.current);
}

/** The gate the toolbar and the view commands agree on. Defaults open, like the setting. */
export function graphFeaturesEnabled(state: OsintPluginState = shared.current): boolean {
    return state.settings?.enableGraphFeatures ?? true;
}
