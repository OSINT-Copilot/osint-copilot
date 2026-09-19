import { App, Notice, Vault, normalizePath } from 'obsidian';
import { ftmSchemaService, type FTMSchemaDefinition } from './ftm-schema-service';
import { CUSTOM_TYPES_CONFIG_DIR, CUSTOM_TYPES_FILE_NAME } from '../constants/vault-layout';
import { ensureFolderChain } from '../utils/vault-bootstrap-fs';
import type { SchemaCatalogService } from './schema-catalog-service';

/** JSON-backed FTM extensions. Non-FTM families use YAML under OSINTCopilot/schemas/ (see schema catalog). */

export interface CustomTypeConfig {
    schemas: Partial<FTMSchemaDefinition>[];
}

export class CustomTypesService {
    private app: App;
    private vault: Vault;
    private customSchemas: Map<string, Partial<FTMSchemaDefinition>> = new Map();
    private schemaCatalog: SchemaCatalogService | null = null;

    constructor(app: App) {
        this.app = app;
        this.vault = app.vault;
    }

    /**
     * Wired from plugin after SchemaCatalogService is constructed. The type pickers read
     * the catalog, not ftmSchemaService, and the catalog is a snapshot; its vault watcher
     * does not cover custom-types.json.
     */
    setSchemaCatalogService(catalog: SchemaCatalogService | null): void {
        this.schemaCatalog = catalog;
    }

    /** Rebuilds the catalog so a picker reopened after a save lists the change. */
    private async refreshCatalog(): Promise<void> {
        try {
            await this.schemaCatalog?.rebuild();
        } catch (e) {
            // The type is saved either way; a stale picker is not worth failing the save for.
            console.warn('[CustomTypesService] Schema catalog rebuild failed:', e);
        }
    }

    async initialize(): Promise<void> {
        await this.ensureConfigDir();
        await this.loadCustomTypes();
    }

    private async ensureConfigDir(): Promise<void> {
        try {
            await ensureFolderChain(this.app, normalizePath(CUSTOM_TYPES_CONFIG_DIR));
        } catch (error) {
            console.error('[CustomTypesService] Failed to create config folder:', error);
        }
    }

    private async loadCustomTypes(): Promise<void> {
        const configPath = `${CUSTOM_TYPES_CONFIG_DIR}/${CUSTOM_TYPES_FILE_NAME}`;
        if (await this.vault.adapter.exists(configPath)) {
            try {
                const content = await this.vault.adapter.read(configPath);
                const config: CustomTypeConfig = JSON.parse(content);

                this.customSchemas.clear();
                if (config.schemas && Array.isArray(config.schemas)) {
                    for (const schema of config.schemas) {
                        if (schema.name) {
                            this.customSchemas.set(schema.name, schema);
                            // Register with FTMSchemaService
                            ftmSchemaService.registerSchema(schema);
                        }
                    }
                }
                console.debug(`[CustomTypesService] Loaded ${this.customSchemas.size} custom entity types.`);
            } catch (e) {
                console.error('[CustomTypesService] Failed to load custom types:', e);
                new Notice('Failed to load custom entity types config.');
            }
        }
    }

    async saveCustomTypes(): Promise<void> {
        await this.ensureConfigDir();
        const configPath = `${CUSTOM_TYPES_CONFIG_DIR}/${CUSTOM_TYPES_FILE_NAME}`;
        const config: CustomTypeConfig = {
            schemas: Array.from(this.customSchemas.values())
        };

        try {
            await this.vault.adapter.write(configPath, JSON.stringify(config, null, 2));
        } catch (e) {
            console.error('[CustomTypesService] Failed to save custom types:', e);
            new Notice('Failed to save custom entity types config.');
        }
    }

    async addCustomType(schema: Partial<FTMSchemaDefinition>): Promise<void> {
        if (!schema.name) throw new Error('Schema name is required');

        this.customSchemas.set(schema.name, schema);
        ftmSchemaService.registerSchema(schema);
        await this.saveCustomTypes();
        await this.refreshCatalog();
        new Notice(`Custom entity type '${schema.label}' added.`);
    }

    async deleteCustomType(name: string): Promise<void> {
        if (this.customSchemas.delete(name)) {
            // Drop it from the live registry too, so the type disappears from pickers
            // immediately instead of lingering until the next restart.
            ftmSchemaService.unregisterSchema(name);
            await this.saveCustomTypes();
            await this.refreshCatalog();
            new Notice(`Custom entity type '${name}' removed.`);
        }
    }

    getCustomSchema(name: string): Partial<FTMSchemaDefinition> | undefined {
        return this.customSchemas.get(name);
    }
}
