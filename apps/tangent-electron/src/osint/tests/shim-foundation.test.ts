import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Modal } from '../obsidian-shim/ui/modal';
import { Menu } from '../obsidian-shim/ui/menu';
import { Notice, inferNoticeVariant } from '../obsidian-shim/ui/notice';
import { Vault } from '../obsidian-shim/vault/vault';
import { MemoryStorage, type VaultStorage } from '../obsidian-shim/vault/storage';
import { Plugin } from '../obsidian-shim/core/plugin';
import { TFile } from '../obsidian-shim/vault/tfile';
import { createTestAppAsync } from '../obsidian-shim/testing/create-test-app';
import type { StatDto, WatchEvent } from '../host/types';

const fakeApp = {} as never;
const key = (k: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });

afterEach(() => {
    document.body.innerHTML = '';
});

describe('Modal', () => {
    it('renders a real, labelled close button', () => {
        const m = new Modal(fakeApp);
        const btn = m.modalEl.querySelector('button.modal-close-button') as HTMLButtonElement;
        // It was an empty div: zero size, invisible, unreachable by keyboard.
        expect(btn).toBeTruthy();
        expect(btn.getAttribute('aria-label')).toBe('Close');
        expect(btn.textContent).toBe('×');
        expect(m.modalEl.getAttribute('role')).toBe('dialog');
        expect(m.modalEl.getAttribute('aria-modal')).toBe('true');
    });

    it('Escape closes only the topmost dialog and marks the event handled', () => {
        const a = new Modal(fakeApp); const b = new Modal(fakeApp);
        a.open(); b.open();
        const ev = key('Escape');
        document.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(b.containerEl.isConnected).toBe(false);
        // The dialog underneath is untouched -- one Escape used to close every open modal.
        expect(a.containerEl.isConnected).toBe(true);
        a.close();
    });

    it('keeps app shortcuts from reaching the window while it is open', () => {
        // Tangent dispatches its shortcuts from a window keydown; with a dialog up,
        // Mod+W closed the note behind it. The dialog acts as a keymap scope now.
        const seen = vi.fn();
        window.addEventListener('keydown', seen);
        const m = new Modal(fakeApp); m.open();
        document.dispatchEvent(key('w', { ctrlKey: true }));
        expect(seen).not.toHaveBeenCalled();
        m.close();
        document.dispatchEvent(key('w', { ctrlKey: true }));
        expect(seen).toHaveBeenCalledTimes(1);
        window.removeEventListener('keydown', seen);
    });

    it('open() is idempotent and leaves no listener behind after close()', () => {
        const m = new Modal(fakeApp);
        m.open(); m.open();
        m.close();
        const seen = vi.fn();
        window.addEventListener('keydown', seen);
        document.dispatchEvent(key('Escape'));
        // A second open() used to overwrite the handler and leak the first one for good.
        expect(seen).toHaveBeenCalledTimes(1);
        window.removeEventListener('keydown', seen);
    });

    it('lets a subclass refuse backdrop dismissal', () => {
        class Sticky extends Modal { constructor() { super(fakeApp); this.closeOnBackgroundClick = false; } }
        const plain = new Modal(fakeApp); plain.open();
        (plain.containerEl.querySelector('.modal-bg') as HTMLElement).click();
        expect(plain.containerEl.isConnected).toBe(false);

        const sticky = new Sticky(); sticky.open();
        (sticky.containerEl.querySelector('.modal-bg') as HTMLElement).click();
        expect(sticky.containerEl.isConnected).toBe(true);
        sticky.close();
    });

    it('wraps Tab focus inside the dialog', () => {
        const m = new Modal(fakeApp);
        const first = m.contentEl.createEl('button', { text: 'first' });
        const last = m.contentEl.createEl('button', { text: 'last' });
        m.open();
        // The close button is the last tab stop in DOM order; from there Tab must wrap.
        const closeBtn = m.modalEl.querySelector('button.modal-close-button') as HTMLButtonElement;
        closeBtn.focus();
        const forward = key('Tab');
        document.dispatchEvent(forward);
        expect(forward.defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(first);
        const back = key('Tab', { shiftKey: true });
        document.dispatchEvent(back);
        expect(document.activeElement).toBe(closeBtn);
        // And focus that has escaped the dialog is pulled back in.
        document.body.appendChild(document.createElement('button')).focus();
        document.dispatchEvent(key('Tab'));
        expect(m.modalEl.contains(document.activeElement)).toBe(true);
        expect(last.isConnected).toBe(true);
        m.close();
    });
});

describe('Menu', () => {
    it('clamps itself to the viewport', () => {
        const menu = new Menu();
        menu.addItem((i) => i.setTitle('one'));
        vi.spyOn(menu.dom, 'getBoundingClientRect').mockReturnValue({
            width: 200, height: 300, top: 0, left: 0, right: 200, bottom: 300, x: 0, y: 0, toJSON() {},
        } as DOMRect);
        menu.showAtPosition({ x: window.innerWidth - 20, y: window.innerHeight - 20 });
        expect(parseFloat(menu.dom.style.left)).toBeLessThanOrEqual(window.innerWidth - 200);
        expect(parseFloat(menu.dom.style.top)).toBeLessThanOrEqual(window.innerHeight - 300);
        menu.hide();
    });

    it('Escape dismisses it and is marked handled; items are real buttons', () => {
        const menu = new Menu();
        menu.addItem((i) => i.setTitle('one').setTitle('renamed'));
        menu.showAtPosition({ x: 10, y: 10 });
        const item = menu.dom.querySelector('.menu-item') as HTMLButtonElement;
        expect(item.tagName).toBe('BUTTON');
        expect(item.getAttribute('role')).toBe('menuitem');
        // setTitle replaces rather than stacking a second title div.
        expect(menu.dom.querySelectorAll('.menu-item-title')).toHaveLength(1);
        expect(item.textContent).toBe('renamed');
        const ev = key('Escape');
        document.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true);
        expect(menu.dom.isConnected).toBe(false);
    });
});

