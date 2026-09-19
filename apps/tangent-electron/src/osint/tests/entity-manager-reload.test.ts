import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TFile } from 'obsidian';
import { EntityManager } from '../services/entity-manager';
import { createTestApp, type TestApp } from '../obsidian-shim/testing/create-test-app';
import { getContent, snapshotPaths } from './helpers/vault-inspect';

/**
 * loadEntitiesFromNotes() while the rest of the app keeps working. The graph, timeline
 * and map reload the store on every note change, so a reload is often running when the
 * analyst acts, and it used to empty the store first.
 */

/**
 * Holds the loader's read of one note: the note is read at once, as it is then, and
 * handed over only on release(). Later reads of it are not held.
 */
function holdRead(app: TestApp, path: string) {
    const read = app.vault.read.bind(app.vault);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    let held = false;
    vi.spyOn(app.vault, 'read').mockImplementation(async (file: TFile) => {
        if (held || file.path !== path) return read(file);
        held = true;
        const content = await read(file);
        reached();
        await gate;
        return content;
    });
    return { started, release };
}

/** An edit made outside EntityManager, as the editor or git would make it. */
async function editNote(app: TestApp, path: string, edit: (text: string) => string): Promise<void> {
    const file = app.vault.getAbstractFileByPath(path) as TFile;
    await app.vault.modify(file, edit(getContent(app, path)!));
}

describe('EntityManager.loadEntitiesFromNotes while the app keeps working', () => {
    let app: TestApp;
    let manager: EntityManager;

    beforeEach(async () => {
        app = createTestApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
    });

    afterEach(() => vi.restoreAllMocks());

    const company = (name: string) => manager.createFTMEntity('Company', { name, country: 'ru' }, { skipAutoGeocode: true });

    it('keeps every entity readable, and writable, while the notes are read', async () => {
        const acme = await company('Acme');
        const hold = holdRead(app, acme.filePath!);

        const load = manager.loadEntitiesFromNotes();
        await hold.started;
        expect(manager.getEntity(acme.id)?.label).toBe('Acme');
        // The graph's timeline toggle and its geolocate go through updateEntity, which
        // answered null for an entity the half-read store did not have yet.
        expect(await manager.updateEntity(acme.id, { country: 'fr' })).not.toBeNull();
        hold.release();
        await load;

        expect(manager.getEntity(acme.id)?.properties.country).toBe('fr');
    });

    it('keeps an edit made after the load read the note', async () => {
        const acme = await company('Acme');
        const beta = await company('Beta');
        // Acme is read first; the load then waits on Beta.
        const hold = holdRead(app, beta.filePath!);

        const load = manager.loadEntitiesFromNotes();
        await hold.started;
        await manager.updateEntity(acme.id, { name: 'Acme Two' });
        hold.release();
        await load;

        expect(manager.getEntity(acme.id)?.label).toBe('Acme Two');
    });

    it('keeps a delete made after the load read the note', async () => {
        const acme = await company('Acme');
        const beta = await company('Beta');
        const hold = holdRead(app, beta.filePath!);

        const load = manager.loadEntitiesFromNotes();
        await hold.started;
        expect(await manager.deleteEntity(acme.id)).toBe(true);
        hold.release();
        await load;

        expect(manager.getEntity(acme.id)).toBeUndefined();
        expect(manager.getEntity(beta.id)).toBeDefined();
    });

    it('when two loads overlap, keeps what the one begun last read', async () => {
        const acme = await company('Acme');
        const hold = holdRead(app, acme.filePath!);

        const older = manager.loadEntitiesFromNotes();
        await hold.started;
        await editNote(app, acme.filePath!, (text) => text.replace('country: "ru"', 'country: "fr"'));
        // Begun later, done first.
        await manager.loadEntitiesFromNotes();
        hold.release();
        await older;

        expect(manager.getEntity(acme.id)?.properties.country).toBe('fr');
    });
});

describe('EntityManager graph-yaml mirror on a routine reload', () => {
    let app: TestApp;
    let manager: EntityManager;

    beforeEach(async () => {
        app = createTestApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
    });

    afterEach(() => vi.restoreAllMocks());

    const yamlPath = (id: string) => snapshotPaths(app).find((p) => p.includes('/graph-yaml/') && p.endsWith(`/${id}.yaml`));

    async function vault() {
        const acme = await manager.createFTMEntity('Company', { name: 'Acme', country: 'ru' }, { skipAutoGeocode: true });
        const bob = await manager.createFTMEntity('Person', { name: 'Bob' }, { skipAutoGeocode: true });
        const carl = await manager.createFTMEntity('Person', { name: 'Carl' }, { skipAutoGeocode: true });
        const link = await manager.createConnection(bob.id, acme.id, 'Employment');
        // Memory as the notes read back, which is what a later reload compares with.
        await manager.loadEntitiesFromNotes();

        // Changed on disk behind the manager's back: one note edited, one deleted.
        await editNote(app, acme.filePath!, (text) => text.replace('country: "ru"', 'country: "fr"'));
        await app.fileManager.trashFile(app.vault.getAbstractFileByPath(carl.filePath!)!);

        const written: string[] = [];
        const record = (path: string) => { if (path.includes('/graph-yaml/')) written.push(path); };
        const modify = app.vault.modify.bind(app.vault);
        const create = app.vault.create.bind(app.vault);
        vi.spyOn(app.vault, 'modify').mockImplementation(async (file: TFile, data: string) => {
            record(file.path);
            return modify(file, data);
        });
        vi.spyOn(app.vault, 'create').mockImplementation(async (path: string, data: string) => {
            record(path);
            return create(path, data);
        });
        return { acme, bob, carl, link: link!, written, carlYaml: yamlPath(carl.id)! };
    }

    it('writes only the entries whose notes changed, and removes the deleted ones', async () => {
        const { acme, carl, written, carlYaml } = await vault();

        await manager.loadEntitiesFromNotes({ graphYaml: 'changed' });

        expect(written).toEqual([yamlPath(acme.id)]);
        expect(getContent(app, yamlPath(acme.id)!)).toContain('country: fr');
        expect(manager.getEntity(carl.id)).toBeUndefined();
        expect(getContent(app, carlYaml)).toBeUndefined();
    });

    it('rewrites every entry on a full reload', async () => {
        const { acme, bob, link, written } = await vault();

        await manager.loadEntitiesFromNotes();

        expect(written).toEqual(expect.arrayContaining([yamlPath(acme.id), yamlPath(bob.id), yamlPath(link.id)]));
    });
});
