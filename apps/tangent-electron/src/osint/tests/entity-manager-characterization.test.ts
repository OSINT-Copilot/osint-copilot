import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EntityManager } from '../services/entity-manager';
import { createTestApp, type TestApp } from '../obsidian-shim/testing/create-test-app';
import { getContent, snapshotPaths } from './helpers/vault-inspect';
import { parse as parseYaml } from 'yaml';
import { sanitizeFilename } from '../entities/types';
import { WaybackArchiveService } from '../services/wayback-archive-service';
import { finalizeOsintSources } from '../services/osint-confidence-engine';

/**
 * CHARACTERIZATION TESTS -- Phase 0 safety net.
 *
 * These pin the CURRENT on-disk behaviour of EntityManager before the port moves
 * anything. They are not a specification of what is correct; several of the
 * behaviours locked here are known bugs (see the port plan). The point is that any
 * change to the bytes written must be a deliberate, reviewed edit to this file.
 *
 * Determinism: generateId() uses crypto.randomUUID(), so ids are stubbed with a
 * counter rather than seeding Math.random. Stubbing the source of randomness keeps
 * the golden snapshots byte-stable without touching production code.
 */

function seedRandom(): () => void {
    let counter = 0;
    const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
        counter++;
        const hex = counter.toString(16).padStart(12, '0');
        return `00000000-0000-4000-8000-${hex}` as `${string}-${string}-${string}-${string}-${string}`;
    });
    return () => spy.mockRestore();
}

describe('EntityManager characterization (current behaviour, pre-port)', () => {
    let app: TestApp;
    let manager: EntityManager;
    let restoreRandom: () => void;

    beforeEach(async () => {
        restoreRandom = seedRandom();
        app = createTestApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
    });

    afterEach(() => restoreRandom());

    it('initialize() creates the vault folder skeleton', () => {
        expect(snapshotPaths(app)).toMatchSnapshot();
    });

    it('createFTMEntity writes a note and returns a populated entity', async () => {
        const entity = await manager.createFTMEntity(
            'Company',
            { name: 'Lukoil', country: 'ru' },
            { skipAutoGeocode: true },
        );

        expect(entity.label).toBe('Lukoil');
        expect(entity.filePath).toBeTruthy();
        expect(getContent(app, entity.filePath!)).toMatchSnapshot('lukoil-note');
    });

    it('mirrors every entity into graph-yaml', async () => {
        await manager.createFTMEntity('Company', { name: 'Lukoil' }, { skipAutoGeocode: true });
        const yamlPaths = snapshotPaths(app).filter((p) => p.includes('graph-yaml'));
        expect(yamlPaths.length).toBeGreaterThan(0);
        expect(getContent(app, yamlPaths.find((p) => p.endsWith('.yaml'))!)).toMatchSnapshot('lukoil-yaml');
    });

    it('createConnection writes a connection note and appends to both endpoints', async () => {
        const from = await manager.createFTMEntity('Company', { name: 'Lukoil' }, { skipAutoGeocode: true });
        const to = await manager.createFTMEntity('Person', { name: 'Vagit Alekperov' }, { skipAutoGeocode: true });

        const conn = await manager.createConnection(from.id, to.id, 'DIRECTOR_OF');
        expect(conn).not.toBeNull();

        expect(getContent(app, conn!.filePath!)).toMatchSnapshot('connection-note');
        expect(getContent(app, from.filePath!)).toContain('DIRECTOR_OF');
        expect(getContent(app, to.filePath!)).toContain('DIRECTOR_OF');
    });

    it('updateEntity rewrites the same note rather than creating a second one', async () => {
        const entity = await manager.createFTMEntity('Company', { name: 'Lukoil' }, { skipAutoGeocode: true });
        const before = snapshotPaths(app).length;

        await manager.updateEntity(entity.id, { name: 'Lukoil', country: 'ru' });

        expect(snapshotPaths(app).length).toBe(before);
        expect(getContent(app, entity.filePath!)).toContain('ru');
    });

    it('deleteEntity removes the note and its graph-yaml mirror', async () => {
        const entity = await manager.createFTMEntity('Company', { name: 'Lukoil' }, { skipAutoGeocode: true });
        expect(app.vault.getAbstractFileByPath(entity.filePath!)).not.toBeNull();

        await manager.deleteEntity(entity.id);

        expect(app.vault.getAbstractFileByPath(entity.filePath!)).toBeNull();
        expect(snapshotPaths(app).filter((p) => p.endsWith('.yaml'))).toEqual([]);
    });

    it('round-trips a full vault through loadEntitiesFromNotes', async () => {
        const from = await manager.createFTMEntity('Company', { name: 'Lukoil' }, { skipAutoGeocode: true });
        const to = await manager.createFTMEntity('Person', { name: 'Vagit Alekperov' }, { skipAutoGeocode: true });
        await manager.createConnection(from.id, to.id, 'DIRECTOR_OF');

        const pathsBefore = snapshotPaths(app);

        const reloaded = new EntityManager(app as never, 'OSINTCopilot', null);
        await reloaded.loadEntitiesFromNotes();

        expect(reloaded.getAllEntities().map((e) => e.label).sort())
            .toEqual(['Lukoil', 'Vagit Alekperov']);
        // Reloading must not mutate the vault.
        expect(snapshotPaths(app)).toEqual(pathsBefore);
    });
});

