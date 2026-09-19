/**
 * Component -- Obsidian's lifecycle/ownership primitive.
 *
 * Every register/registerEvent cleanup is owned by a Component and runs when it
 * unloads. The plugin itself is never unloaded: it lives as long as its window, and
 * so do its registrations. Views are Components too, and do unload when closed.
 */
export class Component {
    private cleanups: (() => void)[] = [];
    private loaded = false;

    /**
     * Obsidian types onload() as returning void and fires it without awaiting, so an
     * async override's failure becomes an unhandled rejection and a half-initialised
     * plugin looks like a working one. We keep the signature but capture the promise,
     * so a host that wants to know when startup finished can await whenLoaded().
     */
    private loadPromise: Promise<void> = Promise.resolve();

    load(): void {
        if (this.loaded) return;
        this.loaded = true;
        const result = this.onload() as unknown;
        this.loadPromise = result instanceof Promise ? result as Promise<void> : Promise.resolve();
    }

    /** Resolves once an async onload() has settled. Rejects if it threw. */
    whenLoaded(): Promise<void> {
        return this.loadPromise;
    }

    onload(): void { /* subclasses override */ }

    unload(): void {
        if (!this.loaded) return;
        this.loaded = false;
        // Reverse order: later registrations may depend on earlier ones.
        for (const cleanup of this.cleanups.reverse()) {
            try {
                cleanup();
            } catch (error) {
                console.error('[obsidian-shim] cleanup threw during unload:', error);
            }
        }
        this.cleanups = [];
        this.onunload();
    }

    onunload(): void { /* subclasses override */ }

    register(cleanup: () => void): void {
        this.cleanups.push(cleanup);
    }

    registerEvent(ref: { detach?: () => void } | null | undefined): void {
        if (ref?.detach) this.register(ref.detach);
    }
}
