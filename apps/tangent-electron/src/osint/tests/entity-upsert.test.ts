import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { EntityManager } from '../services/entity-manager';
import { createTestApp, type TestApp } from '../obsidian-shim/testing/create-test-app';
import { getContent, snapshotPaths } from './helpers/vault-inspect';
import { identifierKey, identifierKeysForEntity, normalizeIdentifierKey } from '../services/entity-identifiers';
import type { OsintSourceInput } from '../entities/types';
import { OrchestrationService } from '../services/orchestration-service';

/**
 * Entities that share a label, and external ingestion that should land on the entity the
 * investigator already has. A browser extension sends page text here; before this, a
 * second entity with an existing label overwrote the first one's note -- id, properties
 * and sources -- and nothing could find an existing entity by its email address.
 */

function frontmatterOf(content: string | undefined): Record<string, unknown> {
    const match = content?.match(/^---\n([\s\S]*?)\n---/);
    expect(match).toBeTruthy();
    return parseYaml(match![1]) as Record<string, unknown>;
}

function entityNotes(app: TestApp): string[] {
    return snapshotPaths(app).filter((p) => p.endsWith('.md') && p.includes('/ftm/'));
}

const SOURCE_A: OsintSourceInput = {
    source_url: 'https://example.com/team',
    inferred: false,
    rationale: 'Listed on the team page.',
    via: 'browser-extension',
    client_id: 'client-123',
    sha256: 'a'.repeat(64),
    received_at: '2026-09-01T10:00:00.000Z',
};

const SOURCE_B: OsintSourceInput = {
    source_url: 'https://other.example.org/contact',
    inferred: false,
    rationale: 'Contact page.',
    via: 'browser-extension',
    client_id: 'client-123',
    sha256: 'b'.repeat(64),
    received_at: '2026-09-02T10:00:00.000Z',
};

