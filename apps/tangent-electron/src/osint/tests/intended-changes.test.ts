import { describe, it, expect } from 'vitest';
import { EntityManager } from '../services/entity-manager';
import { createTestApp, appReady } from '../obsidian-shim/testing/create-test-app';
import { generateId, sanitizeFilename } from '../entities/types';
import { ftmSchemaService } from '../services/ftm-schema-service';

/**
 * Behaviour the port changed on purpose, pinned so that it does not quietly change back.
 */

const note = (id: string, type: string, label: string, rels = '') => `---
id: "${id}"
type: ${type}
schemaFamily: ftm
ftmSchema: ${type}
label: "${label}"
name: "${label}"
---

# ${label}

## Relationships
${rels}

## Notes
`;

async function vaultWithHandWrittenLink() {
    const app = createTestApp({
        files: {
            // A plain (unpiped) wikilink, exactly as the note template invites:
            //   "Add relationships using wikilinks: [[Entity Name]] RELATIONSHIP_TYPE [[Target]]"
            'OSINTCopilot/ftm/Company/Lukoil.md': note('id-a', 'Company', 'Lukoil',
                '- [[Lukoil]] DIRECTOR_OF [[Vagit Alekperov]]'),
            'OSINTCopilot/ftm/Person/Vagit Alekperov.md': note('id-b', 'Person', 'Vagit Alekperov'),
        },
    });
    await appReady(app);
    return app;
}

describe('Change 1 - wikilinks are rendered, never parsed back into Connections', () => {
    /**
     * Note the real defect is narrower than "duplicates on every load": the
     * auto-written links are piped ([[path|Label]]), so findEntityByLabel fails on
     * them and they are silently ignored. It is HAND-WRITTEN plain links that
     * produce phantom connections -- with an unstable id and no disk backing.
     */
    it('connection identity comes only from Connections/ notes, stable across loads', async () => {
        const app = await vaultWithHandWrittenLink();

        const loads: string[][] = [];
        for (let i = 0; i < 2; i++) {
            const m = new EntityManager(app as never, 'OSINTCopilot', null);
            await m.loadEntitiesFromNotes();
            loads.push(m.getAllConnections().map((c) => c.id));
        }

        // Wikilinks are rendered and navigable, never parsed back into the model.
        expect(loads[0]).toEqual([]);
        expect(loads[1]).toEqual(loads[0]);
    });
});

describe('Change 3 - sanitizeFilename does not collide on long labels', () => {
    const prefix = 'Lukoil '.repeat(20); // 140 chars: two labels share their first 100
    const a = prefix + 'Netherlands BV';
    const b = prefix + 'Switzerland AG';

    it('distinct labels always produce distinct filenames', () => {
        expect(sanitizeFilename(a)).not.toBe(sanitizeFilename(b));
    });

    it('two long-labelled entities get two separate notes', async () => {
        const app = createTestApp();
        const m = new EntityManager(app as never, 'OSINTCopilot', null);
        await m.initialize();

        const first = await m.createFTMEntity('Company', { name: a }, { skipAutoGeocode: true });
        const second = await m.createFTMEntity('Company', { name: b }, { skipAutoGeocode: true });

        expect(second.filePath).not.toBe(first.filePath);
        expect(m.getAllEntities()).toHaveLength(2);
    });
});

describe('Change 4 - generateId uses crypto.randomUUID', () => {
    it('ids are still UUIDv4-shaped', () => {
        expect(generateId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('ids are unaffected by Math.random', () => {
        const original = Math.random;
        try {
            Math.random = () => 0.5;
            expect(generateId()).not.toBe(generateId());
        } finally {
            Math.random = original;
        }
    });
});

describe('Change 5 - custom types can be unregistered without a restart', () => {
    it('a registered type resolves, and stops resolving once unregistered', () => {
        ftmSchemaService.initialize();
        const name = 'TestOnlyCustomType';

        ftmSchemaService.registerSchema({
            name,
            label: 'Test Only',
            extends: ['Thing'],
            properties: { codename: { label: 'Codename', type: 'string' } },
        });
        expect(ftmSchemaService.getSchema(name)?.allProperties.codename).toBeDefined();

        expect(ftmSchemaService.unregisterSchema(name)).toBe(true);
        expect(ftmSchemaService.getSchema(name)).toBeNull();

        // Removing something that was never registered is a no-op, not an error.
        expect(ftmSchemaService.unregisterSchema(name)).toBe(false);
    });

    it('does not remove bundled OIDSF schemas', () => {
        ftmSchemaService.initialize();
        expect(ftmSchemaService.unregisterSchema('Company')).toBe(false);
        expect(ftmSchemaService.getSchema('Company')).not.toBeNull();
    });

    it('descendants stop inheriting from an unregistered parent', () => {
        ftmSchemaService.initialize();
        ftmSchemaService.registerSchema({
            name: 'TestParentType', label: 'Parent', extends: ['Thing'],
            properties: { inherited: { label: 'Inherited', type: 'string' } },
        });
        ftmSchemaService.registerSchema({
            name: 'TestChildType', label: 'Child', extends: ['TestParentType'],
            properties: { own: { label: 'Own', type: 'string' } },
        });
        expect(ftmSchemaService.getSchema('TestChildType')?.allProperties.inherited).toBeDefined();

        ftmSchemaService.unregisterSchema('TestParentType');

        // The child was resolved while the parent existed; without a full cache drop it
        // would keep serving properties inherited from a type that no longer exists.
        expect(ftmSchemaService.getSchema('TestChildType')?.allProperties.inherited).toBeUndefined();

        ftmSchemaService.unregisterSchema('TestChildType');
    });
});
