/**
 * Validation for settings the tab accepts by hand.
 *
 * These rules were previously enforced far from the point of entry -- a folder outside
 * OSINTCopilot/custom was accepted by the row and only rejected later by
 * assertPathUnderCustomRoot, surfacing as a Notice from an unrelated button or a warning
 * on the next launch; a tile URL missing {y} was accepted although the description said
 * it was required, and produced a blank map with nothing pointing at the cause. Pure
 * functions so the tab can say no immediately, and so this is testable.
 */
import { OSINT_COPILOT_CUSTOM_ROOT } from '../constants/vault-layout';

export interface Validation {
    ok: boolean;
    /** Why not, phrased for a settings row. Empty when ok. */
    message: string;
}

const OK: Validation = { ok: true, message: '' };

// Control characters, as a class built at runtime so the source stays plain ASCII.
const CONTROL_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']');

/**
 * A vault-relative folder: no absolute paths, no traversal, no backslashes, no control
 * characters. A leading slash means the user thinks they are writing an absolute path,
 * so it is refused rather than silently reinterpreted by normalizePath.
 */
export function validateVaultFolder(raw: string): Validation {
    const value = raw.trim();
    if (!value) return { ok: false, message: 'Enter a folder path.' };
    if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
        return { ok: false, message: 'Use a path inside the vault, not an absolute path.' };
    }
    if (value.includes('\\')) return { ok: false, message: 'Use forward slashes.' };
    if (CONTROL_CHARS.test(value)) return { ok: false, message: 'Remove control characters.' };
    const segments = value.replace(/\/+$/, '').split('/');
    if (segments.some((s) => s === '..')) {
        return { ok: false, message: 'Paths cannot step outside the vault with "..".' };
    }
    if (segments.some((s) => s.trim() === '')) {
        return { ok: false, message: 'Remove empty path segments.' };
    }
    return OK;
}

/** The stricter rule for folders the agent may write into. */
export function validateCustomRootFolder(raw: string): Validation {
    const base = validateVaultFolder(raw);
    if (!base.ok) return base;
    const value = raw.trim().replace(/\/+$/, '');
    const root = OSINT_COPILOT_CUSTOM_ROOT.replace(/\/+$/, '');
    if (value !== root && !value.startsWith(root + '/')) {
        return { ok: false, message: `Must stay under ${root}/.` };
    }
    return OK;
}

/**
 * An integer inside a range, reporting the value actually accepted.
 *
 * The tab used to discard invalid input silently while the field kept showing what was
 * typed, so a box reading "100" could mean a stored 120000.
 */
export function coerceInteger(
    raw: string,
    opts: { min: number; max: number; fallback: number },
): { value: number; accepted: boolean; message: string } {
    const text = raw.trim();
    if (!/^[+-]?\d+$/.test(text)) {
        return { value: opts.fallback, accepted: false, message: `Enter a whole number between ${opts.min} and ${opts.max}.` };
    }
    const n = Number(text);
    if (n < opts.min || n > opts.max) {
        const clamped = Math.min(opts.max, Math.max(opts.min, n));
        return { value: clamped, accepted: false, message: `Must be between ${opts.min} and ${opts.max}; using ${clamped}.` };
    }
    return { value: n, accepted: true, message: '' };
}