/**
 * Front matter built from untrusted text. A browser extension feeds page titles,
 * selections and URLs into labels and property values, so every hand-built
 * `key: "value"` line must survive quotes, backslashes and line breaks: parsing the
 * note back has to yield exactly the original string and no keys it did not write.
 */
describe('EntityManager front matter escapes untrusted text', () => {
    let app: TestApp;
    let manager: EntityManager;
    let restoreRandom: () => void;

    const HOSTILE: Array<[string, string]> = [
        ['a quote and newline injecting a key', 'a"\nosint_confidence: high'],
        ['a trailing backslash', 'ends with a backslash\\'],
        ['a document separator ending the front matter', 'a\n---\nbody'],
        ['a U+2028 line separator', 'a\u2028b'],
    ];

    // Same extraction parseFrontmatter() uses, so this reads the note the way the app does.
    function frontmatterOf(content: string | undefined): Record<string, unknown> {
        const match = content?.match(/^---\n([\s\S]*?)\n---/);
        expect(match).toBeTruthy();
        return parseYaml(match![1]) as Record<string, unknown>;
    }

    function headingOf(content: string | undefined): string {
        return content!.split('\n').find((l) => l.startsWith('# '))!;
    }

    const singleLine = (value: string) => value.replace(/[\n\u2028]/g, ' ');

    beforeEach(async () => {
        restoreRandom = seedRandom();
        app = createTestApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
    });

    afterEach(() => restoreRandom());

    it.each(HOSTILE)('FTM front matter round-trips %s', async (_name, value) => {
        const plain = await manager.createFTMEntity('Company', { name: 'Plain label' }, { skipAutoGeocode: true });
        const entity = await manager.createFTMEntity('Company', { name: value }, { skipAutoGeocode: true });
        expect(entity.label).toBe(value);

        const content = getContent(app, entity.filePath!);
        const fm = frontmatterOf(content);
        expect(fm.label).toBe(value);
        expect(fm.name).toBe(value);
        expect(Object.keys(fm).sort()).toEqual(Object.keys(frontmatterOf(getContent(app, plain.filePath!))).sort());
        expect(headingOf(content)).toBe(`# ${singleLine(value)}`);

        const reloaded = new EntityManager(app as never, 'OSINTCopilot', null);
        await reloaded.loadEntitiesFromNotes();
        expect(reloaded.getEntity(entity.id)?.label).toBe(value);
    });

    it.each(HOSTILE)('legacy front matter (label and aliases) round-trips %s', (_name, value) => {
        const build = (label: string) => frontmatterOf(`---\n${(manager as any).buildFrontmatter({
            id: 'e1',
            type: 'custom_thing',
            label,
            properties: { note: label },
        })}\n---\n`);

        const fm = build(value);
        expect(fm.label).toBe(value);
        expect(fm.aliases).toEqual([value]);
        expect(fm.note).toBe(value);
        expect(Object.keys(fm).sort()).toEqual(Object.keys(build('Plain label')).sort());
    });

    it.each(HOSTILE)('generateNoteContent (restoreEntity) round-trips %s', async (_name, value) => {
        const restore = async (label: string, filePath: string) => {
            const ok = await manager.restoreEntity({
                id: `id-${label.length}`,
                type: 'Person' as never,
                label,
                properties: { nickname: label, count: 3 },
                filePath,
            });
            expect(ok).toBe(true);
            return getContent(app, filePath);
        };

        const plain = frontmatterOf(await restore('Plain label', 'OSINTCopilot/plain.md'));
        const content = await restore(value, 'OSINTCopilot/hostile.md');
        const fm = frontmatterOf(content);
        expect(fm.label).toBe(value);
        expect(fm.nickname).toBe(value);
        expect(fm.count).toBe(3);
        expect(Object.keys(fm).sort()).toEqual(Object.keys(plain).sort());
        expect(headingOf(content)).toBe(`# ${singleLine(value)}`);
    });

    it.each(HOSTILE)('connection front matter round-trips %s', async (_name, value) => {
        const to = await manager.createFTMEntity('Person', { name: 'Bob' }, { skipAutoGeocode: true });
        const plainFrom = await manager.createFTMEntity('Company', { name: 'Plain label' }, { skipAutoGeocode: true });
        const from = await manager.createFTMEntity('Company', { name: value }, { skipAutoGeocode: true });

        const plain = await manager.createConnection(plainFrom.id, to.id, 'DIRECTOR_OF', { role: 'Plain label' });
        const conn = await manager.createConnection(from.id, to.id, 'DIRECTOR_OF', { role: value });
        expect(conn).not.toBeNull();

        const content = getContent(app, conn!.filePath!);
        const fm = frontmatterOf(content);
        expect(fm.label).toBe(`${value} → DIRECTOR_OF → Bob`);
        expect(fm.fromEntity).toBe(`[[${value}]]`);
        expect(fm.role).toBe(value);
        expect(Object.keys(fm).sort()).toEqual(Object.keys(frontmatterOf(getContent(app, plain!.filePath!))).sort());
        expect(headingOf(content)).toBe(`# ${singleLine(value)} → DIRECTOR_OF → Bob`);

        const reloaded = new EntityManager(app as never, 'OSINTCopilot', null);
        await reloaded.loadEntitiesFromNotes();
        expect(reloaded.getConnection(conn!.id)?.label).toBe(fm.label);
    });

    it("migrateReservedPropertyFrontmatter keeps a label containing $' literal", async () => {
        const label = "Acme $' $` $& Ltd";
        const entity = await manager.createFTMEntity(
            'Company',
            { name: label, notes: 'x"\nosint_confidence: high\n' },
            { skipAutoGeocode: true },
        );
        const before = getContent(app, entity.filePath!)!;
        const body = before.slice(before.match(/^---\n[\s\S]*?\n---/)![0].length);

        const result = await manager.migrateReservedPropertyFrontmatter();
        expect(result.errors).toBe(0);

        const after = getContent(app, entity.filePath!)!;
        const fm = frontmatterOf(after);
        expect(fm.label).toBe(label);
        expect(fm.name).toBe(label);
        expect(fm.osint_confidence).toBeUndefined();
        expect(after.slice(after.match(/^---\n[\s\S]*?\n---/)![0].length)).toBe(body);

        const reloaded = new EntityManager(app as never, 'OSINTCopilot', null);
        await reloaded.loadEntitiesFromNotes();
        const again = reloaded.getEntity(entity.id);
        expect(again?.label).toBe(label);
        expect(again?.properties.osint_confidence).toBeUndefined();
    });

    it('still reads a note written with the old quote-only escaping', async () => {
        await app.vault.create('OSINTCopilot/ftm/Company/Old.md', [
            '---',
            'id: "old-1"',
            'type: Company',
            'schemaFamily: ftm',
            'ftmSchema: Company',
            'label: "Acme \\"Old\\" Ltd"',
            'name: "Acme \\"Old\\" Ltd"',
            '---',
            '',
            '# Acme "Old" Ltd',
            '',
        ].join('\n'));

        await manager.loadEntitiesFromNotes();
        expect(manager.getEntity('old-1')?.label).toBe('Acme "Old" Ltd');
    });
});

