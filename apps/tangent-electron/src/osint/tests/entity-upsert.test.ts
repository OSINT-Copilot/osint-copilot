import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { EntityManager } from '../services/entity-manager';
import { createTestApp, type TestApp } from '../obsidian-shim/testing/create-test-app';
import { getContent, snapshotPaths } from './helpers/vault-inspect';
import {
    identifierKey, identifierKeysForEntity, normalizeIdentifierKey, normalizePlatform, platformFromHost,
    usernameIdentifierKey,
} from '../services/entity-identifiers';
import { Vault } from '../obsidian-shim/vault/vault';
import { MemoryStorage } from '../obsidian-shim/vault/storage';
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

    it('upsertEntityFromExternal ignores a username key the properties contradict', async () => {
        const bare = await manager.upsertEntityFromExternal('UserAccount', { username: 'john' }, [SOURCE_A]);
        const github = await manager.upsertEntityFromExternal(
            'UserAccount', { username: 'john', service: 'github' }, [SOURCE_B], { identifierKey: 'username:john' },
        );
        expect(github.created).toBe(true);
        expect(github.entity.id).not.toBe(bare.entity.id);
        expect(manager.getEntity(bare.entity.id)!.osint_sources).toHaveLength(1);

        // A key that agrees with the properties is still used.
        const again = await manager.upsertEntityFromExternal(
            'UserAccount', { username: 'john', service: 'github' }, [SOURCE_A], { identifierKey: 'username:github.com:john' },
        );
        expect(again.entity.id).toBe(github.entity.id);
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

    // An account's label is only its username, so the label fallback must not join accounts
    // whose platforms differ.
    for (const [type, platformKey] of [['UserAccount', 'service'], ['Username', 'platform']] as const) {
        it(`${type}: the same username on GitHub, Twitter and no platform stays three entities`, async () => {
            const account = (platform: string | undefined, source: OsintSourceInput) =>
                `@@create_entity ${JSON.stringify({
                    type,
                    properties: { username: 'john', ...(platform ? { [platformKey]: platform } : {}) },
                    sources: [source],
                })}`;
            const twitterSource = { ...SOURCE_B, source_url: 'https://x.com/john' };

            await orchestration.executeGraphCommandsImmediate([account('github', SOURCE_A)], { showErrorNotices: false });
            const lines = await orchestration.executeGraphCommandsImmediate(
                [account('twitter', twitterSource), account(undefined, SOURCE_B)], { showErrorNotices: false },
            );

            expect(lines.join('\n')).not.toContain('Merged into existing');
            const accounts = manager.getAllEntities();
            expect(accounts).toHaveLength(3);
            const github = accounts.find((e) => e.properties[platformKey] === 'github')!;
            expect(github.osint_sources?.map((s) => s.source_url)).toEqual([SOURCE_A.source_url]);

            // The same GitHub account again still merges, by its key.
            const again = await orchestration.executeGraphCommandsImmediate(
                [account('GitHub.com', { ...SOURCE_A, source_url: 'https://github.com/john' })], { showErrorNotices: false },
            );
            expect(again[0]).toContain('Merged into existing');
            expect(manager.getAllEntities()).toHaveLength(3);
            expect(manager.getEntity(github.id)!.osint_sources).toHaveLength(2);
        });
    }
});

/**
 * Windows and macOS filesystems ignore letter case, so renaming onto "acme.md" replaces
 * "Acme.md" there even though the vault index holds them as two paths. The storage here
 * behaves that way: a path that differs only in case is the same file.
 */
class CaseInsensitiveStorage extends MemoryStorage {
    // macOS also ignores Unicode normalization: "é" and "e" plus a combining accent are one name.
    private static fold(path: string): string {
        return path.normalize('NFC').toLowerCase();
    }

    private sameFile(path: string): string | undefined {
        const wanted = CaseInsensitiveStorage.fold(path);
        return this.paths().find((p) => CaseInsensitiveStorage.fold(p) === wanted);
    }

