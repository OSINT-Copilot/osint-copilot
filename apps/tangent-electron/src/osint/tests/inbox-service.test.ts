import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { parse as parseYaml } from 'yaml';
import { EntityManager } from '../services/entity-manager';
import { createTestApp, type TestApp } from '../obsidian-shim/testing/create-test-app';
import { getContent, snapshotPaths } from './helpers/vault-inspect';
import {
    InboxService, LEASE_RETRY_MS, SOURCES_FOLDER, blockLiteral, cleanNoteText, cutSection, entityTargetFor, inlineLiteral,
    normalizeActivityOutcome, parseSidecar, readExtensionActivity, sidecarPathFor, sourceSlug, type ExtensionActivityItem,
} from '../services/inbox-service';
import { markdownToTextDocument, parseMarkdown } from '../../common/markdownModel/parser';
import { activityCaptureNotes, activityMergeLabel, activityTypeLabel } from '../modals/extension-activity-modal';
import type {
    InboxAppliedBundle, InboxBundle, InboxCaptureDerived, InboxClaimResult, InboxHost, InboxOutcome, InboxPlacedFile,
    InboxPlacement, InboxState,
} from '../host/types';
import type { EntityPayload, Manifest } from '../../main/osint/extension/protocol';
import { generateId, type Entity } from '../entities/types';

/**
 * The renderer half of the browser extension: what a bundle from the inbox becomes in
 * the vault, that applying it again (or after a crash half way) adds nothing twice, and
 * that Remove takes back exactly what one item added.
 */

const CLIENT = 'CCCCCCCCCCCCCCCCCCCCCC';

/**
 * main's inbox, in memory: pending/done/removed/rejected plus each bundle's journal. One
 * instance is the one main process; `window()` gives each app window its own handle on it,
 * so two services on one FakeInbox are two windows on one investigation.
 */
class FakeInbox implements InboxHost {
    readonly bundles = new Map<string, { bundle: InboxBundle; where: 'pending' | InboxOutcome }>();
    heldElsewhere = false;
    held = false;
    /** Throws once, the next time this step is recorded: a crash just before the journal write. */
    crashBeforeStep: string | null = null;
    crashBeforeFinish = false;
    listeners = new Set<() => void>();
    calls: string[] = [];
    private seq = 0;
    /** The vault main places capture files into. */
    app!: TestApp;
    /** A capture's files as main holds them in its bundle: role, extension, bytes. */
    readonly captureFiles = new Map<string, { stem: string; files: Array<{ role: InboxPlacedFile['role']; ext: string; body: string }> }>();
    /** What main recorded as each bundle's own placed files (its `placement` step). */
    readonly owned = new Map<string, Map<string, string>>();
    /** The digest of every file main placed, by path; what it hashes a present file to. */
    readonly placedSha = new Map<string, string>();

    add(manifest: { kind: string; page: { url: string; title: string }; note?: { text: string }; entity?: EntityPayload; highlight?: unknown }): string {
        const n = ++this.seq;
        const bundleId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        const full = { v: 1, workspaceId: 'W'.repeat(22), clientTime: '2026-09-18T10:00:00.000Z', ...manifest, bundleId } as Manifest;
        this.bundles.set(bundleId, {
            where: 'pending',
            bundle: {
                bundleId,
                manifest: full,
                server: {
                    receivedAt: `2026-09-18T10:00:${String(n).padStart(2, '0')}.000Z`,
                    clientId: CLIENT,
                    origin: 'chrome-extension://' + 'a'.repeat(32),
                    extVersion: '1.0.0',
                },
                state: null,
            },
        });
        return bundleId;
    }

    where(bundleId: string) { return this.bundles.get(bundleId)?.where; }

    async claim(): Promise<InboxClaimResult> {
        this.calls.push('claim');
        if (this.heldElsewhere) return { ok: false, reason: 'held' };
        this.held = true;
        return { ok: true };
    }
    async release() { this.calls.push('release'); this.held = false; }
    async list(): Promise<InboxBundle[]> {
        this.calls.push('list');
        if (!this.held) throw new Error('Another window is applying this investigation\'s inbox.');
        return [...this.bundles.values()].filter((b) => b.where === 'pending').map((b) => structuredClone(b.bundle));
    }
    async step(bundleId: string, step: string, data: unknown): Promise<InboxState> {
        if (!this.held) throw new Error('not the holder');
        if (this.crashBeforeStep === step) {
            this.crashBeforeStep = null;
            throw new Error(`simulated crash before ${step}`);
        }
        const entry = this.bundles.get(bundleId)!;
        const state: InboxState = entry.bundle.state ?? { v: 1, steps: [] };
        const clean = JSON.parse(JSON.stringify(data));
        const existing = state.steps.find((s) => s.step === step);
        if (existing) existing.data = clean;
        else state.steps.push({ step, at: new Date().toISOString(), data: clean });
        entry.bundle.state = state;
        return structuredClone(state);
    }
    async finish(bundleId: string, outcome: InboxOutcome) {
        if (this.crashBeforeFinish) {
            this.crashBeforeFinish = false;
            throw new Error('simulated crash before finish');
        }
        const entry = this.bundles.get(bundleId)!;
        if (entry.where !== 'pending') throw new Error(`No pending bundle ${bundleId}`);
        entry.where = outcome;
        this.calls.push(`finish:${outcome}`);
    }
    async markRemoved(bundleId: string) {
        const entry = this.bundles.get(bundleId);
        if (entry?.where !== 'done') throw new Error(`No done bundle ${bundleId}`);
        const state: InboxState = entry.bundle.state ?? { v: 1, steps: [] };
        state.steps.push({ step: 'removed', at: '2026-09-18T11:00:00.000Z', data: null });
        entry.bundle.state = state;
        entry.where = 'removed';
    }
    async listApplied(): Promise<InboxAppliedBundle[]> {
        return [...this.bundles.values()]
            .filter((b) => b.where === 'done' || b.where === 'removed')
            .map((b) => ({ ...structuredClone(b.bundle), where: b.where as 'done' | 'removed' }));
    }
    /**
     * Main's placeFiles, in memory: the same naming, reuse and ownership rules
     * (place-files.ts), writing into the test vault.
     */
    async placeFiles(bundleId: string): Promise<InboxPlacement> {
        this.calls.push('placeFiles');
        if (!this.held) throw new Error('not the holder');
        const entry = this.bundles.get(bundleId);
        const held = this.captureFiles.get(bundleId);
        if (entry?.where !== 'pending' || !held) throw new Error(`No pending bundle ${bundleId}`);
        const owned = this.owned.get(bundleId) ?? new Map<string, string>();
        this.owned.set(bundleId, owned);
        const files: InboxPlacedFile[] = [];
        for (const f of held.files) {
            const sha256 = sha(f.body);
            for (let n = 1; ; n++) {
                const path = `OSINTCopilot/Evidence/${held.stem}${n === 1 ? '' : `-${n}`}${f.ext}`;
                if (this.app.vault.getAbstractFileByPath(path)) {
                    if ((this.placedSha.get(path) ?? sha(getContent(this.app, path) ?? '')) !== sha256) continue;
                    files.push({ role: f.role, path, sha256, created: owned.get(path) === sha256 });
                    break;
                }
                owned.set(path, sha256);
                await ensureFolder('OSINTCopilot/Evidence');
                await this.app.vault.create(path, f.body);
                this.placedSha.set(path, sha256);
                files.push({ role: f.role, path, sha256, created: true });
                break;
            }
        }
        return { bundleId, files };
    }
    onChanged(callback: () => void) {
        this.listeners.add(callback);
        return () => { this.listeners.delete(callback); };
    }
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function ensureFolder(path: string) {
    let at = '';
    for (const part of path.split('/')) {
        at = at ? `${at}/${part}` : part;
        if (!app.vault.getAbstractFileByPath(at)) await app.vault.createFolder(at);
    }
}

function frontmatterOf(content: string | undefined): Record<string, unknown> {
    const match = content?.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).toBeTruthy();
    return parseYaml(match![1]) as Record<string, unknown>;
}

function entityBundle(entity: EntityPayload, url = 'https://example.com/team', title = 'Team page') {
    return { kind: 'entity' as const, page: { url, title }, entity };
}

function noteBundle(text: string, url = 'https://example.com/team', title = 'Team page') {
    return { kind: 'note' as const, page: { url, title }, note: { text } };
}

let app: TestApp;
let manager: EntityManager;
let inbox: FakeInbox;
let activity: ExtensionActivityItem[];
let allowWayback: boolean;
let notices: number[];
let dropped: number[];
/** Makes the next item's source lookup throw: a crash after entity-plan, before the upsert. */
let crashBeforeUpsert: boolean;

function newManager(): EntityManager {
    return new EntityManager(app as never, 'OSINTCopilot', null, () => ['Sources', 'Evidence']);
}

function newService(host: InboxHost = inbox): InboxService {
    return new InboxService({
        app: app as never,
        entityManager: manager,
        inbox: host,
        allowWayback: async () => {
            if (crashBeforeUpsert) {
                crashBeforeUpsert = false;
                throw new Error('simulated crash before the upsert');
            }
            return allowWayback;
        },
        notify: (n, d) => {
            if (n) notices.push(n);
            if (d) dropped.push(d);
        },
    });
}

