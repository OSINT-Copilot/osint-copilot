import { describe, it, expect, beforeEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { EntityManager } from '../services/entity-manager';
import { createTestApp, type TestApp } from '../obsidian-shim/testing/create-test-app';
import { getContent } from './helpers/vault-inspect';

/**
 * Property keys arrive from page text and AI extraction as well as from the investigator.
 * A key must not be able to replace a front-matter key the writer emits itself (a property
 * named `id` would re-point the note), and a key that is not plain YAML must still write a
 * note that parses and reads back the same.
 */

function frontmatterOf(content: string | undefined): Record<string, unknown> {
    const match = content?.match(/^---\n([\s\S]*?)\n---/);
    expect(match).toBeTruthy();
    return parseYaml(match![1]) as Record<string, unknown>;
}

// Keys the writers emit themselves, each with a value that would re-point or relabel the note.
const WRITER_KEYS: Record<string, string> = {
    id: 'evil-id',
    type: 'Person',
    label: 'Evil label',
    aliases: 'Evil alias',
    schemaFamily: 'stix2',
    ftmSchema: 'Person',
    osint_confidence: 'high',
    osint_sources: 'forged',
    osint_contradictions: 'forged',
    props: 'forged',
    created: 'forged',
    modified: 'forged',
};

const HOSTILE_KEYS: Record<string, string> = {
    'a: b': 'colon',
    'x\nid: evil': 'newline',
    '#comment': 'hash',
    '"quoted': 'quote',
    "'single": 'single quote',
    '-lead': 'dash',
    '? question': 'question',
    '[a]': 'bracket',
    '{a}': 'brace',
    ' lead space': 'space',
    'tab\there': 'tab',
    '&anchor': 'anchor',
    '*alias': 'alias',
    '!tag': 'tag',
    '|block': 'pipe',
    '%directive': 'percent',
    '@at': 'at',
    '`tick': 'backtick',
    '<<': 'merge',
    'true': 'bool-looking',
    '123': 'number-looking',
    '---': 'separator',
};

describe('front-matter property keys', () => {
    let app: TestApp;
    let manager: EntityManager;

    beforeEach(async () => {
        app = createTestApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
    });

    async function reloaded(): Promise<EntityManager> {
        const again = new EntityManager(app as never, 'OSINTCopilot', null);
        await again.loadEntitiesFromNotes();
        return again;
    }

    it('an FTM property named like a writer key cannot replace it, and still round-trips', async () => {
        const entity = await manager.createFTMEntity('Company', { name: 'Real Co', ...WRITER_KEYS }, { skipAutoGeocode: true });

        const fm = frontmatterOf(getContent(app, entity.filePath!));
        expect(fm.id).toBe(entity.id);
        expect(fm.type).toBe('Company');
        expect(fm.label).toBe('Real Co');
        expect(fm.ftmSchema).toBe('Company');
        expect(fm.schemaFamily).toBe('ftm');
        expect(fm.osint_confidence).toBeUndefined();

        const back = (await reloaded()).getEntity(entity.id)!;
        expect(back.label).toBe('Real Co');
        expect(back.ftmSchema).toBe('Company');
        expect(back.osint_sources).toBeUndefined();
        for (const [key, value] of Object.entries(WRITER_KEYS)) {
            expect(back.properties[key], key).toBe(value);
        }
    });

    it('hostile keys are written as quoted YAML keys and read back unchanged', async () => {
        const entity = await manager.createFTMEntity('Company', { name: 'Keys Co', ...HOSTILE_KEYS }, { skipAutoGeocode: true });

        const fm = frontmatterOf(getContent(app, entity.filePath!));
        expect(fm.id).toBe(entity.id);
        expect(fm.label).toBe('Keys Co');
        for (const [key, value] of Object.entries(HOSTILE_KEYS)) {
            expect(fm[key], JSON.stringify(key)).toBe(value);
        }

        const back = (await reloaded()).getEntity(entity.id)!;
        expect(back.label).toBe('Keys Co');
        for (const [key, value] of Object.entries(HOSTILE_KEYS)) {
            expect(back.properties[key], JSON.stringify(key)).toBe(value);
        }
    });

    it('a __proto__ property is neither written nor able to change the properties prototype', async () => {
        const props = JSON.parse('{"name": "Proto Co", "__proto__": {"polluted": true}}') as Record<string, unknown>;
        const entity = await manager.createFTMEntity('Company', props, { skipAutoGeocode: true });
        expect(getContent(app, entity.filePath!)!.match(/^---\n[\s\S]*?\n---/)![0]).not.toContain('__proto__');

        // A hand-edited note carrying the key is read without it.
        const file = app.vault.getAbstractFileByPath(entity.filePath!)!;
        const content = getContent(app, entity.filePath!)!;
        await app.vault.modify(file as never, content.replace('\n---\n', '\n__proto__:\n  polluted: true\n---\n'));

        const back = (await reloaded()).getEntity(entity.id)!;
        expect(Object.getPrototypeOf(back.properties)).toBe(Object.prototype);
        expect((back.properties as { polluted?: unknown }).polluted).toBeUndefined();
    });

    it('the undo/restore writer keeps its own keys too', async () => {
        const ok = await manager.restoreEntity({
            id: 'restored-1',
            type: 'Person' as never,
            label: 'Restored',
            properties: { ...WRITER_KEYS, ...HOSTILE_KEYS, nickname: 'Rex' },
            filePath: 'OSINTCopilot/restored.md',
        });
        expect(ok).toBe(true);

        const fm = frontmatterOf(getContent(app, 'OSINTCopilot/restored.md'));
        expect(fm.id).toBe('restored-1');
        expect(fm.type).toBe('Person');
        expect(fm.label).toBe('Restored');
        expect(fm.modified).not.toBe('forged');
        expect((fm.props as Record<string, unknown>).id).toBe('evil-id');
        expect((fm.props as Record<string, unknown>).modified).toBe('forged');
        for (const [key, value] of Object.entries(HOSTILE_KEYS)) {
            expect(fm[key], JSON.stringify(key)).toBe(value);
        }
    });

    it('a connection property named like a writer key cannot re-point the connection', async () => {
        const from = await manager.createFTMEntity('Person', { name: 'Ann' }, { skipAutoGeocode: true });
        const to = await manager.createFTMEntity('Company', { name: 'Acme' }, { skipAutoGeocode: true });
        const other = await manager.createFTMEntity('Company', { name: 'Other' }, { skipAutoGeocode: true });
        const forged = {
            id: 'evil-id',
            type: 'Person',
            relationship: 'OWNS',
            fromEntityId: other.id,
            toEntityId: other.id,
            fromEntity: '[[Other]]',
            label: 'Evil',
            role: 'clerk',
            'a: b': 'colon',
        };
        const conn = (await manager.createConnection(from.id, to.id, 'Employment', forged))!;

        const fm = frontmatterOf(getContent(app, conn.filePath!));
        expect(fm.id).toBe(conn.id);
        expect(fm.type).toBe('connection');
        expect(fm.fromEntityId).toBe(from.id);
        expect(fm.toEntityId).toBe(to.id);
        expect(fm.role).toBe('clerk');
        expect(fm['a: b']).toBe('colon');

        const back = (await reloaded()).getConnection(conn.id)!;
        expect(back.fromEntityId).toBe(from.id);
        expect(back.toEntityId).toBe(to.id);
        expect(back.relationship).toBe(conn.relationship);
        for (const [key, value] of Object.entries(forged)) {
            expect(back.properties?.[key], key).toBe(value);
        }
    });
});

describe('the line-by-line fallback reader', () => {
    // A repeated key makes the YAML parser reject the block, so these notes are read by the
    // fallback -- as hand-edited or older notes can be.
    async function loadNote(lines: string[]) {
        const app = createTestApp();
        const manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
        await app.vault.create('OSINTCopilot/ftm/Company/Fallback.md', ['---', ...lines, 'dup: 1', 'dup: 2', '---', ''].join('\n'));
        await manager.loadEntitiesFromNotes();
        return manager.getEntity('fb-1');
    }

    it('decodes the JSON escapes the writer uses in double-quoted values', async () => {
        const label = 'Tab\there "quoted" back\\slash é \u2028 end';
        const entity = await loadNote([
            'id: "fb-1"',
            'type: Company',
            'schemaFamily: ftm',
            'ftmSchema: Company',
            `label: ${JSON.stringify(label).replace('\u2028', '\\u2028')}`,
            `name: ${JSON.stringify(label).replace('\u2028', '\\u2028')}`,
            'quotedNumber: "42"',
            'plainNumber: 42',
            "single: 'it''s'",
            `${JSON.stringify('a: b')}: "colon key"`,
        ]);

        expect(entity?.label).toBe(label);
        expect(entity?.properties.name).toBe(label);
        expect(entity?.properties.quotedNumber).toBe('42');
        expect(entity?.properties.plainNumber).toBe(42);
        expect(entity?.properties.single).toBe("it's");
        expect(entity?.properties['a: b']).toBe('colon key');
    });

    it('keeps a double-quoted value that is not valid JSON, minus its quotes', async () => {
        const entity = await loadNote([
            'id: "fb-1"',
            'type: Company',
            'ftmSchema: Company',
            'label: "C:\\path\\x"',
        ]);
        expect(entity?.label).toBe('C:\\path\\x');
    });

    it('reads props: entries as properties, and neither they nor a repeated key replace the id', async () => {
        const entity = await loadNote([
            'id: "fb-1"',
            'type: Company',
            'ftmSchema: Company',
            'label: "Acme"',
            'props:',
            '  id: "evil"',
            '  type: Person',
            '  country: "ru"',
            'id: "evil-2"',
            'name: "Acme"',
        ]);
        expect(entity?.id).toBe('fb-1');
        expect(entity?.type).toBe('Company');
        expect(entity?.properties.id).toBe('evil');
        expect(entity?.properties.type).toBe('Person');
        expect(entity?.properties.country).toBe('ru');
        expect(entity?.properties.name).toBe('Acme');
    });
});
