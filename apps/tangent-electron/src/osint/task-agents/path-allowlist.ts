import { normalizeVaultPath } from "./normalize-vault-path";

function ensureTrailingSlash(p: string): string {
	const n = normalizeVaultPath(p.trim());
	if (!n) return "";
	return n.endsWith("/") ? n : `${n}/`;
}

/**
 * A vault-relative path is allowed for writes if it is under at least one agent root
 * AND under at least one global allowlist root (normalized prefix match).
 */
export function isPathAllowedForWrite(
	vaultRelativePath: string,
	agentOutputRoots: string[],
	globalAllowlistRoots: string[],
): boolean {
	const pathNorm = normalizeVaultPath(vaultRelativePath.replace(/\\/g, "/"));
	if (!pathNorm || pathNorm.includes("..")) return false;
	if (pathNorm.startsWith("/")) return false;

	const pathWithSlash = pathNorm.endsWith("/") ? pathNorm : `${pathNorm}/`;

	const agentNorm = agentOutputRoots
		.map((r) => ensureTrailingSlash(r))
		.filter(Boolean);
	const globalNorm = globalAllowlistRoots
		.map((r) => ensureTrailingSlash(r))
		.filter(Boolean);

	if (agentNorm.length === 0 || globalNorm.length === 0) return false;

	const underAgent = agentNorm.some(
		(root) => pathWithSlash.startsWith(root) || pathNorm === root.slice(0, -1),
	);
	const underGlobal = globalNorm.some(
		(root) => pathWithSlash.startsWith(root) || pathNorm === root.slice(0, -1),
	);

	return underAgent && underGlobal;
}

/**
 * The folders a task agent can actually write to: where one of its output roots and one
 * of the global allowlist roots overlap, the deeper of the two. Empty when none overlap.
 */
export function effectiveOutputRoots(agentOutputRoots: string[], globalAllowlistRoots: string[]): string[] {
	const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
	const agent = agentOutputRoots.map((r) => normalizeVaultPath(r)).filter(Boolean);
	const global = globalAllowlistRoots.map((r) => normalizeVaultPath(r)).filter(Boolean);
	const out: string[] = [];
	for (const a of agent) {
		for (const g of global) {
			const root = within(a, g) ? a : within(g, a) ? g : null;
			if (root && !out.includes(root)) out.push(root);
		}
	}
	return out;
}

export function normalizeRootList(raw: string): string[] {
	return raw
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter(Boolean)
		.map((p) => normalizeVaultPath(p.replace(/^["']|["']$/g, "")));
}