/** The activity log as any window reads it, fresh from the (fake) main process. */
async function refreshActivity(): Promise<ExtensionActivityItem[]> {
    activity = await readExtensionActivity(inbox);
    return activity;
}

function sourcesNotes(): string[] {
    return snapshotPaths(app).filter((p) => p.startsWith(`${SOURCES_FOLDER}/`));
}

beforeEach(async () => {
    app = createTestApp();
    manager = newManager();
    await manager.initialize();
    inbox = new FakeInbox();
    inbox.app = app;
    activity = [];
    allowWayback = false;
    notices = [];
    dropped = [];
    crashBeforeUpsert = false;
});

describe('an entity from the extension', () => {
    it('is created under the schema the AI extraction uses, with exactly the extension\'s source', async () => {
        const id = inbox.add(entityBundle({ kind: 'email', value: 'Target@Example.com', context: 'Contact us at' }));
        const service = newService();
        expect(await service.start()).toBe(true);

        const [entity] = manager.getAllEntities();
        expect(entity.ftmSchema).toBe('Email');
        expect(entity.properties).toEqual({ address: 'Target@Example.com' });
        expect(entity.osint_sources).toHaveLength(1);
        expect(entity.osint_sources![0]).toEqual({
            id: `ext_${id}`,
            source_url: 'https://example.com/team',
            archive_url: undefined,
            archive_status: 'skipped',
            inferred: false,
            rationale: 'Sent from the OSINT Copilot browser extension: "Contact us at"',
            captured_at: '2026-09-18T10:00:01.000Z',
            conversation_id: undefined,
            claims: undefined,
            via: 'extension',
            client_id: CLIENT,
            received_at: '2026-09-18T10:00:01.000Z',
        });
        // And that is what the note says.
        const fm = frontmatterOf(getContent(app, entity.filePath!));
        const [stored] = fm.osint_sources as Array<Record<string, unknown>>;
        expect(stored).toMatchObject({
            via: 'extension', client_id: CLIENT, received_at: '2026-09-18T10:00:01.000Z',
            archive_status: 'skipped', inferred: false,
        });

        expect(inbox.where(id)).toBe('done');
        expect(notices).toEqual([1]);
        expect((await refreshActivity())).toHaveLength(1);
        expect((await refreshActivity())[0]).toMatchObject({
            bundleId: id, kind: 'entity', entityKind: 'email', summary: 'Target@Example.com',
            url: 'https://example.com/team', receivedAt: '2026-09-18T10:00:01.000Z', removed: false,
            outcome: { entityId: entity.id, created: true, addedSourceIds: [`ext_${id}`] },
        });
        expect((await refreshActivity())[0].outcome.sourcesNotePath).toMatch(/^OSINTCopilot\/Sources\/team-page-[0-9a-f]{12}\.md$/);
        await service.stop();
        expect(inbox.calls).toContain('release');
    });

    it('maps every kind to its schema, properties and identifier key', () => {
        const page = 'https://github.com/john';
        expect(entityTargetFor({ kind: 'phone', value: '+1 (555) 010-9999' }, page))
            .toEqual({ schema: 'Phone', properties: { number: '+1 (555) 010-9999' }, identifierKey: 'phone:+15550109999' });
        expect(entityTargetFor({ kind: 'username', value: '@John' }, page))
            .toEqual({ schema: 'Username', properties: { username: '@John', platform: 'github' }, identifierKey: 'username:github:john' });
        expect(entityTargetFor({ kind: 'username', value: 'john', platform: 'x.com' }, page)?.identifierKey).toBe('username:twitter:john');
        expect(entityTargetFor({ kind: 'domain', value: 'Example.COM' }, page))
            .toEqual({ schema: 'Domain', properties: { name: 'Example.COM' }, identifierKey: 'domain:example.com' });
        expect(entityTargetFor({ kind: 'url', value: 'https://a.example/x#frag' }, page)?.schema).toBe('Url');
        expect(entityTargetFor({ kind: 'ip', value: '10.0.0.1' }, page)?.schema).toBe('Ipv4Addr');
        expect(entityTargetFor({ kind: 'ip', value: '2001:db8::1' }, page)?.schema).toBe('Ipv6Addr');
        expect(entityTargetFor({ kind: 'wallet', chain: 'eth', value: '0xAbC0000000000000000000000000000000000001' }, page))
            .toEqual({
                schema: 'CryptoWallet',
                properties: { publicKey: '0xAbC0000000000000000000000000000000000001', currencySymbol: 'ETH' },
                identifierKey: 'wallet:eth:0xabc0000000000000000000000000000000000001',
            });
        expect(entityTargetFor({ kind: 'wallet', chain: 'other', value: 'addr_123456' }, page))
            .toEqual({ schema: 'CryptoWallet', properties: { publicKey: 'addr_123456' }, identifierKey: 'wallet:unknown:addr_123456' });
    });

    it('lands as the same kind of note the assistant writes, and wallets carry their chain', async () => {
        inbox.add(entityBundle({ kind: 'phone', value: '+1 555 010 9999' }));
        inbox.add(entityBundle({ kind: 'wallet', chain: 'btc', value: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }));
        inbox.add(entityBundle({ kind: 'url', value: 'https://evil.example/login' }));
        await newService().start();
        const byType = Object.fromEntries(manager.getAllEntities().map((e) => [String(e.type), e]));
        expect(byType.Phone.ftmSchema).toBe('LegalEntity');
        expect(byType.Phone.label).toBe('+1 555 010 9999');
        expect(byType.CryptoWallet.properties.currencySymbol).toBe('BTC');
        // Not "Url": a STIX observable is labelled by its value.
        expect(byType.Url.label).toBe('https://evil.example/login');
    });

    it('from another page appends a source to the entity already there, not a duplicate', async () => {
        const first = inbox.add(entityBundle({ kind: 'email', value: 'target@example.com' }));
        const service = newService();
        await service.start();
        const second = inbox.add(entityBundle({ kind: 'email', value: 'TARGET@example.com' }, 'https://other.example/contact', 'Contact'));
        await service.processPending();

        const entities = manager.getAllEntities();
        expect(entities).toHaveLength(1);
        expect(entities[0].osint_sources!.map((s) => s.id)).toEqual([`ext_${first}`, `ext_${second}`]);
        expect((await refreshActivity())[1].outcome).toMatchObject({ entityId: entities[0].id, created: false, addedSourceIds: [`ext_${second}`] });
        expect(activityMergeLabel(activity[1])).toBe('merged into existing target@example.com');
        expect(activityMergeLabel(activity[0])).toBeNull();
        expect(activityTypeLabel(activity[1])).toBe('Email');
        expect(notices).toEqual([1, 1]);
    });

    it('merges into an entity the assistant already extracted', async () => {
        const existing = await manager.createFTMEntity('Email', { address: 'Known@Example.com' }, { skipAutoGeocode: true });
        inbox.add(entityBundle({ kind: 'email', value: 'known@example.com' }));
        await newService().start();
        expect(manager.getAllEntities()).toHaveLength(1);
        expect((await refreshActivity())[0].outcome).toMatchObject({ entityId: existing.id, created: false });
    });

    it('keeps a GitHub "john" and a Twitter "john" as two entities', async () => {
        inbox.add(entityBundle({ kind: 'username', value: 'john' }, 'https://github.com/john', 'john (John)'));
        inbox.add(entityBundle({ kind: 'username', value: 'john' }, 'https://x.com/john', 'John on X'));
        inbox.add(entityBundle({ kind: 'username', value: '@John', platform: 'github' }, 'https://example.com/', 'Blog'));
        await newService().start();
        const accounts = manager.getAllEntities();
        expect(accounts).toHaveLength(2);
        expect(accounts.map((e) => e.properties.platform).sort()).toEqual(['github', 'twitter']);
        expect(accounts.find((e) => e.properties.platform === 'github')!.osint_sources).toHaveLength(2);
    });

    it('asks Wayback only where the investigation allows it', async () => {
        allowWayback = true;
        inbox.add(entityBundle({ kind: 'domain', value: 'example.org' }));
        await newService().start();
        const [entity] = manager.getAllEntities();
        expect(entity.osint_sources![0].archive_status).toBeUndefined();
        expect(entity.osint_sources![0].via).toBe('extension');
    });
});

