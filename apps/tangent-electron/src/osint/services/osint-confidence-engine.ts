/**
 * Derives persisted OsintConfidence from sources and detected contradictions.
 * Pure logic — no vault I/O.
 */

import type {
	Connection,
	Entity,
	GraphWriteContext,
	OsintConfidence,
	OsintContradiction,
	OsintSource,
	OsintSourceInput,
} from '../entities/types';
import { OSINT_CONFIDENCE_LEVELS } from '../entities/types';

/** Material fields compared for entities (dot paths under properties + label). */
const DEFAULT_ENTITY_FIELD_PATHS = ['label', 'name', 'properties.country', 'properties.email'];

/** For connections: relationship line + key interval props. */
const DEFAULT_CONNECTION_FIELD_PATHS = ['relationship', 'label', 'properties.role', 'properties.startDate'];

export function isOsintConfidence(v: unknown): v is OsintConfidence {
	return typeof v === 'string' && (OSINT_CONFIDENCE_LEVELS as readonly string[]).includes(v);
}

/** When the pipeline has no explicit sources, attach one inferred row tied to query/context. */
export function buildInferredOsintSources(ctx: GraphWriteContext | undefined): OsintSourceInput[] {
	const q = (ctx?.query ?? '').trim() || 'Graph write (no query context)';
	const firstUrl = ctx?.extracted_urls?.find(
		(u) => u.startsWith('http://') || u.startsWith('https://'),
	);
	return [
		{
			inferred: true,
			source_url: firstUrl ?? 'inferred:orchestration',
			rationale: `Assistant graph pipeline. Context: ${q.slice(0, 600)}`,
			conversation_id: ctx?.conversation_id,
		},
	];
}

export function normalizeSourceUrl(url: string): string {
	const t = url.trim();
	try {
		if (t.startsWith('http://') || t.startsWith('https://')) {
			const u = new URL(t);
			u.hash = '';
			return u.toString();
		}
	} catch {
		/* vault path */
	}
	return t;
}

function getFieldValue(
	target: Entity | Connection,
	path: string,
): string | undefined {
	if (path === 'label') return target.label ?? undefined;
	if (path === 'relationship' && 'relationship' in target) {
		return target.relationship;
	}
	if (path.startsWith('properties.')) {
		const k = path.slice('properties.'.length);
		const props = target.properties ?? {};
		const v = props[k];
		if (v === undefined || v === null) return undefined;
		return String(v).trim();
	}
	return undefined;
}

function detectContradictions(
	target: Entity | Connection,
	fieldPaths: string[],
	sources: OsintSource[],
): OsintContradiction[] {
	const out: OsintContradiction[] = [];
	for (const field_path of fieldPaths) {
		const bySource: Record<string, string> = {};
		for (const src of sources) {
			const fromClaim = src.claims?.find((c) => c.path === field_path);
			if (fromClaim && fromClaim.value.trim() !== '') {
				bySource[src.id] = fromClaim.value.trim();
				continue;
			}
			const snap = getFieldValue(target, field_path);
			if (snap !== undefined && snap !== '') {
				bySource[src.id] = snap;
			}
		}
		const vals = Object.entries(bySource);
		if (vals.length < 2) continue;
		const unique = new Set(vals.map(([, v]) => v.toLowerCase()));
		if (unique.size > 1) {
			out.push({
				field_path,
				entries: vals.map(([source_id, value]) => ({ source_id, value })),
			});
		}
	}
	return out;
}

export interface ComputeOsintOutcome {
	osint_confidence: OsintConfidence;
	osint_contradictions: OsintContradiction[];
}

/**
 * Count independent non-inferred sources (deduped by normalized URL).
 */
export function countIndependentVerifiedSources(sources: OsintSource[]): number {
	const seen = new Set<string>();
	let n = 0;
	for (const s of sources) {
		if (s.inferred) continue;
		const key = normalizeSourceUrl(s.source_url);
		if (seen.has(key)) continue;
		seen.add(key);
		n++;
	}
	return n;
}

