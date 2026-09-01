import { vi } from 'vitest';
import { installDomExtensions } from '../obsidian-shim/dom/dom-extensions';

// The `obsidian` module is aliased to tests/obsidian-mock.ts by
// vitest.config.project.osint.mts.

// The DOM helpers Obsidian patches onto HTMLElement are supplied by the real shim, not
// by a partial copy: it is a strict superset of what the plugin's own test setup used to
// install, and it is covered by dom-extensions.test.ts.
installDomExtensions();

// pdfjs-dist 5.x (the version Tangent already depends on for its PDF viewer) references
// DOMMatrix while the module is being evaluated. jsdom does not implement it, and text
// extraction never uses it — a stub is enough to let the real extraction code run.
// TODO(phase-1): extraction moves to the main process (host.extract.pdfText); this test
// should move with it and drop the stub.
if (typeof (globalThis as any).DOMMatrix === 'undefined') {
    (globalThis as any).DOMMatrix = class DOMMatrix {
        a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
        constructor(_init?: unknown) {}
        multiply() { return this; }
        translate() { return this; }
        scale() { return this; }
        inverse() { return this; }
    };
}

if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'ResizeObserver', {
        writable: true,
        value: vi.fn().mockImplementation(() => ({
            observe: vi.fn(),
            unobserve: vi.fn(),
            disconnect: vi.fn(),
        })),
    });
}
