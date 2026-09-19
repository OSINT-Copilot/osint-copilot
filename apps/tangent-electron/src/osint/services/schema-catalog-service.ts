/**
 * Unified schema catalog: FTM (bundled + custom registrations) + vault YAML (STIX2, MITRE, user).
 */

import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { ftmSchemaService, type FTMPropertyDefinition } from './ftm-schema-service';
import { canonicalSchemaName } from './schema-name-aliases';
import { getEntityColor } from '../entities/types';
import {
	parseEntityYaml,
	parseRelationshipYaml,
	yamlEntityToCatalog,
	yamlRelationshipToCatalog,
	parseCombinedSchemaYaml,
} from './schema-definition-loader';
import type {
	CatalogEntityType,
	CatalogRelationshipType,
	EnabledSchemaFamilies,
	OIDSFModalLayers,
	SchemaFamily,
} from './schema-catalog-types';
import { DEFAULT_ENABLED_SCHEMA_FAMILIES } from './schema-catalog-types';
import { OSINT_COPILOT_VAULT_ROOT } from '../constants/vault-layout';

function ftmPropsToCatalog(
	all: Record<string, FTMPropertyDefinition>,
): Record<string, { label: string; type?: string; description?: string }> {
	const out: Record<string, { label: string; type?: string; description?: string }> = {};
	for (const [k, v] of Object.entries(all)) {
		out[k] = { label: v.label, type: v.type, description: v.description };
	}
	return out;
}

export class SchemaCatalogService {
	private app: App;
	private entities = new Map<string, CatalogEntityType>();
	private relationships = new Map<string, CatalogRelationshipType>();
	private rebuildQueue: Promise<void> = Promise.resolve();

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Full rebuild: FTM from service + vault YAML.
	 *
	 * Rebuilds run while a type picker is open (a custom type saved from it), so the new
	 * catalog is built aside and swapped in whole: a picker reading mid-rebuild sees the
	 * old catalog, not the FTM types alone. They also run one at a time, so an older
	 * rebuild that finishes late cannot swap in a snapshot taken before a newer change.
	 */
	rebuild(): Promise<void> {
		const run = this.rebuildQueue.then(async () => {
			const next = new SchemaCatalogService(this.app);
			await next.load();
			this.entities = next.entities;
			this.relationships = next.relationships;
		});
		this.rebuildQueue = run.catch(() => undefined);
		return run;
	}

	private async load(): Promise<void> {
		this.registerFtmEntities();
		this.registerFtmRelationships();
		await this.loadVaultStix2();
		await this.loadVaultMitre();
		await this.loadVaultUser();
	}

	private registerFtmEntities(): void {
		ftmSchemaService.initialize();
		for (const sch of ftmSchemaService.getEntitySchemas()) {
			const key = `ftm:${sch.name}`;
			this.entities.set(key, {
				family: 'ftm',
				name: sch.name,
				label: sch.label,
				plural: sch.plural,
				description: sch.description,
				color: sch.color || '#607D8B',
				labelField: ftmSchemaService.getLabelField(sch.name),
				required: [...sch.required],
				featured: [...sch.featured],
				properties: ftmPropsToCatalog(sch.allProperties),
			});
		}
	}

	private registerFtmRelationships(): void {
		ftmSchemaService.initialize();
		const skip = new Set(['Associate', 'UnknownLink', 'Membership']);
		for (const sch of ftmSchemaService.getIntervalSchemas()) {
			if (skip.has(sch.name)) continue;
			const key = `ftm:${sch.name}`;
			this.relationships.set(key, {
				family: 'ftm',
				name: sch.name,
				label: sch.label,
				description: sch.description,
				color: sch.color || '#607D8B',
				featured: [...sch.featured],
				required: [...sch.required],
				properties: ftmPropsToCatalog(sch.allProperties),
			});
		}
	}

	private async loadVaultStix2(): Promise<void> {
		const base = normalizePath(`${OSINT_COPILOT_VAULT_ROOT}/schemas/stix2`);
		await this.loadEntityYamlFile(`${base}/entities.yaml`, 'stix2');
		await this.loadRelationshipYamlFile(`${base}/relationships.yaml`, 'stix2');
	}

	private async loadVaultMitre(): Promise<void> {
		const base = normalizePath(`${OSINT_COPILOT_VAULT_ROOT}/schemas/mitre`);
		await this.loadEntityYamlFile(`${base}/entities.yaml`, 'mitre');
		await this.loadRelationshipYamlFile(`${base}/relationships.yaml`, 'mitre');
	}

	private async loadEntityYamlFile(path: string, expectedFamily: SchemaFamily): Promise<void> {
		try {
			if (!(await this.app.vault.adapter.exists(path))) return;
			const content = await this.app.vault.adapter.read(path);
			const parsed = parseEntityYaml(content);
			if (parsed.family !== expectedFamily) {
				console.warn(`[SchemaCatalog] ${path}: family mismatch`);
				return;
			}
			for (const raw of parsed.entityTypes) {
				const cat = yamlEntityToCatalog(raw, parsed.family);
				this.entities.set(`${cat.family}:${cat.name}`, cat);
			}
		} catch (e) {
			console.error(`[SchemaCatalog] Failed to load ${path}:`, e);
		}
	}

	private async loadRelationshipYamlFile(path: string, expectedFamily: SchemaFamily): Promise<void> {
		try {
			if (!(await this.app.vault.adapter.exists(path))) return;
			const content = await this.app.vault.adapter.read(path);
			const parsed = parseRelationshipYaml(content);
			if (parsed.family !== expectedFamily) {
				console.warn(`[SchemaCatalog] ${path}: family mismatch`);
				return;
			}
			for (const raw of parsed.relationshipTypes) {
				const cat = yamlRelationshipToCatalog(raw, parsed.family);
				this.relationships.set(`${parsed.family}:${raw.name}`, cat);
			}
		} catch (e) {
			console.error(`[SchemaCatalog] Failed to load ${path}:`, e);
		}
	}