    override async create(path: string, data: string) {
        if (this.sameFile(path)) throw new Error('File already exists.');
        return super.create(path, data);
    }

    override async write(path: string, data: string) {
        const existing = this.sameFile(path);
        if (existing && existing !== path) await this.remove(existing);
        return super.write(path, data);
    }

    override async rename(from: string, to: string) {
        const existing = this.sameFile(to);
        // Like fs.rename: the destination is replaced, unless it is the source itself.
        if (existing && CaseInsensitiveStorage.fold(existing) !== CaseInsensitiveStorage.fold(from)) await this.remove(existing);
        return super.rename(from, to);
    }
}

async function caseInsensitiveApp(): Promise<TestApp> {
    const storage = new CaseInsensitiveStorage();
    const vault = new Vault(storage);
    await vault.open();
    return {
        vault,
        storage,
        fileManager: { async trashFile(file) { await vault.trash(file); } },
        metadataCache: { getFileCache: () => null },
        workspace: { getLeaf: () => ({ async openFile() { /* unused */ } }), getLeavesOfType: () => [], openedFiles: [] },
    };
}

describe('note names on a case-insensitive filesystem', () => {
    let app: TestApp;
    let manager: EntityManager;

    beforeEach(async () => {
        app = await caseInsensitiveApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
    });

    it('the storage really does replace a note on a case-only rename', async () => {
        await app.vault.create('OSINTCopilot/a.md', 'a');
        await app.vault.create('OSINTCopilot/b.md', 'b');
        await app.vault.rename(app.vault.getAbstractFileByPath('OSINTCopilot/b.md')!, 'OSINTCopilot/A.md');
        expect(getContent(app, 'OSINTCopilot/a.md')).toBeUndefined();
    });

    it('a label change to another entity\'s name in a different case does not replace its note', async () => {
        const taken = await manager.createFTMEntity('Company', { name: 'Acme' }, { skipAutoGeocode: true });
        const takenBytes = getContent(app, taken.filePath!);
        const mover = await manager.createFTMEntity('Company', { name: 'Mover' }, { skipAutoGeocode: true });

        await manager.updateEntity(mover.id, { name: 'ACME' });

        expect(getContent(app, taken.filePath!)).toBe(takenBytes);
        expect(mover.filePath).toContain(`ACME (${mover.id.substring(0, 6)}).md`);
        expect(frontmatterOf(getContent(app, mover.filePath!)).id).toBe(mover.id);
        expect(entityNotes(app)).toHaveLength(2);
    });

    it('a label change to the same name in another Unicode normalization does not replace its note', async () => {
        const taken = await manager.createFTMEntity('Company', { name: 'Caf\u00e9' }, { skipAutoGeocode: true });
        const takenBytes = getContent(app, taken.filePath!);
        const mover = await manager.createFTMEntity('Company', { name: 'Mover' }, { skipAutoGeocode: true });

        await manager.updateEntity(mover.id, { name: 'CAFE\u0301' });

        expect(getContent(app, taken.filePath!)).toBe(takenBytes);
        expect(mover.filePath).toContain(`(${mover.id.substring(0, 6)}).md`);
        expect(entityNotes(app)).toHaveLength(2);
    });

    it('a new entity whose name differs only in case gets its own note', async () => {
        const first = await manager.createFTMEntity('Company', { name: 'Acme' }, { skipAutoGeocode: true });
        const firstBytes = getContent(app, first.filePath!);

        const second = await manager.createFTMEntity('Company', { name: 'acme' }, { skipAutoGeocode: true });

        expect(getContent(app, first.filePath!)).toBe(firstBytes);
        expect(second.filePath).toContain(`acme (${second.id.substring(0, 6)}).md`);
    });

    it('a note that is not loaded is not replaced either', async () => {
        const ghost = await manager.createFTMEntity('Company', { name: 'Ghost' }, { skipAutoGeocode: true });
        const ghostBytes = getContent(app, ghost.filePath!);
        manager.deleteEntityInMemory(ghost.id);
        const mover = await manager.createFTMEntity('Company', { name: 'Mover' }, { skipAutoGeocode: true });

        await manager.updateEntity(mover.id, { name: 'ghost' });

        expect(getContent(app, ghost.filePath!)).toBe(ghostBytes);
        expect(mover.filePath).not.toMatch(/\/ghost\.md$/);
    });

    it('an entity can still change the case of its own name', async () => {
        const entity = await manager.createFTMEntity('Company', { name: 'acme' }, { skipAutoGeocode: true });
        const oldPath = entity.filePath!;

        await manager.updateEntity(entity.id, { name: 'Acme' });

        expect(entity.filePath).toBe(oldPath.replace(/acme\.md$/, 'Acme.md'));
        expect(getContent(app, oldPath)).toBeUndefined();
        expect(frontmatterOf(getContent(app, entity.filePath!)).name).toBe('Acme');
        expect(entityNotes(app)).toHaveLength(1);
    });
});