describe('a note from the extension', () => {
    it('creates the page\'s Sources note, then extends it, each item between its own markers', async () => {
        const a = inbox.add(noteBundle('First observation.'));
        const service = newService();
        await service.start();
        const b = inbox.add(noteBundle('Second\nobservation.'));
        await service.processPending();

        const notes = sourcesNotes();
        expect(notes).toHaveLength(1);
        const text = getContent(app, notes[0])!;
        expect(frontmatterOf(text)).toEqual({
            source_url: 'https://example.com/team',
            normalised_url: 'https://example.com/team',
            title: 'Team page',
        });
        expect(text).toContain(`<!-- oc:bundle ${a} -->\n### Note\n`);
        expect(text).toContain('```\nFirst observation.\n```\n');
        expect(text).toContain(`\`\`\`\nSecond\nobservation.\n\`\`\`\n<!-- /oc:bundle ${b} -->\n`);
        expect(text.indexOf(a)).toBeLessThan(text.indexOf(b));
        // Not entities: the folder is reserved.
        const reloaded = newManager();
        await reloaded.initialize();
        expect(reloaded.getAllEntities()).toHaveLength(0);
        expect((await refreshActivity()).map((i) => i.summary)).toEqual(['First observation.', 'Second']);
    });

    it('keeps one note per page even when its title changes', async () => {
        inbox.add(noteBundle('one', 'https://example.com/p#top', 'Old title'));
        inbox.add(noteBundle('two', 'https://example.com/p', 'New title'));
        await newService().start();
        expect(sourcesNotes()).toHaveLength(1);
        expect(sourcesNotes()[0]).toMatch(/\/old-title-[0-9a-f]{12}\.md$/);
    });

    it('an entity also gets a line in its page\'s Sources note, linking it', async () => {
        const id = inbox.add(entityBundle({ kind: 'domain', value: 'example.org', context: 'hosted on' }));
        await newService().start();
        const [entity] = manager.getAllEntities();
        const text = getContent(app, sourcesNotes()[0])!;
        expect(text).toContain(`<!-- oc:bundle ${id} -->\n### Domain: \`example.org\`\n`);
        expect(text).toContain(`New entity: [[${entity.filePath!.replace(/\.md$/, '')}|example.org]]`);
        expect(text).toContain('```\nhosted on\n```');
    });
});

describe('applying twice, and resuming after a crash', () => {
    it('the same bundle applied twice adds nothing twice', async () => {
        const id = inbox.add(entityBundle({ kind: 'email', value: 'x@example.com' }));
        await newService().start();
        const before = snapshotPaths(app).map((p) => [p, getContent(app, p)]);
        // Main never lists a finished bundle; put it back to prove the apply itself is idempotent.
        inbox.bundles.get(id)!.where = 'pending';
        await inbox.release();
        await newService().start();
        expect(snapshotPaths(app).map((p) => [p, getContent(app, p)])).toEqual(before);
        expect((await refreshActivity())).toHaveLength(1);
        expect(manager.getAllEntities()[0].osint_sources).toHaveLength(1);
    });

    for (const crashAt of ['entity-plan', 'entity', 'sources-note', 'finish'] as const) {
        it(`a crash before journalling "${crashAt}" and a re-run add nothing twice`, async () => {
            const id = inbox.add(entityBundle({ kind: 'email', value: 'crash@example.com', context: 'ctx' }));
            if (crashAt === 'finish') inbox.crashBeforeFinish = true;
            else inbox.crashBeforeStep = crashAt;
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            await newService().start();
            expect(inbox.where(id)).toBe('pending');
            expect(notices).toEqual([]);

            // A new window: the entity store is reloaded from the notes on disk.
            await inbox.release();
            manager = newManager();
            await manager.initialize();
            await newService().start();
            warn.mockRestore();

            expect(inbox.where(id)).toBe('done');
            const entities = manager.getAllEntities();
            expect(entities).toHaveLength(1);
            expect(entities[0].osint_sources).toHaveLength(1);
            const text = getContent(app, sourcesNotes()[0])!;
            expect(text.split(`<!-- oc:bundle ${id} -->`)).toHaveLength(2);
            expect((await refreshActivity())).toHaveLength(1);
            // Created by this item, even when the re-run found the entity its first attempt made.
            expect((await refreshActivity())[0].outcome).toMatchObject({ entityId: entities[0].id, created: true, addedSourceIds: [`ext_${id}`] });
        });
    }
});

describe('whether an item created its entity, across a crash', () => {
    /** Runs the first attempt in a window that crashes, then resumes in a new one. */
    async function crashThenResume(between: () => Promise<void>) {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await newService().start();
        await inbox.release();
        manager = newManager();
        await manager.initialize();
        await between();
        await newService().start();
        warn.mockRestore();
    }

    it('an entity the user created with the same identifier after the crash is not ours, and Remove keeps it', async () => {
        const id = inbox.add(entityBundle({ kind: 'email', value: 'twin@example.com' }));
        crashBeforeUpsert = true;
        let users!: Entity;
        await crashThenResume(async () => {
            expect(manager.getAllEntities()).toHaveLength(0);
            users = await manager.createFTMEntity('Email', { address: 'twin@example.com', notes: 'mine' }, { skipAutoGeocode: true });
        });

        expect(inbox.where(id)).toBe('done');
        expect(manager.getAllEntities().map((e) => e.id)).toEqual([users.id]);
        const [item] = await refreshActivity();
        expect(item.outcome).toMatchObject({ entityId: users.id, created: false, addedSourceIds: [`ext_${id}`] });

        await newService().remove(id);
        const after = manager.getEntity(users.id)!;
        expect(after.properties).toEqual({ address: 'twin@example.com', notes: 'mine' });
        expect(after.osint_sources ?? []).toEqual([]);
        expect(getContent(app, after.filePath!)).toBeDefined();
    });

    it('an entity with the planned id is ours: resumed onto it, nothing duplicated, even beside a later twin', async () => {
        const id = inbox.add(entityBundle({ kind: 'email', value: 'ours@example.com' }));
        inbox.crashBeforeStep = 'entity';
        let twin!: Entity;
        let planned!: string;
        await crashThenResume(async () => {
            planned = (inbox.bundles.get(id)!.bundle.state!.steps.find((s) => s.step === 'entity-plan')!.data as { plannedEntityId: string }).plannedEntityId;
            expect(manager.getAllEntities().map((e) => e.id)).toEqual([planned]);
            twin = await manager.createFTMEntity('Email', { address: 'ours@example.com' }, { skipAutoGeocode: true });
        });

        expect(manager.getAllEntities()).toHaveLength(2);
        expect(manager.getEntity(planned)!.osint_sources!.map((s) => s.id)).toEqual([`ext_${id}`]);
        expect(manager.getEntity(twin.id)!.osint_sources ?? []).toEqual([]);
        const [item] = await refreshActivity();
        expect(item.outcome).toMatchObject({ entityId: planned, created: true, addedSourceIds: [`ext_${id}`] });

        await newService().remove(id);
        expect(manager.getEntity(planned)).toBeUndefined();
        expect(manager.getEntity(twin.id)).toBeDefined();
    });

    for (const [name, plan] of [
        ['from before planned ids', { existingEntityId: null }],
        ['that does not read back', 'garbage'],
        ['whose planned id is not an id', { plannedEntityId: '../x' }],
    ] as const) {
        it(`a journal ${name} counts the entity found as not created`, async () => {
            const id = inbox.add(entityBundle({ kind: 'email', value: 'legacy@example.com' }));
            // The first attempt, by older code, created this entity and crashed before
            // journalling "entity"; nothing now can prove it was the extension's.
            const earlier = await manager.createFTMEntity('Email', { address: 'legacy@example.com' }, { skipAutoGeocode: true });
            inbox.bundles.get(id)!.bundle.state = { v: 1, steps: [{ step: 'entity-plan', at: '2026-09-18T10:00:01.000Z', data: plan }] };

            await newService().start();
            expect(manager.getAllEntities().map((e) => e.id)).toEqual([earlier.id]);
            const [item] = await refreshActivity();
            expect(item.outcome).toMatchObject({ entityId: earlier.id, created: false });

            await newService().remove(id);
            expect(manager.getEntity(earlier.id)).toBeDefined();
            expect(manager.getEntity(earlier.id)!.osint_sources ?? []).toEqual([]);
        });
    }
});