describe('EntityManager.isGraphNotePath', () => {
    const manager = new EntityManager({} as never, 'OSINTCopilot', null, () => ['conversations', 'custom', 'Sources']);

    it('matches the notes loadEntitiesFromNotes reads', () => {
        expect(manager.isGraphNotePath('OSINTCopilot/ftm/Person/a.md')).toBe(true);
        expect(manager.isGraphNotePath('OSINTCopilot/Person/a.md')).toBe(true);
        expect(manager.isGraphNotePath('OSINTCopilot/Connections/c.md')).toBe(true);
        expect(manager.isGraphNotePath('OSINTCopilot\\ftm\\Person\\a.md')).toBe(true);
    });

    it('leaves out the folders the loader skips, notes in no type folder, and other files', () => {
        expect(manager.isGraphNotePath('OSINTCopilot/conversations/c.md')).toBe(false);
        expect(manager.isGraphNotePath('OSINTCopilot/custom/skills/s.md')).toBe(false);
        expect(manager.isGraphNotePath('OSINTCopilot/Sources/page.md')).toBe(false);
        expect(manager.isGraphNotePath('OSINTCopilot/schemas/ftm/Person.md')).toBe(false);
        expect(manager.isGraphNotePath('OSINTCopilot/graph-yaml/Person/a.md')).toBe(false);
        expect(manager.isGraphNotePath('OSINTCopilot/readme.md')).toBe(false);
        expect(manager.isGraphNotePath('OSINTCopilot/graph-positions.json')).toBe(false);
        expect(manager.isGraphNotePath('OSINTCopilotOther/Person/a.md')).toBe(false);
        expect(manager.isGraphNotePath('Research/a.md')).toBe(false);
    });
});

