import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GUIDE_SECTIONS, WELCOME_SECTION_IDS, guideSection } from '../data/guide-content';
import { OSINT_VIEWS } from '../integration/osint-view-types';
import { hasLucideIcon } from '../integration/lucide-svg';

/**
 * The guide is content, so most of it cannot be tested. What can be is that it hangs
 * together: that the tour points at sections that exist, that the icons render, and that
 * the shortcut table it prints still matches the shortcuts the app actually binds -- the
 * one part of the text that goes stale silently when a view is added.
 */
describe('the in-app guide', () => {
    it('gives every section a unique id', () => {
        const ids = GUIDE_SECTIONS.map(s => s.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('names an icon lucide actually ships, for every section', () => {
        for (const section of GUIDE_SECTIONS) {
            expect(hasLucideIcon(section.icon), `${section.title}: ${section.icon}`).toBe(true);
        }
    });

    it('gives every section a title and a body', () => {
        for (const section of GUIDE_SECTIONS) {
            expect(section.title.trim(), section.id).not.toBe('');
            expect(section.body.trim().length, section.id).toBeGreaterThan(50);
        }
    });

    it('shows a first-run tour whose sections all exist', () => {
        // A typo'd id here silently shortens the tour rather than failing.
        for (const id of WELCOME_SECTION_IDS) {
            expect(guideSection(id), `welcome section "${id}"`).toBeDefined();
        }
        expect(WELCOME_SECTION_IDS.length).toBeLessThanOrEqual(GUIDE_SECTIONS.length);
    });

    it('has no section for an id that does not exist', () => {
        expect(guideSection('not-a-section')).toBeUndefined();
    });

    it('documents the shortcut of every view in the toolbar', () => {
        // The guide prints a table of Ctrl+Alt+N. Adding a view without updating it leaves
        // the documentation quietly wrong, which is worse than having none.
        const views = guideSection('the-views');
        expect(views).toBeDefined();
        for (const view of OSINT_VIEWS) {
            const digit = view.shortcut.replace('Mod+Alt+', '');
            expect(views!.body, `${view.label} (Ctrl+Alt+${digit})`)
                .toContain(`\`Ctrl+Alt+${digit}\``);
            expect(views!.body, view.label).toContain(view.label);
        }
    });

    it('documents the canvas button on the shortcut the command binds', () => {
        // Boards are not an OSINT_VIEWS entry, so the loop above cannot cover them; the
        // shortcut is read out of the command instead of being retyped here.
        const source = readFileSync(
            resolve(__dirname, '../../app/model/commands/OsintViewCommands.ts'), 'utf8');
        const match = source.match(/class OpenOsintCanvasCommand[\s\S]*?shortcut: '(Mod\+Alt\+\d)'/);
        expect(match, 'OpenOsintCanvasCommand should declare a Mod+Alt+N shortcut').not.toBeNull();

        const digit = match![1].replace('Mod+Alt+', '');
        expect(guideSection('the-views')!.body).toContain(`\`Ctrl+Alt+${digit}\``);
    });

    it('does not give the canvas button a shortcut a view already uses', () => {
        const source = readFileSync(
            resolve(__dirname, '../../app/model/commands/OsintViewCommands.ts'), 'utf8');
        const shortcut = source.match(/class OpenOsintCanvasCommand[\s\S]*?shortcut: '(Mod\+Alt\+\d)'/)![1];
        expect(OSINT_VIEWS.map(v => v.shortcut)).not.toContain(shortcut);
    });

    it('does not take a shortcut Tangent already binds', () => {
        const registry = readFileSync(
            resolve(__dirname, '../../app/model/commands/index.ts'), 'utf8');
        const source = readFileSync(
            resolve(__dirname, '../../app/model/commands/OsintViewCommands.ts'), 'utf8');
        const shortcut = source.match(/class OpenOsintCanvasCommand[\s\S]*?shortcut: '(Mod\+Alt\+\d)'/)![1];
        expect(registry).not.toContain(`'${shortcut}'`);
    });
});