describe('an "entity" step written by older code', () => {
    /** An entity the investigator made, which an old journal claims the item created. */
    async function usersEntity(address: string): Promise<Entity> {
        return manager.createFTMEntity('Email', { address, notes: 'mine' }, { skipAutoGeocode: true });
    }

    for (const [name, plan] of [
        ['before planned ids', () => ({ existingEntityId: null })],
        ['naming another planned id', () => ({ plannedEntityId: generateId() })],
        ['with no plan at all', () => undefined],
    ] as const) {
        it(`claiming "created" ${name} is not trusted when applying, and Remove keeps the entity`, async () => {
            const id = inbox.add(entityBundle({ kind: 'email', value: 'old@example.com' }));
            const users = await usersEntity('old@example.com');
            const data = plan();
            inbox.bundles.get(id)!.bundle.state = {
                v: 1,
                steps: [
                    ...(data === undefined ? [] : [{ step: 'entity-plan', at: '2026-09-18T10:00:01.000Z', data }]),
                    { step: 'entity', at: '2026-09-18T10:00:01.000Z', data: { entityId: users.id, created: true, label: users.label, addedSourceIds: [] } },
                ],
            };

            await newService().start();
            expect(inbox.where(id)).toBe('done');
            const [item] = await refreshActivity();
            expect(item.outcome).toMatchObject({ entityId: users.id, created: false });
            // The Sources note says what the journal can prove.
            expect(getContent(app, item.outcome.sourcesNotePath!)).toContain('Merged into existing entity');

            await newService().remove(id);
            expect(manager.getEntity(users.id)).toBeDefined();
            expect(manager.getEntity(users.id)!.properties).toEqual({ address: 'old@example.com', notes: 'mine' });
        });
    }

    it('claiming "created" with the plan that names that entity is trusted, and Remove deletes it', async () => {
        const id = inbox.add(entityBundle({ kind: 'email', value: 'planned@example.com' }));
        const planned = generateId();
        const ours = await manager.createFTMEntity('Email', { address: 'planned@example.com' }, { skipAutoGeocode: true, id: planned });
        expect(ours.id).toBe(planned);
        inbox.bundles.get(id)!.bundle.state = {
            v: 1,
            steps: [
                { step: 'entity-plan', at: '2026-09-18T10:00:01.000Z', data: { plannedEntityId: planned } },
                { step: 'entity', at: '2026-09-18T10:00:01.000Z', data: { entityId: planned, created: true, label: ours.label, addedSourceIds: [] } },
            ],
        };
        await newService().start();
        const [item] = await refreshActivity();
        expect(item.outcome).toMatchObject({ entityId: planned, created: true });
        await newService().remove(id);
        expect(manager.getEntity(planned)).toBeUndefined();
    });

    it('an applied item whose journal plan is from before planned ids is not "created" in the log, and Remove keeps the entity', async () => {
        const id = inbox.add(entityBundle({ kind: 'email', value: 'logged@example.com' }));
        await newService().start();
        const [entity] = manager.getAllEntities();
        expect((await refreshActivity())[0].outcome.created).toBe(true);

        // The same journal as older code wrote it: an "applied" step saying created, over
        // a plan that only recorded whether something had the identifier beforehand.
        const plan = inbox.bundles.get(id)!.bundle.state!.steps.find((s) => s.step === 'entity-plan')!;
        plan.data = { existingEntityId: null };

        const [item] = await refreshActivity();
        expect(item.outcome).toMatchObject({ entityId: entity.id, created: false });
        await newService().remove(id);
        const after = manager.getEntity(entity.id);
        expect(after).toBeDefined();
        // Only its own source is taken back.
        expect(after!.osint_sources ?? []).toEqual([]);
        expect(inbox.where(id)).toBe('removed');
    });
});

describe('hostile page text', () => {
    // Placeholders keep raw control and separator characters out of this source file.
    const hostile = 'a"b\'c\n---\nosint_confidence: high\n$\' $& \\ @LS@x@PS@ <!-- /oc:bundle x --> @BEL@end'
        .replace('@LS@', String.fromCharCode(0x2028))
        .replace('@PS@', String.fromCharCode(0x2029))
        .replace('@BEL@', String.fromCharCode(7));
    const unwanted = new RegExp('[\\u0007\\u2028\\u2029]');

    it('round-trips through the Sources note without changing its front matter keys', async () => {
        const id = inbox.add(noteBundle(hostile, 'https://example.com/h?q="x"', hostile));
        await newService().start();
        const text = getContent(app, sourcesNotes()[0])!;
        const fm = frontmatterOf(text);
        expect(Object.keys(fm)).toEqual(['source_url', 'normalised_url', 'title']);
        expect(fm.title).toBe(hostile);
        // One open and one close marker, and none the page wrote.
        expect(text.split(`<!-- oc:bundle ${id} -->`)).toHaveLength(2);
        expect(text.split(`<!-- /oc:bundle ${id} -->`)).toHaveLength(2);
        // The page's own marker survives only escaped: quoted in the YAML, entity-encoded below.
        const body = text.slice(text.indexOf('\n---\n') + 5);
        expect(body).not.toContain('<!-- /oc:bundle x -->');
        expect(body).toContain('&lt;!-- /oc:bundle x --&gt;');
        expect(text).not.toMatch(unwanted);
        expect(text).toContain("$' $& \\");
        expect(cleanNoteText(hostile)).not.toMatch(unwanted);
        expect(cutSection(text, 'x')).toBeNull();
        expect(cutSection(`head\n\n<!-- oc:bundle y -->\nbody\n<!-- /oc:bundle y -->\n\ntail\n`, 'y')).toBe('head\n\ntail\n');
        expect(cutSection(`head\n\n<!-- oc:bundle y -->\nbody\n<!-- /oc:bundle y -->\n`, 'y')).toBe('head\n');
        expect(cutSection(`---\ntitle: "<!-- oc:bundle y --> <!-- /oc:bundle y -->"\n---\n`, 'y')).toBeNull();
    });

    it('in an entity value and context, stays out of the entity\'s front matter keys', async () => {
        const value = 'a"b$\'c---\\';
        inbox.add(entityBundle({ kind: 'username', value, context: hostile }, 'https://example.com/', hostile));
        await newService().start();
        const [entity] = manager.getAllEntities();
        const fm = frontmatterOf(getContent(app, entity.filePath!));
        expect(fm.osint_confidence).not.toBe('high');
        expect(fm.label).toBe(value);
        expect((fm.osint_sources as Array<{ rationale: string }>)[0].rationale).toContain('osint_confidence: high');
        const reloaded = newManager();
        await reloaded.initialize();
        expect(reloaded.getEntity(entity.id)!.properties.username).toBe(value);
    });
});

describe('Remove', () => {
    it('of a created entity deletes it and cuts its Sources section only', async () => {
        const keep = inbox.add(noteBundle('keep me'));
        const drop = inbox.add(entityBundle({ kind: 'email', value: 'gone@example.com' }));
        const service = newService();
        await service.start();
        const [entity] = manager.getAllEntities();
        const notePath = sourcesNotes()[0];

        expect(await service.remove(drop)).toBe(true);
        expect(manager.getEntity(entity.id)).toBeUndefined();
        expect(getContent(app, entity.filePath!)).toBeUndefined();
        const text = getContent(app, notePath)!;
        expect(text).not.toContain(drop);
        expect(text).toContain(`<!-- oc:bundle ${keep} -->`);
        expect(text).toContain('```\nkeep me\n```');
        expect((await refreshActivity()).find((i) => i.bundleId === drop)).toMatchObject({ removed: true });
        expect(inbox.where(drop)).toBe('removed');
        // Twice is harmless.
        expect(await service.remove(drop)).toBe(false);
    });

    it('of a merged item removes only its source and leaves the entity and other sources intact', async () => {
        const existing = await manager.createFTMEntity('Email', { address: 'kept@example.com', notes: 'mine' }, {
            skipAutoGeocode: true,
            osint_sources: [{ source_url: 'https://mine.example/', inferred: false, rationale: 'My own finding.' }],
        });
        const a = inbox.add(entityBundle({ kind: 'email', value: 'kept@example.com' }, 'https://a.example/', 'A'));
        const b = inbox.add(entityBundle({ kind: 'email', value: 'kept@example.com' }, 'https://b.example/', 'B'));
        const service = newService();
        await service.start();
        expect(manager.getEntity(existing.id)!.osint_sources).toHaveLength(3);

        await service.remove(a);
        const entity = manager.getEntity(existing.id)!;
        expect(entity.filePath).toBe(existing.filePath);
        expect(entity.properties).toEqual({ address: 'kept@example.com', notes: 'mine' });
        expect(entity.osint_sources!.map((s) => s.source_url)).toEqual(['https://mine.example/', 'https://b.example/']);
        expect(entity.osint_confidence).toBe('medium');

        await service.remove(b);
        const after = manager.getEntity(existing.id)!;
        expect(after.osint_sources!.map((s) => s.source_url)).toEqual(['https://mine.example/']);
        expect(after.osint_confidence).toBe('low');
        const reloaded = newManager();
        await reloaded.initialize();
        expect(reloaded.getEntity(existing.id)!.osint_sources!.map((s) => s.source_url)).toEqual(['https://mine.example/']);
    });

    it('of an entity other items have since added to keeps it, minus its own source', async () => {
        const a = inbox.add(entityBundle({ kind: 'email', value: 'shared@example.com' }, 'https://a.example/', 'A'));
        const b = inbox.add(entityBundle({ kind: 'email', value: 'shared@example.com' }, 'https://b.example/', 'B'));
        const service = newService();
        await service.start();
        await service.remove(a);
        const [entity] = manager.getAllEntities();
        expect(entity.osint_sources!.map((s) => s.id)).toEqual([`ext_${b}`]);
    });
});

