/**
 * Component -- Obsidian's lifecycle/ownership primitive.
 *
 * This is the machinery that made the plugin's empty onunload() survivable: every
 * registerEvent/registerDomEvent/registerInterval is owned by a Component and torn
 * down when it unloads. Since vault-ai-plugin.ts:918 does nothing, ALL of that
 * cleanup is implicit today -- so this class is what makes vault switching and
 * window close leak-free rather than an afterthought.
 */
export class Component {
    private children: Component[] = [];
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
        for (const child of this.children) child.load();
    }

    /** Resolves once an async onload() has settled. Rejects if it threw. */
    whenLoaded(): Promise<void> {
        return this.loadPromise;
    }

    onload(): void { /* subclasses override */ }

    unload(): void {
        if (!this.loaded) return;
        this.loaded = false;
        for (const child of [...this.children]) child.unload();
        this.children = [];
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

    addChild<T extends Component>(child: T): T {
        this.children.push(child);
        if (this.loaded) child.load();
        return child;
    }

    removeChild<T extends Component>(child: T): T {
        const at = this.children.indexOf(child);
        if (at >= 0) this.children.splice(at, 1);
        child.unload();
        return child;
    }

    register(cleanup: () => void): void {
        this.cleanups.push(cleanup);
    }

    registerEvent(ref: { detach?: () => void } | null | undefined): void {
        if (ref?.detach) this.register(ref.detach);
    }

    registerDomEvent<K extends keyof WindowEventMap>(
        target: Window | Document | HTMLElement,
        type: string,
        callback: (event: WindowEventMap[K] | Event) => void,
        options?: AddEventListenerOptions,
    ): void {
        target.addEventListener(type, callback as EventListener, options);
        this.register(() => target.removeEventListener(type, callback as EventListener, options));
    }

    registerInterval(id: number): number {
        this.register(() => window.clearInterval(id));
        return id;
    }

    /** True between load() and unload(). */
    isLoaded(): boolean {
        return this.loaded;
    }
}