export function computeOsintConfidence(
	target: Entity | Connection,
	sources: OsintSource[],
	fieldPaths?: string[],
): ComputeOsintOutcome {
	const paths =
		'relationship' in target && target.relationship !== undefined
			? fieldPaths ?? DEFAULT_CONNECTION_FIELD_PATHS
			: fieldPaths ?? DEFAULT_ENTITY_FIELD_PATHS;

	const contradictions = detectContradictions(target, paths, sources);
	if (contradictions.length > 0) {
		return { osint_confidence: 'conflicted', osint_contradictions: contradictions };
	}

	const verified = countIndependentVerifiedSources(sources);
	const onlyInferred = sources.length > 0 && sources.every((s) => s.inferred);

	if (sources.length === 0) {
		return { osint_confidence: 'unverified', osint_contradictions: [] };
	}
	if (onlyInferred) {
		return { osint_confidence: 'unverified', osint_contradictions: [] };
	}
	if (verified <= 0) {
		return { osint_confidence: 'unverified', osint_contradictions: [] };
	}
	if (verified === 1) {
		return { osint_confidence: 'low', osint_contradictions: [] };
	}
	if (verified === 2) {
		return { osint_confidence: 'medium', osint_contradictions: [] };
	}
	return { osint_confidence: 'high', osint_contradictions: [] };
}

/** What finalizeOsintSources stores when a source arrives without a URL or rationale. */
const DEFAULT_SOURCE_URL = 'inferred:orchestration';
const DEFAULT_RATIONALE = 'No rationale provided.';

/**
 * An id derived from what the source says rather than when it arrived, so the same
 * capture sent twice gets the same id and appending it again is recognisably a repeat.
 * Two FNV-1a passes with different offsets give 64 bits: a collision would silently drop
 * a genuinely new source, which 32 bits makes plausible over a large vault.
 *
 * The input is read the way finalizeOsintSources stores it (same defaults, claims as
 * plain strings), so a raw source and the stored record it became hash the same. That
 * lets a stored source be recognised whatever id it was saved under, including the
 * random ids written before this existed.
 */
export function deterministicOsintSourceId(raw: OsintSourceInput): string {
	const claims = Array.isArray(raw.claims)
		? raw.claims.map((c) => [String(c?.path ?? ''), String(c?.value ?? '')])
		: [];
	const material = JSON.stringify([
		normalizeSourceUrl((raw.source_url ?? '').trim() || DEFAULT_SOURCE_URL),
		typeof raw.sha256 === 'string' ? raw.sha256 : '',
		raw.inferred === true,
		(raw.rationale ?? '').trim() || DEFAULT_RATIONALE,
		claims,
	]);
	return `src_${fnv1a(material, 0x811c9dc5)}${fnv1a(material, 0x01000193 ^ 0x9e3779b9)}`;
}

function fnv1a(value: string, seed: number): string {
	let hash = seed >>> 0;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/** Normalize LLM / pipeline input into full OsintSource records. */
export function finalizeOsintSources(
	inputs: OsintSourceInput[] | undefined,
	defaults: { captured_at: string; conversation_id?: string },
): OsintSource[] {
	if (!inputs?.length) return [];
	// A source without an id gets one derived from its content, so saving the same
	// extraction again produces ids a later append recognises. The same source listed twice
	// in one batch would then share an id, so the repeat is dropped.
	const derived = new Set<string>();
	const kept: Array<{ raw: OsintSourceInput; id: string }> = [];
	for (const raw of inputs) {
		const own = raw.id?.trim();
		const id = own || deterministicOsintSourceId(raw);
		if (!own) {
			if (derived.has(id)) continue;
			derived.add(id);
		}
		kept.push({ raw, id });
	}
	return kept.map(({ raw, id }) => {
		const source_url = (raw.source_url ?? '').trim() || DEFAULT_SOURCE_URL;
		return {
			id,
			source_url,
			archive_url: raw.archive_url,
			archive_status: raw.archive_status,
			inferred: raw.inferred === true,
			rationale: (raw.rationale ?? '').trim() || DEFAULT_RATIONALE,
			captured_at: raw.captured_at ?? defaults.captured_at,
			conversation_id: raw.conversation_id ?? defaults.conversation_id,
			claims: raw.claims,
			// Provenance is copied rather than defaulted: a missing value must stay missing,
			// not be invented here. Only strings survive, because a value read back from
			// front matter can be any YAML type.
			...provenanceOf(raw),
		};
	});
}

const PROVENANCE_KEYS = ['via', 'client_id', 'sha256', 'received_at'] as const;

function provenanceOf(raw: OsintSourceInput): Pick<OsintSource, (typeof PROVENANCE_KEYS)[number]> {
	const out: Pick<OsintSource, (typeof PROVENANCE_KEYS)[number]> = {};
	for (const key of PROVENANCE_KEYS) {
		const value: unknown = raw[key];
		if (typeof value === 'string') out[key] = value;
	}
	return out;
}