describe('entities that share a label keep separate notes', () => {
    let app: TestApp;
    let manager: EntityManager;

    beforeEach(async () => {
        app = createTestApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
    });

    it('a second entity with an existing label does not touch the first note', async () => {
        const first = await manager.createFTMEntity('Person', { name: 'John Smith', nationality: 'gb' }, {
            skipAutoGeocode: true,
            osint_sources: [SOURCE_A],
        });
        const firstBytes = getContent(app, first.filePath!);

        const second = await manager.createFTMEntity('Person', { name: 'John Smith', nationality: 'us' }, {
            skipAutoGeocode: true,
        });

        expect(second.filePath).not.toBe(first.filePath);
        expect(second.filePath).toContain(`John Smith (${second.id.substring(0, 6)}).md`);
        expect(getContent(app, first.filePath!)).toBe(firstBytes);
        expect(frontmatterOf(getContent(app, second.filePath!)).id).toBe(second.id);

        // Both survive a reload as themselves.
        const reloaded = new EntityManager(app as never, 'OSINTCopilot', null);
        await reloaded.loadEntitiesFromNotes();
        expect(reloaded.getEntity(first.id)?.properties.nationality).toBe('gb');
        expect(reloaded.getEntity(first.id)?.osint_sources?.[0].source_url).toBe(SOURCE_A.source_url);
        expect(reloaded.getEntity(second.id)?.properties.nationality).toBe('us');
    });

    it('each entity is then updated and deleted through its own file only', async () => {
        const first = await manager.createFTMEntity('Company', { name: 'Acme' }, { skipAutoGeocode: true });
        const second = await manager.createFTMEntity('Company', { name: 'Acme' }, { skipAutoGeocode: true });
        const firstPath = first.filePath!;
        const secondPath = second.filePath!;

        const secondBefore = getContent(app, secondPath);
        await manager.updateEntity(first.id, { country: 'de' });
        expect(first.filePath).toBe(firstPath);
        expect(frontmatterOf(getContent(app, firstPath)).country).toBe('de');
        expect(getContent(app, secondPath)).toBe(secondBefore);

        const firstBefore = getContent(app, firstPath);
        await manager.updateEntity(second.id, { country: 'fr' });
        expect(second.filePath).toBe(secondPath);
        expect(frontmatterOf(getContent(app, secondPath)).country).toBe('fr');
        expect(getContent(app, firstPath)).toBe(firstBefore);
        expect(entityNotes(app)).toHaveLength(2);

        await manager.deleteEntity(second.id);
        expect(getContent(app, secondPath)).toBeUndefined();
        expect(getContent(app, firstPath)).toBe(firstBefore);

        // With the plain name taken by the first entity, a third Acme still gets its own file.
        const third = await manager.createFTMEntity('Company', { name: 'Acme' }, { skipAutoGeocode: true });
        expect(third.filePath).not.toBe(firstPath);
        expect(getContent(app, firstPath)).toBe(firstBefore);

        await manager.deleteEntity(first.id);
        expect(getContent(app, firstPath)).toBeUndefined();
        expect(frontmatterOf(getContent(app, third.filePath!)).id).toBe(third.id);
    });

    it('a label change renames the note instead of leaving a second copy', async () => {
        const entity = await manager.createFTMEntity('Company', { name: 'Old Name' }, { skipAutoGeocode: true });
        const oldPath = entity.filePath!;

        await manager.updateEntity(entity.id, { name: 'New Name' });

        expect(entity.filePath).toMatch(/\/New Name\.md$/);
        expect(getContent(app, oldPath)).toBeUndefined();
        expect(frontmatterOf(getContent(app, entity.filePath!)).id).toBe(entity.id);
        expect(entityNotes(app)).toHaveLength(1);
    });

    it('a label change onto a name another entity holds does not overwrite it', async () => {
        const taken = await manager.createFTMEntity('Company', { name: 'Taken' }, { skipAutoGeocode: true });
        const takenBytes = getContent(app, taken.filePath!);
        const mover = await manager.createFTMEntity('Company', { name: 'Mover' }, { skipAutoGeocode: true });

        await manager.updateEntity(mover.id, { name: 'Taken' });

        expect(mover.filePath).not.toBe(taken.filePath);
        expect(getContent(app, taken.filePath!)).toBe(takenBytes);
        expect(entityNotes(app)).toHaveLength(2);
    });

    it('a note on disk that is not loaded is still not overwritten', async () => {
        // e.g. an entity whose create was undone: its note stays, it is gone from memory.
        const ghost = await manager.createFTMEntity('Company', { name: 'Ghost' }, { skipAutoGeocode: true });
        const ghostBytes = getContent(app, ghost.filePath!);
        manager.deleteEntityInMemory(ghost.id);

        const other = await manager.createFTMEntity('Company', { name: 'Ghost' }, { skipAutoGeocode: true });

        expect(other.filePath).not.toBe(ghost.filePath);
        expect(getContent(app, ghost.filePath!)).toBe(ghostBytes);
    });

    it('restoring a deleted entity does not overwrite the entity that took its name', async () => {
        const deleted = await manager.createFTMEntity('Company', { name: 'Reused' }, { skipAutoGeocode: true });
        const snapshot = { ...deleted, properties: { ...deleted.properties } };
        await manager.deleteEntity(deleted.id);

        const newcomer = await manager.createFTMEntity('Company', { name: 'Reused' }, { skipAutoGeocode: true });
        expect(newcomer.filePath).toBe(snapshot.filePath);
        const newcomerBytes = getContent(app, newcomer.filePath!);

        expect(await manager.restoreEntity(snapshot)).toBe(true);

        expect(getContent(app, newcomer.filePath!)).toBe(newcomerBytes);
        const restored = manager.getEntity(deleted.id)!;
        expect(restored.filePath).not.toBe(newcomer.filePath);
        expect(frontmatterOf(getContent(app, restored.filePath!)).id).toBe(deleted.id);
    });

    it('a note the investigator renamed stays where it is when its label does not change', async () => {
        const entity = await manager.createFTMEntity('Person', { name: 'Alice' }, { skipAutoGeocode: true });
        const renamed = 'OSINTCopilot/ftm/Person/Alice (work).md';
        await app.vault.rename(app.vault.getAbstractFileByPath(entity.filePath!)!, renamed);
        await manager.loadEntitiesFromNotes();
        expect(manager.getEntity(entity.id)!.filePath).toBe(renamed);

        await manager.appendOsintSources(entity.id, [SOURCE_A]);
        expect(manager.getEntity(entity.id)!.filePath).toBe(renamed);

        await manager.updateEntity(entity.id, { nationality: 'gb' });
        expect(manager.getEntity(entity.id)!.filePath).toBe(renamed);
        expect(entityNotes(app)).toEqual([renamed]);
        const fm = frontmatterOf(getContent(app, renamed));
        expect(fm.id).toBe(entity.id);
        expect(fm.nationality).toBe('gb');

        // A real label change still renames it.
        await manager.updateEntity(entity.id, { name: 'Alice Cooper' });
        expect(manager.getEntity(entity.id)!.filePath).toBe('OSINTCopilot/ftm/Person/Alice Cooper.md');
        expect(entityNotes(app)).toHaveLength(1);
    });

    it('connections between entities that share labels keep separate notes', async () => {
        const a = await manager.createFTMEntity('Person', { name: 'John Smith' }, { skipAutoGeocode: true });
        const b = await manager.createFTMEntity('Person', { name: 'John Smith' }, { skipAutoGeocode: true });
        const acme = await manager.createFTMEntity('Company', { name: 'Acme' }, { skipAutoGeocode: true });

        const first = await manager.createConnection(a.id, acme.id, 'Employment');
        const firstBytes = getContent(app, first!.filePath!);
        const second = await manager.createConnection(b.id, acme.id, 'Employment');

        expect(second!.filePath).not.toBe(first!.filePath);
        expect(getContent(app, first!.filePath!)).toBe(firstBytes);
        expect(frontmatterOf(firstBytes).id).toBe(first!.id);
        expect(frontmatterOf(getContent(app, second!.filePath!)).id).toBe(second!.id);

        const reloaded = new EntityManager(app as never, 'OSINTCopilot', null);
        await reloaded.loadEntitiesFromNotes();
        expect(reloaded.getConnection(first!.id)?.fromEntityId).toBe(a.id);
        expect(reloaded.getConnection(second!.id)?.fromEntityId).toBe(b.id);
    });

    it('an undo onto a note another entity now owns changes nothing', async () => {
        const entity = await manager.createFTMEntity('Company', { name: 'Undone' }, { skipAutoGeocode: true });
        const snapshot = { ...entity, properties: { ...entity.properties, country: 'de' } };
        await manager.deleteEntity(entity.id);
        const other = await manager.createFTMEntity('Company', { name: 'Undone' }, { skipAutoGeocode: true });
        expect(other.filePath).toBe(snapshot.filePath);
        const otherBytes = getContent(app, other.filePath!);

        expect(await manager.updateEntityForHistory(snapshot)).toBe(false);
        expect(getContent(app, other.filePath!)).toBe(otherBytes);
        expect(manager.getEntity(entity.id)).toBeUndefined();
    });

    it('falls back to the full id when the short prefix collides', async () => {
        let n = 0;
        const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
            n++;
            return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`;
        });
        try {
            const a = await manager.createFTMEntity('Company', { name: 'Same' }, { skipAutoGeocode: true });
            const b = await manager.createFTMEntity('Company', { name: 'Same' }, { skipAutoGeocode: true });
            const c = await manager.createFTMEntity('Company', { name: 'Same' }, { skipAutoGeocode: true });
            expect(new Set([a.filePath, b.filePath, c.filePath]).size).toBe(3);
            expect(c.filePath).toContain(`Same (${c.id}).md`);
            for (const e of [a, b, c]) {
                expect(frontmatterOf(getContent(app, e.filePath!)).id).toBe(e.id);
            }
        } finally {
            spy.mockRestore();
        }
    });
});

describe('identifier keys', () => {
    it('normalises each kind', () => {
        expect(identifierKey('email', ' Alice@Example.COM ')).toBe('email:alice@example.com');
        expect(identifierKey('email', 'mailto:bob@x.org')).toBe('email:bob@x.org');
        expect(identifierKey('email', 'not an email')).toBeNull();
        expect(identifierKey('phone', '+44 (20) 7946-0018')).toBe('phone:+442079460018');
        expect(identifierKey('phone', '020 7946 0018')).toBe('phone:02079460018');
        expect(identifierKey('domain', 'Example.COM.')).toBe('domain:example.com');
        expect(identifierKey('username', '@JaneDoe')).toBe('username:janedoe');
        expect(identifierKey('url', 'HTTPS://Example.com/Path?q=1#frag')).toBe('url:https://example.com/Path?q=1');
        expect(identifierKey('ip', '010.000.000.001')).toBe('ip:10.0.0.1');
        expect(identifierKey('ip', '2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('ip:2001:db8::1');
        expect(identifierKey('wallet', 'ETH:0xABCdef0123')).toBe('wallet:eth:0xabcdef0123');
        // Base58 is case-sensitive, so it is kept as written.
        expect(identifierKey('wallet', 'btc:1BoatSLRHtKNngkdXEeobR76b53LETtpyT'))
            .toBe('wallet:btc:1BoatSLRHtKNngkdXEeobR76b53LETtpyT');
        expect(normalizeIdentifierKey('EMAIL:Foo@Bar.com')).toBe('email:foo@bar.com');
        expect(normalizeIdentifierKey('nope:foo')).toBeNull();
    });

    it('covers legacy note shapes', () => {
        expect(identifierKeysForEntity({ type: 'Email', ftmSchema: 'LegalEntity', properties: { address: 'A@B.co' } }))
            .toEqual(['email:a@b.co']);
        expect(identifierKeysForEntity({ type: 'Phone', ftmSchema: 'LegalEntity', properties: { number: '+1 555 0100' } }))
            .toEqual(['phone:+15550100']);
        expect(identifierKeysForEntity({ type: 'Username', ftmSchema: 'UserAccount', properties: { username: 'Neo' } }))
            .toEqual(['username:neo']);
        expect(identifierKeysForEntity({ type: 'OnlineAccount', ftmSchema: 'OnlineAccount', properties: { username: 'Trinity' } }))
            .toEqual(['username:trinity']);
        // A person who owns an address is not the address.
        expect(identifierKeysForEntity({ type: 'Person', ftmSchema: 'Person', properties: { email: 'p@x.org' } }))
            .toEqual([]);
    });
});

describe('finding and upserting by identifier', () => {
    let app: TestApp;
    let manager: EntityManager;

    beforeEach(async () => {
        app = createTestApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
    });

    it('findEntityByIdentifier matches a normalised email regardless of case', async () => {
        const entity = await manager.createFTMEntity('EmailAddr', { value: 'Alice@Example.com' }, { skipAutoGeocode: true });

        expect(manager.findEntityByIdentifier('EmailAddr', 'email:alice@example.com')?.id).toBe(entity.id);
        expect(manager.findEntityByIdentifier('EmailAddr', 'email:ALICE@EXAMPLE.COM')?.id).toBe(entity.id);
        expect(manager.findEntityByIdentifier('EmailAddr', 'email:bob@example.com')).toBeNull();
    });

    it('finds a legacy LegalEntity note by its email property after a reload', async () => {
        await app.vault.createFolder('OSINTCopilot/ftm/LegalEntity');
        await app.vault.create('OSINTCopilot/ftm/LegalEntity/Legacy.md', [
            '---',
            'id: legacy-1',
            'type: LegalEntity',
            'ftmSchema: LegalEntity',
            'label: Legacy contact',
            'email: Legacy.Person@Example.org',
            '---',
            '',
            '# Legacy contact',
            '',
        ].join('\n'));
        // OSINTCopilot/Email already exists: initialize() creates the legacy type folders.
        await app.vault.create('OSINTCopilot/Email/old-email.md', [
            '---',
            'id: legacy-2',
            'type: Email',
            'label: old@example.net',
            'address: Old@Example.net',
            '---',
            '',
        ].join('\n'));
        await manager.loadEntitiesFromNotes();

        expect(manager.findEntityByIdentifier('EmailAddr', 'email:legacy.person@example.org')?.id).toBe('legacy-1');
        expect(manager.findEntityByIdentifier('EmailAddr', 'email:old@example.net')?.id).toBe('legacy-2');
    });

    it('keeps the index in step with updates and deletes', async () => {
        const entity = await manager.createFTMEntity('EmailAddr', { value: 'first@example.com' }, { skipAutoGeocode: true });
        await manager.updateEntity(entity.id, { value: 'second@example.com' });

        expect(manager.findEntityByIdentifier('EmailAddr', 'email:first@example.com')).toBeNull();
        expect(manager.findEntityByIdentifier('EmailAddr', 'email:second@example.com')?.id).toBe(entity.id);

        await manager.deleteEntity(entity.id);
        expect(manager.findEntityByIdentifier('EmailAddr', 'email:second@example.com')).toBeNull();
    });

    it('appendOsintSources a second time with the same sources is a no-op', async () => {
        const entity = await manager.createFTMEntity('EmailAddr', { value: 'a@example.com' }, { skipAutoGeocode: true });
        const path = entity.filePath!;

        await manager.appendOsintSources(entity.id, [SOURCE_A, SOURCE_B]);
        const afterFirst = getContent(app, path);
        expect(entity.osint_sources).toHaveLength(2);

        const modify = vi.spyOn(app.vault, 'modify');
        await manager.appendOsintSources(entity.id, [SOURCE_A, SOURCE_B]);
        expect(modify).not.toHaveBeenCalled();
        modify.mockRestore();

        expect(entity.osint_sources).toHaveLength(2);
        expect(getContent(app, path)).toBe(afterFirst);
        expect(entity.id).toBe(frontmatterOf(afterFirst).id);
        expect(entity.filePath).toBe(path);
        expect(entity.osint_confidence).toBe('medium');
    });

    it('appendOsintSources keeps provenance fields through a reload', async () => {
        const entity = await manager.createFTMEntity('EmailAddr', { value: 'p@example.com' }, { skipAutoGeocode: true });
        await manager.appendOsintSources(entity.id, [SOURCE_A]);

        const reloaded = new EntityManager(app as never, 'OSINTCopilot', null);
        await reloaded.loadEntitiesFromNotes();
        const [src] = reloaded.getEntity(entity.id)!.osint_sources!;
        expect(src).toMatchObject({
            source_url: SOURCE_A.source_url,
            via: 'browser-extension',
            client_id: 'client-123',
            sha256: 'a'.repeat(64),
            received_at: '2026-09-01T10:00:00.000Z',
        });
        expect(reloaded.getEntity(entity.id)!.properties.value).toBe('p@example.com');
    });

    it('appendOsintSources recognises a stored source by its content, whatever its id', async () => {
        // Sources saved before ids were derived from content carry random ids.
        const entity = await manager.createFTMEntity('EmailAddr', { value: 'old@example.com' }, {
            skipAutoGeocode: true,
            osint_sources: [{ ...SOURCE_A, id: 'src_legacy_random_1' }],
        });
        await manager.loadEntitiesFromNotes();

        await manager.appendOsintSources(entity.id, [SOURCE_A]);
        expect(manager.getEntity(entity.id)!.osint_sources!.map((s) => s.id)).toEqual(['src_legacy_random_1']);

        // A caller reusing an id for a different source does not lose the new source.
        await manager.appendOsintSources(entity.id, [{ ...SOURCE_B, id: 'src_legacy_random_1' }]);
        const sources = manager.getEntity(entity.id)!.osint_sources!;
        expect(sources.map((s) => s.source_url)).toEqual([SOURCE_A.source_url, SOURCE_B.source_url]);
        expect(new Set(sources.map((s) => s.id)).size).toBe(2);
    });

    it('upsertEntityFromExternal falls back to the properties when the given key matches nothing', async () => {
        const existing = await manager.createFTMEntity('EmailAddr', { value: 'known@example.com' }, { skipAutoGeocode: true });
        const { entity, created } = await manager.upsertEntityFromExternal(
            'EmailAddr', { value: 'Known@Example.com' }, [SOURCE_A], { identifierKey: 'email:not-an-address' },
        );
        expect(created).toBe(false);
        expect(entity.id).toBe(existing.id);
        expect(manager.getAllEntities()).toHaveLength(1);
    });

    it('upsertEntityFromExternal creates once, then appends to the same entity', async () => {
        const first = await manager.upsertEntityFromExternal('EmailAddr', { value: 'Target@Example.com' }, [SOURCE_A], {
            identifierKey: 'email:target@example.com',
        });
        expect(first.created).toBe(true);

        const second = await manager.upsertEntityFromExternal('EmailAddr', { value: 'target@EXAMPLE.com' }, [SOURCE_B], {
            identifierKey: 'email:TARGET@example.com',
        });
        expect(second.created).toBe(false);
        expect(second.entity.id).toBe(first.entity.id);
        expect(second.entity.filePath).toBe(first.entity.filePath);
        // The match keeps its own properties.
        expect(second.entity.properties.value).toBe('Target@Example.com');
        expect(second.entity.osint_sources?.map((s) => s.source_url)).toEqual([
            SOURCE_A.source_url,
            SOURCE_B.source_url,
        ]);
        expect(manager.getAllEntities()).toHaveLength(1);

        // The initial source got a deterministic id too, so re-sending it changes nothing.
        const third = await manager.upsertEntityFromExternal('EmailAddr', { value: 'target@example.com' }, [SOURCE_A]);
        expect(third.created).toBe(false);
        expect(third.entity.osint_sources).toHaveLength(2);
    });

    it('upsertEntityFromExternal appends to a legacy LegalEntity email note', async () => {
        const legacy = await manager.createFTMEntity('LegalEntity', { name: 'Contact', email: 'Known@Example.com' }, {
            skipAutoGeocode: true,
        });
        const { entity, created } = await manager.upsertEntityFromExternal(
            'EmailAddr', { value: 'known@example.com' }, [SOURCE_A], { identifierKey: 'email:known@example.com' },
        );
        expect(created).toBe(false);
        expect(entity.id).toBe(legacy.id);
        expect(entity.ftmSchema).toBe('LegalEntity');
    });
});

/**
 * The AI graph pipeline re-proposes the entities it already created whenever extraction
 * runs over the same text again. It used to rely on a same-label create overwriting the
 * note; that is what now gets its own file, so the pipeline merges into the entity instead.
 */
describe('@@create_entity for an entity that already exists', () => {
    let app: TestApp;
    let manager: EntityManager;
    let orchestration: OrchestrationService;

    beforeEach(async () => {
        app = createTestApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
        orchestration = new OrchestrationService({ app, entityManager: manager, vaultLockService: null } as never);
    });

    const create = (properties: Record<string, unknown>, sources: OsintSourceInput[]) =>
        `@@create_entity ${JSON.stringify({ type: 'Company', properties, sources })}`;

    it('merges sources and missing properties into the existing entity', async () => {
        await orchestration.executeGraphCommandsImmediate(
            [create({ name: 'Lukoil', country: 'ru' }, [SOURCE_A])], { showErrorNotices: false },
        );
        const [original] = manager.getAllEntities();
        const lines = await orchestration.executeGraphCommandsImmediate(
            [create({ name: 'Lukoil', country: 'xx', sector: 'oil' }, [SOURCE_B])], { showErrorNotices: false },
        );

        expect(lines[0]).toContain('Merged into existing Company');
        expect(lines[0]).toContain('kept existing country');
        expect(manager.getAllEntities()).toHaveLength(1);
        const entity = manager.getEntity(original.id)!;
        expect(entity.properties.country).toBe('ru');
        expect(entity.properties.sector).toBe('oil');
        expect(entity.osint_sources?.map((s) => s.source_url)).toEqual([SOURCE_A.source_url, SOURCE_B.source_url]);
        expect(entityNotes(app)).toHaveLength(1);
        expect(frontmatterOf(getContent(app, entity.filePath!)).id).toBe(original.id);
    });

    it('running the same command again adds nothing', async () => {
        const command = create({ name: 'Lukoil' }, [SOURCE_A]);
        await orchestration.executeGraphCommandsImmediate([command], { showErrorNotices: false });
        const [entity] = manager.getAllEntities();
        const afterFirst = getContent(app, entity.filePath!);

        await orchestration.executeGraphCommandsImmediate([command], { showErrorNotices: false });
        await orchestration.executeGraphCommandsImmediate([command], { showErrorNotices: false });

        expect(manager.getAllEntities()).toHaveLength(1);
        expect(manager.getEntity(entity.id)!.osint_sources).toHaveLength(1);
        expect(getContent(app, entity.filePath!)).toBe(afterFirst);
    });
});