describe('undo is all or nothing', () => {
    let app: TestApp;
    let manager: EntityManager;

    beforeEach(async () => {
        app = createTestApp();
        manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();
    });

    function yamlOf(prefix: string, id: string): string | undefined {
        const path = snapshotPaths(app).find((p) => p.includes('graph-yaml') && p.includes(prefix) && p.includes(id));
        return path ? getContent(app, path) : undefined;
    }

    it('an entity undo that cannot write its note leaves memory and the graph yaml alone', async () => {
        const entity = await manager.createFTMEntity('Company', { name: 'Solid', country: 'de' }, { skipAutoGeocode: true });
        const noteBefore = getContent(app, entity.filePath!);
        const yamlBefore = snapshotPaths(app).filter((p) => p.includes('graph-yaml')).map((p) => getContent(app, p));
        const snapshot = { ...entity, properties: { ...entity.properties, country: 'fr' } };

        const modify = vi.spyOn(app.vault, 'modify').mockRejectedValueOnce(new Error('disk full'));
        try {
            expect(await manager.updateEntityForHistory(snapshot)).toBe(false);
        } finally {
            modify.mockRestore();
        }

        expect(manager.getEntity(entity.id)?.properties.country).toBe('de');
        expect(getContent(app, entity.filePath!)).toBe(noteBefore);
        expect(snapshotPaths(app).filter((p) => p.includes('graph-yaml')).map((p) => getContent(app, p))).toEqual(yamlBefore);
    });

    it('a connection undo onto a note another connection now owns changes nothing', async () => {
        const a = await manager.createFTMEntity('Person', { name: 'Ann' }, { skipAutoGeocode: true });
        const acme = await manager.createFTMEntity('Company', { name: 'Acme' }, { skipAutoGeocode: true });
        const conn = (await manager.createConnection(a.id, acme.id, 'Employment', { role: 'clerk' }))!;
        const snapshot = { ...conn, properties: { ...conn.properties, role: 'director' } };

        // The connection's note now carries another connection's id, as after a delete and
        // a new connection taking the name.
        const content = getContent(app, conn.filePath!)!;
        await app.vault.modify(
            app.vault.getAbstractFileByPath(conn.filePath!) as never,
            content.replace(`id: ${JSON.stringify(conn.id)}`, 'id: "someone-else"'),
        );
        (manager as unknown as { connections: Map<string, unknown> }).connections.delete(conn.id);
        const noteBefore = getContent(app, conn.filePath!);
        const yamlBefore = yamlOf('', conn.id);

        expect(await manager.updateConnectionForHistory(snapshot)).toBe(false);

        expect(getContent(app, conn.filePath!)).toBe(noteBefore);
        expect(manager.getConnection(conn.id)).toBeUndefined();
        expect(yamlOf('', conn.id)).toBe(yamlBefore);
    });
});

