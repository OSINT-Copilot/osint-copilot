import { describe, it, expect, afterEach } from 'vitest';
import { CustomTypesService } from '../services/custom-types-service';
import { SchemaCatalogService } from '../services/schema-catalog-service';
import { ftmSchemaService } from '../services/ftm-schema-service';
import { DEFAULT_ENABLED_SCHEMA_FAMILIES, DEFAULT_OIDSF_MODAL_LAYERS } from '../services/schema-catalog-types';
import { createTestAppAsync } from '../obsidian-shim/testing/create-test-app';

/**
 * The entity and connection type pickers read the schema catalog, a snapshot. A custom
 * type saved from a picker used to be missing from it when the picker reopened, and a
 * deleted one stayed listed, until the app restarted.
 */

afterEach(() => {
    ftmSchemaService.unregisterSchema('TestNominee');
    ftmSchemaService.unregisterSchema('TestShell');
});

describe('custom types and the schema catalog', () => {
    it('lists a saved custom type as soon as the save resolves, and drops a deleted one', async () => {
        const app = await createTestAppAsync();
        const catalog = new SchemaCatalogService(app as never);
        await catalog.rebuild();
        const svc = new CustomTypesService(app as never);
        await svc.initialize();
        svc.setSchemaCatalogService(catalog);

        const relationshipNames = () =>
            catalog.listRelationshipTypes(DEFAULT_ENABLED_SCHEMA_FAMILIES, DEFAULT_OIDSF_MODAL_LAYERS).map((t) => t.name);
        const entityNames = () =>
            catalog.listEntityTypes(DEFAULT_ENABLED_SCHEMA_FAMILIES, DEFAULT_OIDSF_MODAL_LAYERS).map((t) => t.name);

        await svc.addCustomType({ name: 'TestNominee', label: 'Nominee', extends: ['Interval'], properties: {} });
        await svc.addCustomType({ name: 'TestShell', label: 'Shell', extends: ['Thing'], properties: {} });

        expect(relationshipNames()).toContain('TestNominee');
        expect(entityNames()).toContain('TestShell');

        await svc.deleteCustomType('TestNominee');
        await svc.deleteCustomType('TestShell');

        expect(relationshipNames()).not.toContain('TestNominee');
        expect(entityNames()).not.toContain('TestShell');
    });
});