describe('Notice', () => {
    it('infers a variant from the message and exposes it to assistive tech', () => {
        expect(inferNoticeVariant('❌ Failed to extract text')).toBe('error');
        expect(inferNoticeVariant('Could not open this link')).toBe('error');
        expect(inferNoticeVariant('⚠️ Large attachment')).toBe('warning');
        expect(inferNoticeVariant('✅ Saved')).toBe('success');
        expect(inferNoticeVariant('Graph refreshed successfully')).toBe('info');
        const n = new Notice('Failed to refresh graph', 0);
        expect(n.noticeEl.classList.contains('mod-error')).toBe(true);
        expect(n.noticeEl.getAttribute('role')).toBe('alert');
        expect(n.noticeEl.parentElement?.getAttribute('aria-live')).toBe('polite');
        n.hide();
    });
});

/** A storage that behaves like the real host: `read` is a UTF-8 decode, bytes come from readBinary. */
function hostLikeStorage(files: Record<string, Uint8Array>, onChangeCapture?: (cb: (e: WatchEvent[]) => void) => void): VaultStorage {
    const stat = (path: string): StatDto => ({ path, type: 'file', ctime: 1, mtime: 1, size: files[path]?.length ?? 0 });
    return {
        snapshot: async () => Object.keys(files).map(stat),
        read: async (p) => new TextDecoder('utf-8').decode(files[p]),
        readBinary: async (p) => files[p],
        write: async (p, d) => { files[p] = new TextEncoder().encode(d); return stat(p); },
        writeBinary: async (p, d) => { files[p] = d; return stat(p); },
        create: async (p, d) => { files[p] = new TextEncoder().encode(d); return stat(p); },
        mkdir: async (p) => ({ path: p, type: 'folder', ctime: 1, mtime: 1, size: 0 }),
        remove: async () => {}, trash: async () => {}, rename: async () => {},
        onChange: (cb) => { onChangeCapture?.(cb); return () => {}; },
        basePath: () => '/vault',
        resourceUrl: (p) => `file:///vault/${p.split('/').map(encodeURIComponent).join('/')}`,
    };
}