describe('usernames are keyed by platform', () => {
    it('normalizePlatform folds the spellings of one platform together', () => {
        for (const [raw, want] of [
            ['x.com', 'twitter'],
            ['https://www.x.com/john', 'twitter'],
            ['Twitter.com', 'twitter'],
            ['twitter', 'twitter'],
            ['X', 'twitter'],
            ['www.github.com', 'github'],
            ['GitHub', 'github'],
            ['t.me', 'telegram'],
            ['telegram.me', 'telegram'],
            ['telegram.org', 'telegram'],
            ['www.Example.org.', 'example.org'],
            ['https://forum.example.net/u/john', 'forum.example.net'],
            ['My Forum!', 'myforum'],
            ['forum.example.net:8080', 'forum.example.net'],
            ['https://forum.example.net:8443/u/john', 'forum.example.net'],
        ] as const) {
            expect(normalizePlatform(raw), raw).toBe(want);
        }
        expect(normalizePlatform('  ')).toBeNull();
        expect(normalizePlatform('!!!')).toBeNull();
        expect(normalizePlatform(42)).toBeNull();
        expect(platformFromHost('www.twitter.com')).toBe('twitter');
        expect(platformFromHost('mastodon.social')).toBe('mastodon.social');
    });

    it('a known platform goes into the key, and the forms never meet', () => {
        expect(identifierKey('username', '@John', 'github.com')).toBe('username:github:john');
        expect(identifierKey('username', 'john', 'x.com')).toBe('username:twitter:john');
        expect(identifierKey('username', 'john')).toBe('username:john');
        expect(identifierKey('username', 'john', '')).toBe('username:john');
        // A colon would forge the platform form.
        expect(identifierKey('username', 'github:john')).toBeNull();
        expect(usernameIdentifierKey('John', 'Twitter')).toBe('username:twitter:john');

        expect(normalizeIdentifierKey('username:x.com:@John')).toBe('username:twitter:john');
        expect(normalizeIdentifierKey('USERNAME:John')).toBe('username:john');
        expect(normalizeIdentifierKey('username::john')).toBeNull();
    });

    it('identifierKeysForEntity reads platform (legacy) and service (FTM)', () => {
        expect(identifierKeysForEntity({ type: 'Username', ftmSchema: 'UserAccount', properties: { username: 'Neo', platform: 'twitter.com' } }))
            .toEqual(['username:twitter:neo']);
        expect(identifierKeysForEntity({ type: 'UserAccount', ftmSchema: 'UserAccount', properties: { username: 'Neo', service: 'GitHub' } }))
            .toEqual(['username:github:neo']);
        expect(identifierKeysForEntity({ type: 'UserAccount', ftmSchema: 'UserAccount', properties: { username: 'Neo', service: '???' } }))
            .toEqual(['username:neo']);
    });

    it('the same name on two platforms, or on none, stays three entities', async () => {
        const app = createTestApp();
        const manager = new EntityManager(app as never, 'OSINTCopilot', null);
        await manager.initialize();

        const gh = await manager.upsertEntityFromExternal('UserAccount', { username: 'john', service: 'github.com' }, [SOURCE_A]);
        const tw = await manager.upsertEntityFromExternal('UserAccount', { username: 'john', service: 'x.com' }, [SOURCE_A]);
        const none = await manager.upsertEntityFromExternal('UserAccount', { username: 'john' }, [SOURCE_A]);
        expect([gh.created, tw.created, none.created]).toEqual([true, true, true]);
        expect(new Set([gh.entity.id, tw.entity.id, none.entity.id]).size).toBe(3);

        // The same account from another spelling of the platform lands on the first one.
        const again = await manager.upsertEntityFromExternal('UserAccount', { username: '@John', service: 'GitHub' }, [SOURCE_B]);
        expect(again.created).toBe(false);
        expect(again.entity.id).toBe(gh.entity.id);

        expect(manager.findEntityByIdentifier('UserAccount', 'username:twitter.com:john')?.id).toBe(tw.entity.id);
        expect(manager.findEntityByIdentifier('UserAccount', 'username:john')?.id).toBe(none.entity.id);
    });
});
