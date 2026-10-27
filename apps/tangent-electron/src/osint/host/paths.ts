/**
 * Pure path helpers. `path` is nothing but string manipulation, so the sandboxed
 * renderer needs no Node module for it -- only the platform separator, which comes
 * from the host snapshot.
 */
import { host } from './index';

function sep(): string {
    return host.platform.pathSep;
}

/** Joins segments with the platform separator, dropping empties. */
export function join(...segments: string[]): string {
    const s = sep();
    const parts = segments.filter(Boolean);
    if (parts.length === 0) return '';
    const joined = parts.join(s);
    // Collapse duplicate separators introduced by segments that already ended in one,
    // but preserve a leading UNC "\\\\" or POSIX root.
    const leading = joined.startsWith(s) ? s : '';
    const body = joined.split(s).filter(Boolean).join(s);
    return leading + body;
}