describe('sanitizeFilename', () => {
    it('leaves ordinary labels unchanged, so existing notes keep their paths', () => {
        for (const label of [
            'Lukoil',
            'Vagit Alekperov',
            'Acme Inc.',
            "O'Brien & Sons (UK) Ltd",
            'Müller GmbH',
            'Москва',
            '北京市',
            'CONTROL',
            'Console',
            'COM10',
        ]) {
            expect(sanitizeFilename(label)).toBe(label);
        }
    });

    it('strips control characters', () => {
        expect(sanitizeFilename('a\u0000b\u0007c\u007f\u0085d')).toBe('abcd');
        expect(sanitizeFilename('line\nbreak\u2028here')).toBe('line break here');
    });

    it('strips leading dots so a label cannot name a hidden file or a parent directory', () => {
        expect(sanitizeFilename('.hidden')).toBe('hidden');
        expect(sanitizeFilename('../etc/passwd')).toBe('-etc-passwd');
        expect(sanitizeFilename('...')).toBe('_');
        expect(sanitizeFilename('')).toBe('');
    });

    it('prefixes Windows device names, with or without an extension', () => {
        expect(sanitizeFilename('CON')).toBe('_CON');
        expect(sanitizeFilename('nul.txt')).toBe('_nul.txt');
        expect(sanitizeFilename('Com1')).toBe('_Com1');
        expect(sanitizeFilename('LPT9.tar.gz')).toBe('_LPT9.tar.gz');
        expect(sanitizeFilename('aux ')).toBe('_aux');
        expect(sanitizeFilename('PRN .log')).toBe('_PRN .log');
    });
});

/**
 * Sources captured by the browser extension carry provenance (which client sent them,
 * a hash of what it saw, when the app received it) and may be opted out of Wayback
 * lookups. Both have to survive every later save, because each save rewrites the whole
 * front matter from the in-memory entity and re-scans every source for Wayback.
 */
