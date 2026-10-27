import { vi } from 'vitest';
import { installDomExtensions } from '../obsidian-shim/dom/dom-extensions';

// The `obsidian` module is aliased to tests/obsidian-mock.ts by
// vitest.config.project.osint.mts.

// The DOM helpers Obsidian patches onto HTMLElement are supplied by the real shim, not
// by a partial copy: it is a strict superset of what the plugin's own test setup used to
// install.
installDomExtensions();

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