describe('the lease', () => {
    it('held by another window means nothing is processed', async () => {
        inbox.heldElsewhere = true;
        const id = inbox.add(entityBundle({ kind: 'email', value: 'x@example.com' }));
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        const service = newService();
        expect(await service.start()).toBe(false);
        expect(debug).toHaveBeenCalledWith(expect.stringMatching(/another window/i));
        await service.processPending();
        expect(inbox.calls).toEqual(['claim']);
        expect(inbox.where(id)).toBe('pending');
        expect(manager.getAllEntities()).toHaveLength(0);
        // Still listening, to take over later; asked again while the holder is there, it
        // stays out, and says so only once.
        expect(inbox.listeners.size).toBe(1);
        for (const l of inbox.listeners) l();
        await vi.waitFor(() => expect(inbox.calls).toEqual(['claim', 'claim']));
        expect(debug.mock.calls.filter((c) => /another window/i.test(String(c[0])))).toHaveLength(1);
        debug.mockRestore();
        await service.stop();
        expect(inbox.listeners.size).toBe(0);
        expect(inbox.calls).toEqual(['claim', 'claim']);
    });

    it('is taken over when the holder has gone and something new arrives', async () => {
        inbox.heldElsewhere = true;
        const waiting = inbox.add(noteBundle('sent while the other window held it'));
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        const service = newService();
        expect(await service.start()).toBe(false);
        debug.mockRestore();

        // The holding window closes; then the extension sends something.
        inbox.heldElsewhere = false;
        const next = inbox.add(noteBundle('and then this'));
        for (const l of inbox.listeners) l();
        await vi.waitFor(() => expect(service.active).toBe(true));
        await service.processPending();
        expect(inbox.where(waiting)).toBe('done');
        expect(inbox.where(next)).toBe('done');
        await service.stop();
    });

    it('is taken within one retry after the holder releases, with nothing new arriving; stop ends the retries', async () => {
        vi.useFakeTimers();
        try {
            inbox.heldElsewhere = true;
            const waiting = inbox.add(noteBundle('sent while the other window held it'));
            const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
            const service = newService();
            expect(await service.start()).toBe(false);
            debug.mockRestore();

            await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS);
            expect(inbox.calls).toEqual(['claim', 'claim']);
            expect(inbox.where(waiting)).toBe('pending');

            // The holder closes. No change notice: the next tick alone takes over.
            inbox.heldElsewhere = false;
            await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS);
            await vi.waitFor(() => expect(inbox.where(waiting)).toBe('done'));
            expect(service.active).toBe(true);
            // Holding now, it stops asking.
            await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS * 3);
            expect(inbox.calls.filter((c) => c === 'claim')).toHaveLength(3);
            await service.stop();

            // A window stopped while another holds the lease asks no more.
            inbox.heldElsewhere = true;
            const other = newService();
            vi.spyOn(console, 'debug').mockImplementation(() => undefined);
            expect(await other.start()).toBe(false);
            await other.stop();
            const claims = inbox.calls.filter((c) => c === 'claim').length;
            await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS * 3);
            expect(inbox.calls.filter((c) => c === 'claim')).toHaveLength(claims);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });

    it('asks again on the retry timer when the claim itself fails (main not ready yet)', async () => {
        vi.useFakeTimers();
        try {
            const waiting = inbox.add(noteBundle('sent before the window could claim'));
            let failures = 1;
            const notReady: InboxHost = {
                ...Object.fromEntries((['release', 'list', 'step', 'finish', 'markRemoved', 'listApplied', 'placeFiles', 'onChanged'] as const)
                    .map((k) => [k, (inbox[k] as (...args: unknown[]) => unknown).bind(inbox)])) as unknown as InboxHost,
                claim: () => {
                    if (failures-- > 0) {
                        inbox.calls.push('claim:threw');
                        return Promise.reject(new Error('No handler registered for osint:inbox.claim'));
                    }
                    return inbox.claim();
                },
            };
            const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
            const service = newService(notReady);
            expect(await service.start()).toBe(false);
            expect(inbox.where(waiting)).toBe('pending');

            // No change notice arrives; the timer alone gets it applied.
            await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS);
            await vi.waitFor(() => expect(inbox.where(waiting)).toBe('done'));
            expect(service.active).toBe(true);
            expect(inbox.calls.filter((c) => c.startsWith('claim'))).toEqual(['claim:threw', 'claim']);
            // Holding now, it stops asking.
            await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS * 3);
            expect(inbox.calls.filter((c) => c.startsWith('claim'))).toHaveLength(2);
            await service.stop();
            expect(vi.getTimerCount()).toBe(0);
            debug.mockRestore();
        } finally {
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });

    it('a failing claim stops being retried once the window stops', async () => {
        vi.useFakeTimers();
        try {
            let attempts = 0;
            const broken: InboxHost = {
                ...Object.fromEntries((['release', 'list', 'step', 'finish', 'markRemoved', 'listApplied', 'placeFiles', 'onChanged'] as const)
                    .map((k) => [k, (inbox[k] as (...args: unknown[]) => unknown).bind(inbox)])) as unknown as InboxHost,
                claim: () => { attempts++; return Promise.reject(new Error('not ready')); },
            };
            vi.spyOn(console, 'debug').mockImplementation(() => undefined);
            const service = newService(broken);
            expect(await service.start()).toBe(false);
            await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS * 2);
            expect(attempts).toBe(3);
            await service.stop();
            await vi.advanceTimersByTimeAsync(LEASE_RETRY_MS * 3);
            expect(attempts).toBe(3);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });

    it('stopped while its claim is in flight, gives the lease straight back', async () => {
        let grant!: () => void;
        const slow: InboxHost = {
            ...Object.fromEntries((['release', 'list', 'step', 'finish', 'markRemoved', 'listApplied', 'placeFiles', 'onChanged'] as const)
                .map((k) => [k, (inbox[k] as (...args: unknown[]) => unknown).bind(inbox)])) as unknown as InboxHost,
            claim: () => new Promise<InboxClaimResult>((resolve) => {
                grant = () => { inbox.held = true; resolve({ ok: true }); };
            }),
        };
        const service = newService(slow);
        const started = service.start();
        const stopped = service.stop();
        grant();
        expect(await started).toBe(false);
        await stopped;
        expect(inbox.held).toBe(false);
        expect(inbox.calls).toContain('release');
    });

    it('a change notice applies what arrived; after stop nothing is', async () => {
        const service = newService();
        await service.start();
        inbox.add(noteBundle('arrived later'));
        for (const l of inbox.listeners) l();
        await service.processPending();
        expect((await refreshActivity())).toHaveLength(1);
        await service.stop();
        expect(inbox.listeners.size).toBe(0);
        inbox.add(noteBundle('after stop'));
        await service.processPending();
        expect((await refreshActivity())).toHaveLength(1);
    });

    it('an item this build cannot map is dropped, and the investigator is told', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const id = inbox.add(entityBundle({ kind: 'carrier-pigeon' as never, value: 'x' }));
        inbox.add(noteBundle('fine'));
        await newService().start();
        warn.mockRestore();
        expect(inbox.where(id)).toBe('rejected');
        expect(dropped).toEqual([1]);
        expect(notices).toEqual([1]);
    });
});

describe('two windows on one investigation', () => {
    it('share one activity log: what one applies, the other sees and can Remove, and both see it removed', async () => {
        // Window A holds the lease and applies; window B shows the log and removes. Both
        // read the log from main, so neither can write a stale copy over the other's.
        const a = newService();
        expect(await a.start()).toBe(true);
        const ids = [
            inbox.add(entityBundle({ kind: 'email', value: 'one@example.com' })),
            inbox.add(entityBundle({ kind: 'email', value: 'two@example.com' })),
            inbox.add(noteBundle('three')),
        ];
        await a.processPending();

        const b = newService();
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
        inbox.heldElsewhere = true;
        expect(await b.start()).toBe(false);
        debug.mockRestore();
        expect((await readExtensionActivity(inbox)).map((i) => i.bundleId)).toEqual(ids);

        expect(await b.remove(ids[0])).toBe(true);
        expect(manager.getAllEntities().map((e) => e.label)).toEqual(['two@example.com']);
        // A, asked afterwards, reads the same state: removed, with the time main recorded.
        const seenByA = await readExtensionActivity(inbox);
        expect(seenByA.find((i) => i.bundleId === ids[0])).toMatchObject({ removed: true, removedAt: '2026-09-18T11:00:00.000Z' });
        expect(seenByA.filter((i) => !i.removed)).toHaveLength(2);
        // And A cannot remove it a second time.
        expect(await a.remove(ids[0])).toBe(false);
        await a.stop();
        await b.stop();
    });

    it('each item reads the Wayback choice as it is then, not as it was at start', async () => {
        const service = newService();
        await service.start();
        inbox.add(entityBundle({ kind: 'domain', value: 'before.example' }));
        await service.processPending();
        allowWayback = true; // changed meanwhile, e.g. in another window
        inbox.add(entityBundle({ kind: 'domain', value: 'after.example' }));
        await service.processPending();
        const byLabel = Object.fromEntries(manager.getAllEntities().map((e) => [e.label, e]));
        expect(byLabel['before.example'].osint_sources![0].archive_status).toBe('skipped');
        expect(byLabel['after.example'].osint_sources![0].archive_status).toBeUndefined();
    });
});