describe('Vault against a host-like storage', () => {
    it('readBinary returns the real bytes, not a UTF-8 decode squeezed back to latin1', async () => {
        // The in-memory backend stores latin1 so it never showed this: with the real host,
        // read() decodes UTF-8 and replaces every invalid byte with U+FFFD, so a PDF came
        // back corrupt and the wrong length.
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x80, 0xfe, 0xff, 0xc0, 0xaf]);
        const vault = new Vault(hostLikeStorage({ 'doc.pdf': bytes }));
        await vault.open();
        const file = vault.getAbstractFileByPath('doc.pdf') as TFile;
        expect([...new Uint8Array(await vault.readBinary(file))]).toEqual([...bytes]);
    });

    it('applies a watcher rename: old path gone, new path present, rename event fired', async () => {
        let push: ((e: WatchEvent[]) => void) | null = null;
        const vault = new Vault(hostLikeStorage({ 'A.md': new TextEncoder().encode('a') }, (cb) => { push = cb; }));
        await vault.open();
        const renamed = vi.fn();
        vault.on('rename', renamed);
        push!([{ kind: 'rename', path: 'B.md', oldPath: 'A.md', stat: { path: 'B.md', type: 'file', ctime: 1, mtime: 2, size: 1 } }]);
        // The old path used to stay indexed forever, so a moved note existed twice.
        expect(vault.getAbstractFileByPath('A.md')).toBeNull();
        expect(vault.getAbstractFileByPath('B.md')).toBeInstanceOf(TFile);
        expect(renamed).toHaveBeenCalledTimes(1);
        expect(renamed.mock.calls[0][1]).toBe('A.md');
    });

    it('MemoryStorage.readBinary is the exact inverse of writeBinary', async () => {
        const s = new MemoryStorage();
        const bytes = new Uint8Array([0, 1, 0x7f, 0x80, 0xfe, 0xff]);
        await s.writeBinary('x.bin', bytes);
        expect([...await s.readBinary('x.bin')]).toEqual([...bytes]);
    });

    /**
     * getResourcePath used to return `osint-vault://...`, a scheme nothing in the app ever
     * registered, so every graph thumbnail silently failed to load. These pin the three
     * properties the graph actually depends on.
     */
    describe('getResourcePath', () => {
        const resourcePathOf = async (path: string, bytes = new Uint8Array([1])) => {
            const vault = new Vault(hostLikeStorage({ [path]: bytes }));
            await vault.open();
            return vault.getResourcePath(vault.getAbstractFileByPath(path) as TFile);
        };

        it('returns a scheme the renderer can actually load', async () => {
            const url = await resourcePathOf('Evidence/photo.png');
            // Not osint-vault://, which no protocol handler serves.
            expect(url.startsWith('file:///vault/Evidence/photo.png?v=')).toBe(true);
        });

        it('contains no whitespace, however the path is spelt', async () => {
            // Load-bearing for the graph: cytoscape's `background-image` is a multi-valued
            // `urls` property and splits a mapped value on /\s+/, so one URL containing a
            // space becomes two URLs and neither of them loads.
            const url = await resourcePathOf('Evidence/A. Ivanov portrait.png');
            expect(url).not.toMatch(/\s/);
            expect(url).toContain('A.%20Ivanov%20portrait.png');
        });

        it('encodes the characters entity labels routinely contain', async () => {
            const url = await resourcePathOf('Evidence/q? a& b#c.png');
            // Unescaped, '#' truncates the URL at the fragment and '?' starts the query
            // early -- both would silently address a different file, or none.
            expect(url).toContain('q%3F%20a%26%20b%23c.png');
            // Exactly one '?', the cache-buster's.
            expect(url.split('?')).toHaveLength(2);
        });

        it('keeps the separators as separators', async () => {
            const url = await resourcePathOf('Evidence/sub/photo.png');
            expect(url).toContain('/vault/Evidence/sub/photo.png');
        });

        it('busts the cache with the mtime, so a replaced image is not served stale', async () => {
            const vault = new Vault(hostLikeStorage({ 'a.png': new Uint8Array([1]) }));
            await vault.open();
            const file = vault.getAbstractFileByPath('a.png') as TFile;
            const before = vault.getResourcePath(file);
            file.stat = { ...file.stat, mtime: file.stat.mtime + 1000 };
            expect(vault.getResourcePath(file)).not.toBe(before);
        });
    });
});

describe('Plugin.loadData', () => {
    class P extends Plugin {}
    it('keeps a corrupt data.json under a backup name instead of letting defaults overwrite it', async () => {
        const app = await createTestAppAsync({ files: { '.osint-copilot/data.json': '{"claudeCodeCliPath": "/opt/claude", "broken' } });
        const plugin = new P(app as never, { id: 'osint-copilot', name: 'x', version: '0' });
        const loaded = await plugin.loadData();
        // Unparseable used to be indistinguishable from missing, and the caller then saved
        // defaults over the only copy of the user's settings.
        expect(loaded).toBeNull();
        const backups = app.vault.getFiles().filter((f) => f.path.startsWith('.osint-copilot/data.json.corrupt-'));
        expect(backups).toHaveLength(1);
        expect(await app.vault.adapter.read(backups[0].path)).toContain('/opt/claude');
    });

    it('still treats a missing file as first run', async () => {
        const app = await createTestAppAsync();
        const plugin = new P(app as never, { id: 'osint-copilot', name: 'x', version: '0' });
        expect(await plugin.loadData()).toBeNull();
        expect(app.vault.getFiles().some((f) => f.path.includes('corrupt'))).toBe(false);
    });
});