	private async loadVaultUser(): Promise<void> {
		const dir = normalizePath(`${OSINT_COPILOT_VAULT_ROOT}/schemas/user`);
		const folder = this.app.vault.getAbstractFileByPath(dir);
		if (!folder || !(folder instanceof TFolder)) return;

		for (const child of folder.children) {
			if (!(child instanceof TFile)) continue;
			const lower = child.name.toLowerCase();
			if (!lower.endsWith('.yaml') && !lower.endsWith('.yml')) continue;
			if (child.name === 'example-user-types.yaml') continue;
			try {
				const content = await this.app.vault.read(child);
				this.ingestUserYaml(content, child.path);
			} catch (e) {
				console.error(`[SchemaCatalog] Failed to read ${child.path}:`, e);
			}
		}
	}

	private ingestUserYaml(content: string, path: string): void {
		try {
			const combined = parseCombinedSchemaYaml(content);
			if (combined.family !== 'user') {
				console.warn(`[SchemaCatalog] ${path}: user folder files should use family: user`);
				return;
			}
			for (const e of combined.entityTypes) {
				this.entities.set(`user:${e.name}`, e);
			}
			for (const r of combined.relationshipTypes) {
				this.relationships.set(`user:${r.name}`, r);
			}
		} catch {
			// try entity-only or relationship-only
			try {
				const ent = parseEntityYaml(content);
				if (ent.family !== 'user') return;
				for (const raw of ent.entityTypes) {
					const cat = yamlEntityToCatalog(raw, 'user');
					this.entities.set(`user:${cat.name}`, cat);
				}
			} catch {
				try {
					const rel = parseRelationshipYaml(content);
					if (rel.family !== 'user') return;
					for (const raw of rel.relationshipTypes) {
						const cat = yamlRelationshipToCatalog(raw, 'user');
						this.relationships.set(`user:${raw.name}`, cat);
					}
				} catch (e2) {
					console.error(`[SchemaCatalog] Could not parse ${path}:`, e2);
				}
			}
		}
	}

	listEntityTypes(enabled: EnabledSchemaFamilies, modalLayers?: OIDSFModalLayers): CatalogEntityType[] {
		const list: CatalogEntityType[] = [];
		for (const [, v] of this.entities) {
			if (!this.isFamilyEnabled(v.family, enabled)) continue;
			if (v.family === 'ftm' && modalLayers) {
				if (ftmSchemaService.isIntervalSchemaName(v.name)) continue;
				if (!ftmSchemaService.schemaPassesModalLayer(v.name, modalLayers)) continue;
			}
			list.push(v);
		}
		return list.sort((a, b) => {
			const fa = a.family.localeCompare(b.family);
			if (fa !== 0) return fa;
			return a.label.localeCompare(b.label);
		});
	}

	listRelationshipTypes(enabled: EnabledSchemaFamilies, modalLayers?: OIDSFModalLayers): CatalogRelationshipType[] {
		const list: CatalogRelationshipType[] = [];
		for (const [, v] of this.relationships) {
			if (!this.isFamilyEnabled(v.family, enabled)) continue;
			if (v.family === 'ftm' && modalLayers && !modalLayers.links) continue;
			list.push(v);
		}
		return list.sort((a, b) => {
			const fa = a.family.localeCompare(b.family);
			if (fa !== 0) return fa;
			return a.label.localeCompare(b.label);
		});
	}

	private isFamilyEnabled(family: SchemaFamily, enabled: EnabledSchemaFamilies): boolean {
		switch (family) {
			case 'ftm':
				return enabled.ftm;
			case 'stix2':
				return enabled.stix2;
			case 'mitre':
				return enabled.mitre;
			case 'user':
				return enabled.user;
			default:
				return true;
		}
	}

	getEntityType(family: SchemaFamily, name: string): CatalogEntityType | undefined {
		const n = family === 'ftm' ? canonicalSchemaName(name) : name;
		return this.entities.get(`${family}:${n}`);
	}

	/** Display label for an entity instance (uses labelField from catalog when not FTM). */
	getInstanceLabel(entity: {
		schemaFamily?: SchemaFamily;
		type: string;
		ftmSchema?: string;
		label: string;
		properties: Record<string, unknown>;
	}): string {
		const family = entity.schemaFamily ?? 'ftm';
		const typeName = family === 'ftm' && entity.ftmSchema ? entity.ftmSchema : String(entity.type);
		if (family === 'ftm' && ftmSchemaService.hasSchema(typeName)) {
			return ftmSchemaService.getEntityLabel(typeName, entity.properties);
		}
		const cat = this.getEntityType(family, typeName);
		if (cat) {
			const v = entity.properties[cat.labelField];
			if (v !== undefined && v !== null && String(v).trim() !== '') {
				return String(v);
			}
		}
		return entity.label || typeName;
	}

	/** Node color for graph view (catalog when available). */
	getEntityVisualForGraph(entity: {
		schemaFamily?: SchemaFamily;
		type: string;
		ftmSchema?: string;
	}): { color: string } {
		const family = entity.schemaFamily ?? 'ftm';
		const typeName = family === 'ftm' && entity.ftmSchema ? entity.ftmSchema : String(entity.type);
		const cat = this.getEntityType(family, typeName);
		const color = cat?.color ?? getEntityColor(typeName);
		return { color };
	}
}

export function mergeEnabledFamilies(
	partial?: Partial<EnabledSchemaFamilies>,
): EnabledSchemaFamilies {
	return { ...DEFAULT_ENABLED_SCHEMA_FAMILIES, ...partial };
}
