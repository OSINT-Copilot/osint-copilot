// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Probe Point Analytics LLC

/**
 * Builds the §8 manifest for an item and checks it the way the app will.
 *
 * The bundleId is minted here, once, when the item is created: it is the idempotency key,
 * and every retry of the item reuses it so the app can answer "duplicate" instead of
 * filing the same note twice.
 */
import type { EntityPayload, Manifest, ManifestPage } from './protocol';
import { validateManifest, type ValidationResult } from './validate';

export type ItemInput =
	| { kind: 'note'; workspaceId: string; page: ManifestPage; note: { text: string } }
	| { kind: 'entity'; workspaceId: string; page: ManifestPage; entity: EntityPayload };

export interface ManifestDeps {
	uuid?: () => string;
	now?: () => number;
}

export function buildManifest(input: ItemInput, deps: ManifestDeps = {}): ValidationResult<Manifest> {
	const uuid = deps.uuid ?? (() => crypto.randomUUID());
	const now = deps.now ?? Date.now;
	const base = {
		v: 1,
		bundleId: uuid(),
		workspaceId: input.workspaceId,
		kind: input.kind,
		page: { url: input.page.url, title: input.page.title ?? '' },
		clientTime: new Date(now()).toISOString(),
	};
	const raw = input.kind === 'note'
		? { ...base, note: { text: input.note.text } }
		: { ...base, entity: withoutBlanks(input.entity) };
	// The cleaned manifest is what gets queued, so what the app stores is what we checked.
	return validateManifest(raw);
}

/**
 * A blank optional field in the form means "not given": the protocol has no empty platform
 * or context, and an undefined key would still count as present to the local check.
 */
function withoutBlanks(entity: EntityPayload): EntityPayload {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(entity)) {
		const optional = k === 'chain' || k === 'platform' || k === 'context';
		if (v !== undefined && !(optional && v === '')) out[k] = v;
	}
	return out as unknown as EntityPayload;
}
