/**
 * Secret resolution -- main process only.
 *
 * Secrets are resolved and injected here so plaintext never reaches the renderer,
 * which renders LLM and enricher output and is therefore the untrusted side. The
 * renderer passes a SecretRef; it never receives the value, and there is no host API
 * that would let it.
 *
 * Two sources:
 *   env        Process environment.
 *   vault-file Plaintext under OSINTCopilot/custom/credentials/.
 */
import type { SecretRef } from '../../../osint/host/types';
import { DEFAULT_CREDENTIALS_FOLDER } from '../../../osint/constants/vault-layout';
import type { OpenVault } from './vault';

/**
 * Never exposed over IPC. Main-internal only.
 *
 * @param vault  Where a `vault-file` ref is read from: the requesting window's own vault,
 *               passed explicitly by the caller. There is deliberately no fallback to "the
 *               open vault" -- with a window per vault that meant whichever opened last, so
 *               one case's credentials could be sent on another's requests. Null (no vault
 *               known for the caller) makes the vault-file source miss.
 */
export async function resolveSecret(ref: SecretRef, vault: OpenVault | null): Promise<string | null> {
    if (!ref?.name) return null;

    if (ref.source === 'env') {
        return process.env[ref.name] ?? null;
    }

    // vault-file: confined to the credentials folder, so a crafted relative path
    // cannot read arbitrary vault content.
    if (!vault) return null;
    const relative = ref.name.replace(/^[/\\]+/, '');
    if (relative.includes('..')) return null;
    const path = relative.startsWith(DEFAULT_CREDENTIALS_FOLDER)
        ? relative
        : `${DEFAULT_CREDENTIALS_FOLDER}/${relative}`;
    try {
        const value = (await vault.read(path)).trim();
        return value || null;
    } catch {
        return null;
    }
}
