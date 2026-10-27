import { describe, it, expect } from 'vitest';
import { extensionStatusLine, formatCountdown, formatLastSeen } from '../integration/extension-settings-format';
import type { ExtensionStatus } from '../host/types';

describe('extension settings wording', () => {
    it('counts a pairing string down in m:ss and stops at zero', () => {
        expect(formatCountdown(5 * 60_000)).toBe('5:00');
        expect(formatCountdown(299_001)).toBe('5:00');
        expect(formatCountdown(299_000)).toBe('4:59');
        expect(formatCountdown(9_000)).toBe('0:09');
        expect(formatCountdown(1)).toBe('0:01');
        expect(formatCountdown(0)).toBe('0:00');
        expect(formatCountdown(-5_000)).toBe('0:00');
    });

    it('says when an extension was last seen', () => {
        const now = Date.parse('2026-09-18T12:00:00.000Z');
        expect(formatLastSeen(null, now)).toBe('never');
        expect(formatLastSeen('garbage', now)).toBe('unknown');
        expect(formatLastSeen('2026-09-18T11:59:30.000Z', now)).toBe('just now');
        expect(formatLastSeen('2026-09-18T11:45:00.000Z', now)).toBe('15 min ago');
        expect(formatLastSeen('2026-09-18T09:00:00.000Z', now)).toBe('3 h ago');
        expect(formatLastSeen('2026-09-10T09:00:00.000Z', now)).toBe(new Date('2026-09-10T09:00:00.000Z').toLocaleDateString());
    });

    it('names why the channel is not running', () => {
        const base: ExtensionStatus = { enabled: true, running: true, port: 23760, licensed: true, secretsEncrypted: true, clients: [] };
        expect(extensionStatusLine(base)).toBe('Running on 127.0.0.1:23760.');
        expect(extensionStatusLine({ ...base, enabled: false, running: false })).toMatch(/^Off/);
        expect(extensionStatusLine({ ...base, licensed: false, running: false })).toMatch(/licence/);
        expect(extensionStatusLine({ ...base, running: false, port: null })).toMatch(/port/);
        expect(extensionStatusLine({ ...base, problem: 'key file unreadable' })).toBe('Unavailable: key file unreadable');
    });
});
