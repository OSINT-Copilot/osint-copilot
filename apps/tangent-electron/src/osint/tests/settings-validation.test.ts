import { describe, it, expect } from 'vitest';
import { validateVaultFolder, validateCustomRootFolder, coerceInteger } from '../settings/settings-validation';

describe('validateVaultFolder', () => {
    it('accepts an ordinary vault-relative folder', () => {
        expect(validateVaultFolder('OSINTCopilot/custom/prompts').ok).toBe(true);
        expect(validateVaultFolder('  Notes/Research  ').ok).toBe(true);
    });

    it('refuses what the writer would refuse later, at the point of entry', () => {
        // These used to be accepted here and rejected far away -- as a Notice from an
        // unrelated button, or a console warning on the next launch.
        for (const bad of ['/etc/passwd', 'C:\\Users\\x', '../secrets', 'a/../../b', 'a\\b', '', '   ', 'a//b']) {
            expect(validateVaultFolder(bad).ok, bad).toBe(false);
            expect(validateVaultFolder(bad).message, bad).not.toBe('');
        }
    });
});

describe('validateCustomRootFolder', () => {
    it('holds the agent-writable folders under the custom root the description promises', () => {
        expect(validateCustomRootFolder('OSINTCopilot/custom').ok).toBe(true);
        expect(validateCustomRootFolder('OSINTCopilot/custom/credentials').ok).toBe(true);
        const outside = validateCustomRootFolder('OSINTCopilot/elsewhere');
        expect(outside.ok).toBe(false);
        expect(outside.message).toMatch(/must stay under/i);
        // A prefix that merely looks similar is not inside it.
        expect(validateCustomRootFolder('OSINTCopilot/customized').ok).toBe(false);
    });
});

describe('coerceInteger', () => {
    it('accepts a number in range', () => {
        expect(coerceInteger('30000', { min: 5000, max: 3_600_000, fallback: 1 })).toEqual({ value: 30000, accepted: true, message: '' });
    });

    it('clamps out-of-range and says so, rather than silently substituting', () => {
        const low = coerceInteger('100', { min: 5000, max: 3_600_000, fallback: 300000 });
        expect(low.accepted).toBe(false);
        expect(low.value).toBe(5000);
        expect(low.message).toMatch(/between/);
    });

    it('falls back on non-numbers, and never half-reads one', () => {
        // parseInt("15abc") returned 15; that is the class of quiet mistake this avoids.
        expect(coerceInteger('15abc', { min: 1, max: 200, fallback: 15 }).accepted).toBe(false);
        expect(coerceInteger('', { min: 1, max: 200, fallback: 15 }).value).toBe(15);
        expect(coerceInteger('1e5', { min: 1, max: 200, fallback: 15 }).accepted).toBe(false);
    });
});