describe('page text in the Sources note body', () => {
    /**
     * Every link and embed Tangent's own parser marks in the note, as the editor and the
     * preview would render it: raw links and `![]()` embeds only show up here, not in
     * parseMarkdown's structure.
     */
    function linksIn(text: string): Array<{ embed: boolean; href: string }> {
        const doc = markdownToTextDocument(text);
        const out: Array<{ embed: boolean; href: string }> = [];
        for (const line of doc.lines) {
            for (const op of line.content.ops) {
                const at = op.attributes as { t_embed?: boolean; t_link?: { href?: string } } | undefined;
                if (at?.t_embed || at?.t_link) out.push({ embed: !!at.t_embed, href: String(at.t_link?.href ?? '') });
            }
        }
        return out;
    }

    const attacks = [
        '![](https://tracker.example/x.gif?case=1)',
        '![[OSINTCopilot/Entities/secret]]',
        '[[OSINTCopilot/Entities/secret]]',
        '!https://tracker.example/raw.gif',
        'https://tracker.example/alone-on-its-line.gif',
        '<img src="https://tracker.example/i.gif">',
        '`` ![](https://tracker.example/in-code.gif) ``',
        '[x](https://tracker.example/link)',
    ];

    for (const attack of attacks) {
        it(`never embeds or links ${attack}`, async () => {
            inbox.add(noteBundle(`${attack}\n${attack}`, 'https://example.com/page', attack));
            inbox.add(entityBundle({ kind: 'username', value: attack.replace(/\s/g, ''), context: attack }, 'https://example.com/page', attack));
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            await newService().start();
            warn.mockRestore();
            const text = getContent(app, sourcesNotes()[0])!;
            const body = text.slice(text.indexOf('\n---\n') + 5);
            // What the parser finds: our Source line and the one wikilink to our entity.
            const [entity] = manager.getAllEntities();
            const found = linksIn(body);
            expect(found.filter((l) => l.embed)).toEqual([]);
            // (A value no identifier key accepts is dropped instead, which is safe too.)
            const ours = new Set(['https://example.com/page', ...(entity ? [entity.filePath!.replace(/\.md$/, '')] : [])]);
            expect(found.filter((l) => !ours.has(l.href))).toEqual([]);
            expect(found.length).toBeGreaterThan(0);
            // The same parser does flag the attack when it is written raw, so the check above
            // can see one. (Inline HTML and code spans are shown as code by Tangent anyway;
            // they are here to prove a page cannot close our code span.)
            if (!/^[<`]/.test(attack)) {
                expect(linksIn(`${attack}\n`).length + parseMarkdown(attack).structure.length).toBeGreaterThan(0);
            }
            // Still readable: the page's text is there as written.
            expect(body).toContain(attack.trim().startsWith('`') ? attack.trim().slice(2, -2).trim() : attack);
        });
    }

    it('inline and block literals hold any run of backticks', () => {
        expect(inlineLiteral('a`b')).toBe('``a`b``');
        expect(inlineLiteral('`x`')).toBe('`` `x` ``');
        expect(inlineLiteral('')).toBe('');
        expect(blockLiteral('```\nnot a close\n````')).toBe('`````\n```\nnot a close\n````\n`````');
    });
});

describe('helpers', () => {
    it('slugs are [a-z0-9-], at most 60 characters', () => {
        expect(sourceSlug('Ünïcode — Title: "Quoted"!')).toBe('unicode-title-quoted');
        expect(sourceSlug('x'.repeat(80))).toHaveLength(60);
        expect(sourceSlug('a'.repeat(59) + ' b')).toBe('a'.repeat(59));
        expect(sourceSlug('!!!')).toBe('');
    });

    it('an applied step is read back defensively, and a bundle without one is not in the log', async () => {
        expect(normalizeActivityOutcome('nope')).toBeNull();
        expect(normalizeActivityOutcome({ created: 'yes', addedSourceIds: [1, 'x'] })).toEqual({
            entityId: null, entityLabel: null, created: false, addedSourceIds: ['x'], sourcesNotePath: null, placedFiles: [],
        });
        const id = inbox.add(noteBundle('half applied'));
        inbox.bundles.get(id)!.where = 'done';
        expect(await readExtensionActivity(inbox)).toEqual([]);
    });
});

describe('a capture from the extension', () => {
    const ARCHIVE = 'MIME-Version: 1.0\r\n\r\n<html>the page</html>';
    const PAGE_URL = 'https://news.example/story';

    /**
     * A committed capture as main lists it: sealed files, derived.json, and the bytes main
     * would place. `derived: null` is one still being derived.
     */
    function addCapture(opts: {
        archive?: string; title?: string; url?: string; derived?: Partial<InboxCaptureDerived> | null;
        markdown?: string | null; fullpage?: string | null;
    } = {}): string {
        const archive = opts.archive ?? ARCHIVE;
        const url = opts.url ?? PAGE_URL;
        const bundleId = inbox.add(noteBundle('placeholder', url, opts.title ?? 'Story page'));
        const entry = inbox.bundles.get(bundleId)!;
        const decl = { size: archive.length, sha256: sha(archive) };
        entry.bundle.manifest = { ...(entry.bundle.manifest as object), kind: 'capture', capture: { files: { 'page.mhtml': decl } } } as unknown as Manifest;
        delete (entry.bundle.manifest as { note?: unknown }).note;
        entry.bundle.server.files = { 'page.mhtml': decl };
        const markdown = opts.markdown === undefined ? '# The story\n\nText.' : opts.markdown;
        const fullpage = opts.fullpage === undefined ? 'PNG-full' : opts.fullpage;
        if (opts.derived !== null) {
            entry.bundle.derived = {
                v: 1, bundleId, status: markdown === null ? 'failed' : 'done', archiveSha256: decl.sha256,
                ...(markdown === null ? {} : { markdown: { file: 'page.markdown', sha256: sha(markdown) } }),
                fullpage: fullpage === null ? { error: 'not rendered' } : { file: 'fullpage.png', sha256: sha(fullpage) },
                contentLocation: url, urlMismatch: false,
                title: 'The story', errors: markdown === null ? ['markdown: the parser failed'] : [], derivedAt: '2026-09-18T10:05:00.000Z',
                ...opts.derived,
            };
        }
        const stem = `story-page-${decl.sha256.slice(0, 8)}`;
        inbox.captureFiles.set(bundleId, {
            stem,
            files: [
                { role: 'archive', ext: '.mhtml', body: archive },
                ...(fullpage === null ? [] : [{ role: 'fullpage' as const, ext: '.png', body: fullpage }]),
                ...(markdown === null ? [] : [{ role: 'markdown' as const, ext: '.md', body: markdown }]),
            ],
        });
        return bundleId;
    }

    const evidenceFiles = () => snapshotPaths(app).filter((p) => p.startsWith('OSINTCopilot/Evidence/')).sort();
    const evidenceEntities = () => manager.getAllEntities().filter((e) => String(e.type) === 'Evidence');

    it('places its files and becomes one Evidence entity with the live and archived sources', async () => {
        const id = addCapture();
        await newService().start();
        expect(inbox.where(id)).toBe('done');
        const stem = `story-page-${sha(ARCHIVE).slice(0, 8)}`;
        expect(evidenceFiles()).toEqual([`OSINTCopilot/Evidence/${stem}.md`, `OSINTCopilot/Evidence/${stem}.mhtml`, `OSINTCopilot/Evidence/${stem}.png`]);

        const [entity] = evidenceEntities();
        expect(manager.getAllEntities()).toHaveLength(1);
        expect(entity.label).toBe('Story page');
        expect(entity.properties).toMatchObject({
            name: 'Story page', url: PAGE_URL, sha256: sha(ARCHIVE), filePath: `OSINTCopilot/Evidence/${stem}.md`,
        });
        expect(entity.properties.description).toContain('captured by the OSINT Copilot browser extension');
        expect(entity.properties.description).toContain('DOM after JavaScript ran, with scripts removed: not the bytes the server sent');
        expect(entity.properties.description).not.toContain('Warning');
        const [live, archived] = entity.osint_sources!;
        expect(live).toMatchObject({
            id: `ext_${id}`, source_url: PAGE_URL, inferred: false, via: 'extension', client_id: CLIENT,
            received_at: '2026-09-18T10:00:01.000Z', captured_at: '2026-09-18T10:00:01.000Z', archive_status: 'skipped',
        });
        expect(archived).toMatchObject({
            id: `ext_${id}_archive`, source_url: `vault://OSINTCopilot/Evidence/${stem}.mhtml`, sha256: sha(ARCHIVE),
            inferred: false, via: 'extension', client_id: CLIENT, received_at: '2026-09-18T10:00:01.000Z', archive_status: 'skipped',
        });
        expect(archived.rationale).toContain(`sha256 ${sha(ARCHIVE)}`);
        expect(archived.rationale).toContain('not a record of what the server sent');

        // Keyed by the archive's bytes, and read back the same from the note on disk.
        const reloaded = newManager();
        await reloaded.initialize();
        const again = reloaded.getEntity(entity.id)!;
        expect(String(again.type)).toBe('Evidence');
        expect(again.properties.sha256).toBe(sha(ARCHIVE));
        expect(reloaded.findEntityByIdentifier('Evidence', `evidence:${sha(ARCHIVE)}`)?.id).toBe(entity.id);
        expect(again.osint_sources!.map((s) => s.id)).toEqual([`ext_${id}`, `ext_${id}_archive`]);

        const text = getContent(app, sourcesNotes()[0])!;
        expect(text).toContain(`<!-- oc:bundle ${id} -->\n### Capture: \`Story page\`\n`);
        expect(text).toContain(`New evidence: [[${entity.filePath!.replace(/\.md$/, '')}|Story page]]`);
        expect(text).toContain(`- Archive (MHTML): [[OSINTCopilot/Evidence/${stem}.mhtml|${stem}.mhtml]], sha256 \`${sha(ARCHIVE)}\``);
        expect(text).toContain(`- Full-page screenshot: [[OSINTCopilot/Evidence/${stem}.png|${stem}.png]]`);
        expect(text).toContain(`- Page text: [[OSINTCopilot/Evidence/${stem}.md|${stem}.md]]`);

        const [item] = await refreshActivity();
        expect(item).toMatchObject({ bundleId: id, kind: 'capture', summary: 'Story page', url: PAGE_URL, removed: false });
        expect(item.outcome.placedFiles.map((f) => [f.role, f.created])).toEqual([['archive', true], ['fullpage', true], ['markdown', true]]);
        expect(activityTypeLabel(item)).toBe('Page capture');
        expect(activityCaptureNotes(item)).toEqual([]);
        expect(notices).toEqual([1]);
    });

    it('a second capture of identical bytes merges into the same Evidence and places nothing new', async () => {
        const first = addCapture();
        const service = newService();
        await service.start();
        const files = evidenceFiles();
        const second = addCapture({ title: 'Story page, again' });
        await service.processPending();

        expect(evidenceEntities()).toHaveLength(1);
        expect(evidenceFiles()).toEqual(files);
        const log = await refreshActivity();
        const b = log.find((i) => i.bundleId === second)!;
        expect(b.outcome).toMatchObject({ entityId: evidenceEntities()[0].id, created: false });
        expect(b.outcome.placedFiles.every((f) => !f.created)).toBe(true);
        expect(activityMergeLabel(b)).toBe('merged into existing Story page');
        // Its own attestation of the live page; the archive's source is already there.
        expect(evidenceEntities()[0].osint_sources!.map((s) => s.id)).toEqual([`ext_${first}`, `ext_${first}_archive`, `ext_${second}`]);
        expect(getContent(app, sourcesNotes()[0])).toContain('(already in the investigation from an identical capture)');
    });

    it('still being derived, stays pending and is not placed', async () => {
        const id = addCapture({ derived: null });
        const note = inbox.add(noteBundle('Beside it'));
        await newService().start();
        expect(inbox.where(id)).toBe('pending');
        expect(inbox.calls).not.toContain('placeFiles');
        expect(inbox.calls).not.toContain('finish:rejected');
        expect(inbox.bundles.get(id)!.bundle.state).toBeNull();
        expect(inbox.where(note)).toBe('done');
        expect(notices).toEqual([1]);
        expect(evidenceFiles()).toEqual([]);
    });

    it('whose derivation failed still applies, with the archive as its file, and says so', async () => {
        const id = addCapture({ markdown: null, fullpage: null });
        await newService().start();
        expect(inbox.where(id)).toBe('done');
        const [entity] = evidenceEntities();
        expect(entity.properties.filePath).toMatch(/\.mhtml$/);
        expect(entity.properties.description).toContain('No readable text could be made from the archive (markdown: the parser failed)');
        expect(evidenceFiles()).toHaveLength(1);
        const [item] = await refreshActivity();
        expect(item.derivationFailed).toBe(true);
        expect(activityCaptureNotes(item)).toEqual(['No readable text could be made from the archive; the archive itself was kept.']);
        expect(getContent(app, sourcesNotes()[0])).toContain('Warning: `No readable text could be made');
    });

    it('whose archive is of another page says so on the entity, in the Sources note and in the log', async () => {
        addCapture({ derived: { urlMismatch: true, contentLocation: 'https://elsewhere.example/other' } });
        const none = addCapture({ archive: 'another archive', derived: { urlMismatch: true, contentLocation: null } });
        await newService().start();
        const byUrl = evidenceEntities().map((e) => String(e.properties.description));
        expect(byUrl.some((d) => d.includes(`Warning: The archive records its address as https://elsewhere.example/other, not ${PAGE_URL}`))).toBe(true);
        expect(byUrl.some((d) => d.includes('Warning: The archive does not record its address'))).toBe(true);
        const text = getContent(app, sourcesNotes()[0])!;
        expect(text).toContain('Warning: `The archive records its address as https://elsewhere.example/other');
        const log = await refreshActivity();
        expect(log.map(activityCaptureNotes)).toEqual([
            ["The archive's own address differs: https://elsewhere.example/other"],
            ['The archive does not record its address.'],
        ]);
        expect(log.find((i) => i.bundleId === none)!.urlMismatch).toBe(true);
    });

    for (const crashAt of ['place', 'entity-plan', 'entity', 'sources-note', 'finish'] as const) {
        it(`a crash before journalling "${crashAt}" and a re-run add nothing twice`, async () => {
            const id = addCapture();
            if (crashAt === 'finish') inbox.crashBeforeFinish = true;
            else inbox.crashBeforeStep = crashAt;
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            await newService().start();
            expect(inbox.where(id)).toBe('pending');
            const placedBefore = evidenceFiles();
            expect(placedBefore).toHaveLength(3);

            await inbox.release();
            manager = newManager();
            await manager.initialize();
            await newService().start();
            warn.mockRestore();

            expect(inbox.where(id)).toBe('done');
            expect(evidenceFiles()).toEqual(placedBefore);
            expect(evidenceEntities()).toHaveLength(1);
            expect(evidenceEntities()[0].osint_sources).toHaveLength(2);
            expect(getContent(app, sourcesNotes()[0])!.split(`<!-- oc:bundle ${id} -->`)).toHaveLength(2);
            const [item] = await refreshActivity();
            // Still this item's files and entity, so Remove still takes them back.
            expect(item.outcome.created).toBe(true);
            expect(item.outcome.placedFiles.every((f) => f.created)).toBe(true);
            // Asked again on the re-run, never taken from the journal; it found its own files.
            expect(inbox.calls.filter((c) => c === 'placeFiles')).toHaveLength(2);
        });
    }

    it('Remove trashes only the files this item created, deletes its entity and cuts its section', async () => {
        const keepNote = inbox.add(noteBundle('keep me', PAGE_URL, 'Story page'));
        const drop = addCapture();
        const other = addCapture({ archive: 'a different archive', markdown: '# other', fullpage: 'PNG-other' });
        const service = newService();
        await service.start();
        const dropped = (await refreshActivity()).find((i) => i.bundleId === drop)!;
        const otherItem = activity.find((i) => i.bundleId === other)!;
        expect(evidenceFiles()).toHaveLength(6);

        expect(await service.remove(drop)).toBe(true);
        expect(manager.getEntity(dropped.outcome.entityId!)).toBeUndefined();
        expect(evidenceFiles()).toEqual(otherItem.outcome.placedFiles.map((f) => f.path).sort());
        const text = getContent(app, sourcesNotes()[0])!;
        expect(text).not.toContain(drop);
        expect(text).toContain(`<!-- oc:bundle ${keepNote} -->`);
        expect(text).toContain(`<!-- oc:bundle ${other} -->`);
        expect(inbox.where(drop)).toBe('removed');
        expect(manager.getEntity(otherItem.outcome.entityId!)).toBeDefined();
    });

    it('Remove keeps a file it only reused, and files another capture still relies on', async () => {
        // Already there, same bytes, from before this capture (say, an earlier build).
        const stem = `story-page-${sha(ARCHIVE).slice(0, 8)}`;
        await ensureFolder('OSINTCopilot/Evidence');
        await app.vault.create(`OSINTCopilot/Evidence/${stem}.png`, 'PNG-full');
        const first = addCapture();
        const service = newService();
        await service.start();
        const [item] = await refreshActivity();
        expect(item.outcome.placedFiles.map((f) => [f.role, f.created])).toEqual([['archive', true], ['fullpage', false], ['markdown', true]]);

        const second = addCapture();
        await service.processPending();
        // The first goes; the second still has the archive and text it reused.
        await service.remove(first);
        expect(evidenceFiles()).toEqual([`OSINTCopilot/Evidence/${stem}.md`, `OSINTCopilot/Evidence/${stem}.mhtml`, `OSINTCopilot/Evidence/${stem}.png`]);
        const [entity] = evidenceEntities();
        expect(entity.osint_sources!.map((s) => s.id)).toEqual([`ext_${second}`]);
        // The second created nothing, so removing it trashes nothing either.
        await service.remove(second);
        expect(evidenceFiles()).toHaveLength(3);
    });

    it('a pending capture that reused files a Remove then trashed places them again as its own', async () => {
        const first = addCapture();
        const service = newService();
        await service.start();
        const files = evidenceFiles();
        expect(files).toHaveLength(3);

        // The identical capture is placed (reusing every file) and journals it, then dies
        // before its entity: it stays pending with a placement that owns nothing.
        const second = addCapture();
        crashBeforeUpsert = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await service.processPending();
        expect(inbox.where(second)).toBe('pending');
        const journaled = inbox.bundles.get(second)!.bundle.state!.steps.find((s) => s.step === 'place')!.data as InboxPlacement;
        expect(journaled.files.every((f) => !f.created)).toBe(true);

        // Removing the first trashes the files it made: nothing applied still names them.
        await service.remove(first);
        expect(evidenceFiles()).toEqual([]);

        await service.processPending();
        warn.mockRestore();
        expect(inbox.where(second)).toBe('done');
        // Its entity and Sources lines point at files that are really there, and are its own.
        expect(evidenceFiles()).toEqual(files);
        const [entity] = evidenceEntities();
        expect(files).toContain(entity.properties.filePath);
        for (const s of entity.osint_sources!) {
            if (s.source_url.startsWith('vault://')) expect(files).toContain(s.source_url.slice('vault://'.length));
        }
        const item = (await refreshActivity()).find((i) => i.bundleId === second)!;
        expect(item.outcome.placedFiles.every((f) => f.created)).toBe(true);
        await service.remove(second);
        expect(evidenceFiles()).toEqual([]);
    });

    it('a hostile title cannot make the Evidence note or the Sources note embed anything', async () => {
        const title = '![](https://tracker.example/t.gif) !https://tracker.example/u.gif';
        addCapture({ title });
        await newService().start();
        const [entity] = evidenceEntities();
        for (const path of [entity.filePath!, sourcesNotes()[0]]) {
            const doc = markdownToTextDocument(getContent(app, path)!.replace(/^---\n[\s\S]*?\n---\n/, ''));
            const embeds = doc.lines.flatMap((l) => l.content.ops).filter((op) => (op.attributes as { t_embed?: boolean } | undefined)?.t_embed);
            expect(embeds, path).toEqual([]);
        }
        // Still reads as the page's title.
        expect(String(entity.properties.name).replace(/​/g, '')).toBe(title);
    });
});

describe('highlights from the extension', () => {
    const PAGE = 'https://example.com/article';
    const ID = 'urn:uuid:5f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f60';

    function annotation(exact: string, modified: string, note?: string, id = ID) {
        return {
            id,
            textModel: 'v1' as const,
            created: '2026-09-18T09:00:00.000Z',
            modified,
            target: {
                source: PAGE,
                selector: [
                    { type: 'TextQuoteSelector' as const, exact, prefix: '', suffix: '' },
                    { type: 'TextPositionSelector' as const, start: 0, end: exact.length },
                ],
            },
            ...(note ? { body: { type: 'TextualBody' as const, purpose: 'commenting' as const, value: note } } : {}),
        };
    }
    const hl = (kind: 'highlight' | 'highlight.update', a: ReturnType<typeof annotation>) =>
        ({ kind, page: { url: PAGE, title: 'An article' }, highlight: { annotation: a } });
    const del = (modified: string, id = ID) =>
        ({ kind: 'highlight.delete', page: { url: PAGE, title: 'An article' }, highlight: { annotationId: id, modified } });

    function note(): string {
        const [path] = sourcesNotes().filter((p) => p.endsWith('.md'));
        return getContent(app, path)!;
    }
    function sidecar() {
        const [path] = sourcesNotes().filter((p) => p.endsWith('.md'));
        return parseSidecar(getContent(app, sidecarPathFor(path)) ?? '');
    }
    const sections = (text: string) => (text.match(/^<!-- oc:bundle [^ ]+ -->$/gm) ?? []).length;

    it('files the quote and note in the page\'s Sources note, and the selectors beside it', async () => {
        const id = inbox.add(hl('highlight', annotation('the quick brown fox', '2026-09-18T09:00:00.000Z', 'says who?')));
        await newService().start();
        const text = note();
        expect(sections(text)).toBe(1);
        expect(text).toContain('### Highlight');
        expect(text).toContain('the quick brown fox');
        expect(text).toContain('says who?');
        const record = sidecar()!.highlights[ID];
        expect(record.deleted).toBe(false);
        expect(record.section).toBe(id);
        expect(record.annotation!.target.selector[0].exact).toBe('the quick brown fox');
        const [item] = await refreshActivity();
        expect(item).toMatchObject({ kind: 'highlight', annotationId: ID, summary: 'the quick brown fox' });
        expect(notices).toEqual([1]);
    });

    it('an edit rewrites the highlight\'s one section, quietly, and lists nothing new', async () => {
        inbox.add(hl('highlight', annotation('quote', '2026-09-18T09:00:00.000Z', 'first thought')));
        await newService().start();
        inbox.add(hl('highlight.update', annotation('quote', '2026-09-18T09:05:00.000Z', 'second thought')));
        await newService().start();
        const text = note();
        expect(sections(text)).toBe(1);
        expect(text).toContain('second thought');
        expect(text).not.toContain('first thought');
        expect(text).toMatch(/Edited /);
        expect(await refreshActivity()).toHaveLength(1);
        // The edit is applied, but not announced as an item added.
        expect(notices).toEqual([1]);
    });

    it('an edit older than what the investigation holds changes nothing', async () => {
        inbox.add(hl('highlight', annotation('quote', '2026-09-18T09:00:00.000Z', 'newest')));
        inbox.add(hl('highlight.update', annotation('quote', '2026-09-18T08:00:00.000Z', 'stale')));
        await newService().start();
        expect(note()).toContain('newest');
        expect(note()).not.toContain('stale');
    });

    it('a delete cuts the section and leaves a tombstone that a late create cannot get past', async () => {
        inbox.add(hl('highlight', annotation('quote', '2026-09-18T09:00:00.000Z')));
        await newService().start();
        inbox.add(del('2026-09-18T09:10:00.000Z'));
        await newService().start();
        expect(sections(note())).toBe(0);
        expect(sidecar()!.highlights[ID]).toMatchObject({ deleted: true });
        // The extension retried an edit it had queued before the delete.
        inbox.add(hl('highlight.update', annotation('quote', '2026-09-18T09:09:00.000Z', 'queued before the delete')));
        await newService().start();
        expect(sections(note())).toBe(0);
        expect(note()).not.toContain('queued before the delete');
    });

    it('an edit that arrives before its create files the highlight once, and the create changes nothing', async () => {
        const editId = inbox.add(hl('highlight.update', annotation('quote', '2026-09-18T09:05:00.000Z', 'edited')));
        const createId = inbox.add(hl('highlight', annotation('quote', '2026-09-18T09:00:00.000Z')));
        await newService().start();
        expect(sections(note())).toBe(1);
        expect(note()).toContain('edited');
        expect(sidecar()!.highlights[ID].section).toBe(editId);
        // Remove on the create item takes out the section the edit wrote.
        const [item] = await refreshActivity();
        expect(item.bundleId).toBe(createId);
        expect(await newService().remove(createId)).toBe(true);
        expect(sections(note())).toBe(0);
        expect(sidecar()!.highlights[ID].deleted).toBe(true);
    });

    it('Remove takes the highlight out; an edit made later in the browser brings it back', async () => {
        const id = inbox.add(hl('highlight', annotation('quote', '2026-09-18T09:00:00.000Z')));
        const service = newService();
        await service.start();
        expect(await service.remove(id)).toBe(true);
        expect(sections(note())).toBe(0);
        expect((await refreshActivity())[0].removed).toBe(true);
        inbox.add(hl('highlight.update', annotation('quote', new Date(Date.now() + 60_000).toISOString(), 'changed my mind')));
        await service.processPending();
        expect(sections(note())).toBe(1);
        expect(note()).toContain('changed my mind');
    });

    it('applying twice, or again after a crash before the journal, files the highlight once', async () => {
        inbox.add(hl('highlight', annotation('quote', '2026-09-18T09:00:00.000Z')));
        inbox.crashBeforeStep = 'highlight';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await newService().start();
        warn.mockRestore();
        await newService().start();
        expect(sections(note())).toBe(1);
        expect(Object.keys(sidecar()!.highlights)).toEqual([ID]);
    });

    it('shows a hostile quote inert, and keeps it exactly in the sidecar', async () => {
        const exact = `![](https://tracker.example/x.gif)\n<!-- /oc:bundle x -->\n![[secret]]‮gnp.exe`;
        inbox.add(hl('highlight', annotation(exact, '2026-09-18T09:00:00.000Z', '![](https://tracker.example/note.gif)')));
        await newService().start();
        const text = note();
        const body = text.slice(text.indexOf('\n---\n') + 5);
        const doc = markdownToTextDocument(body);
        const embeds = doc.lines.flatMap((l) => l.content.ops).filter((op) => (op.attributes as { t_embed?: boolean } | undefined)?.t_embed);
        expect(embeds).toEqual([]);
        // The page's comment markers cannot close a section of ours...
        expect(body).not.toContain('<!-- /oc:bundle x -->');
        // ...the bidi override is gone from what is shown...
        expect(body).not.toContain('‮');
        // ...and the record keeps the quote as the page had it, for finding it again.
        expect(sidecar()!.highlights[ID].annotation!.target.selector[0].exact).toBe(exact);
    });

    it('sets aside a sidecar it cannot read, rather than writing over it', async () => {
        inbox.add(hl('highlight', annotation('first', '2026-09-18T09:00:00.000Z')));
        await newService().start();
        const [md] = sourcesNotes().filter((p) => p.endsWith('.md'));
        const file = app.vault.getAbstractFileByPath(sidecarPathFor(md));
        await app.vault.modify(file as never, '{not json');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        inbox.add(hl('highlight', annotation('second', '2026-09-18T09:00:00.000Z', undefined, 'urn:uuid:6f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f61')));
        await newService().start();
        warn.mockRestore();
        expect(sourcesNotes().some((p) => /\.unreadable-\d+\.json$/.test(p))).toBe(true);
        expect(Object.keys(sidecar()!.highlights)).toEqual(['urn:uuid:6f0c6a2e-8b1d-4c3e-9f7a-1b2c3d4e5f61']);
    });
});