describe('EntityManager osint_sources provenance and Wayback opt-out', () => {
    let app: TestApp;
    let manager: EntityManager;
    let wayback: WaybackArchiveService;
    let lookedUp: string[];
    let restoreRandom: () => void;

    const PROVENANCE = {
        via: 'extension"\nosint_confidence: high',
        client_id: 'client-1',
        sha256: 'a'.repeat(64),
        received_at: '2026-09-18T10:00:00.000Z',
    };

    function frontmatterOf(content: string | undefined): Record<string, unknown> {
        const match = content?.match(/^---\n([\s\S]*?)\n---/);
        expect(match).toBeTruthy();
        return parseYaml(match![1]) as Record<string, unknown>;
    }

    function sourcesOf(filePath: string): Array<Record<string, unknown>> {
        return frontmatterOf(getContent(app, filePath)).osint_sources as Array<Record<string, unknown>>;
    }

    beforeEach(async () => {
        restoreRandom = seedRandom();
        app = createTestApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
        wayback = new WaybackArchiveService(app as never);
        lookedUp = [];
        // No network: record which URLs would have been sent to the Internet Archive.
        vi.spyOn(wayback as any, 'resolveClosestSnapshot').mockImplementation((async (url: string) => {
            lookedUp.push(url);
            return null;
        }) as never);
        manager.setWaybackArchiveService(wayback);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreRandom();
    });

    async function createWithSkippedSource() {
        return manager.createFTMEntity('Company', { name: 'Lukoil' }, {
            skipAutoGeocode: true,
            osint_sources: [
                { source_url: 'https://private.example/page', inferred: false, rationale: 'r', archive_status: 'skipped', ...PROVENANCE },
                { source_url: 'https://public.example/page', inferred: false, rationale: 'r' },
            ],
        });
    }

    it('finalizeOsintSources keeps via, client_id, sha256 and received_at', () => {
        const [out] = finalizeOsintSources(
            [{ source_url: 'https://x.example', inferred: false, rationale: 'r', ...PROVENANCE }],
            { captured_at: '2026-01-01T00:00:00.000Z' },
        );
        expect(out).toMatchObject(PROVENANCE);
    });

    it('finalizeOsintSources drops provenance values that are not strings', () => {
        const [out] = finalizeOsintSources(
            [{ source_url: 'https://x.example', inferred: false, rationale: 'r', sha256: 12 as never }],
            { captured_at: '2026-01-01T00:00:00.000Z' },
        );
        expect(out.sha256).toBeUndefined();
    });

    it('a saved then reloaded entity keeps its source provenance', async () => {
        const entity = await createWithSkippedSource();

        const fm = frontmatterOf(getContent(app, entity.filePath!));
        expect(fm.osint_confidence).not.toBe('high');
        expect(sourcesOf(entity.filePath!)[0]).toMatchObject({ ...PROVENANCE, archive_status: 'skipped' });

        const reloaded = new EntityManager(app as never, 'OSINTCopilot', null);
        await reloaded.loadEntitiesFromNotes();
        expect(reloaded.getEntity(entity.id)?.osint_sources?.[0]).toMatchObject({ ...PROVENANCE, archive_status: 'skipped' });
    });

    it('never looks up a skipped source, on the first save or a later one', async () => {
        const entity = await createWithSkippedSource();
        await vi.waitFor(() => expect(lookedUp).toEqual(['https://public.example/page']));

        await manager.updateEntity(entity.id, { name: 'Lukoil', country: 'ru' });
        await vi.waitFor(() => expect(lookedUp).toHaveLength(2));

        expect(lookedUp).toEqual(['https://public.example/page', 'https://public.example/page']);
        await vi.waitFor(() => expect(sourcesOf(entity.filePath!)[1].archive_status).toBe('failed'));
        expect(sourcesOf(entity.filePath!)[0]).toMatchObject({ ...PROVENANCE, archive_status: 'skipped' });
    });

    it('a lookup finishing after the opt-out does not overwrite it', async () => {
        const entity = await createWithSkippedSource();
        const skippedId = sourcesOf(entity.filePath!)[0].id as string;

        // As if the job had been queued before the source was marked skipped.
        await (wayback as any).patchFrontmatter(entity.filePath!, skippedId, 'https://web.archive.org/web/1/x', 'resolved');

        const [skipped] = sourcesOf(entity.filePath!);
        expect(skipped.archive_status).toBe('skipped');
        expect(skipped.archive_url).toBeUndefined();
    });
});
