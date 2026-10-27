import { describe, expect, it, vi } from 'vitest';
import { GraphApiService } from '../services/api-service';
import type { LocalCliService } from '../services/claude-code-service';

function fakeService(providerId: 'claude-code' | 'codex'): LocalCliService {
    return {
        providerId,
        displayName: providerId === 'codex' ? 'Codex CLI' : 'Claude Code',
        setVaultSkillResolver: vi.fn(),
        updateConfig: vi.fn(),
        chat: vi.fn().mockResolvedValue(`${providerId}-answer`),
        extractEntities: vi.fn().mockResolvedValue({ success: true, operations: [] }),
        extractTextFromImage: vi.fn().mockResolvedValue(`${providerId}-image`),
        isAvailable: vi.fn().mockResolvedValue(true),
    };
}

function configure(api: GraphApiService, apiProvider: 'claude-code' | 'codex'): void {
    api.setSettings({
        apiProvider,
    });
}

describe('GraphApiService local CLI routing', () => {
    it('routes extraction, image analysis, and general calls through the selected Codex service', async () => {
        const api = new GraphApiService();
        const claude = fakeService('claude-code');
        const codex = fakeService('codex');
        api.setLocalCliService(claude);
        api.setLocalCliService(codex);
        configure(api, 'codex');

        await expect(api.processText('source text')).resolves.toEqual({ success: true, operations: [] });
        await expect(api.extractTextFromImage('/tmp/evidence.png')).resolves.toBe('codex-image');
        await expect(
            api.callRemoteModel([
                { role: 'system', content: 'system rules' },
                { role: 'user', content: 'question' },
            ]),
        ).resolves.toBe('codex-answer');

        expect(codex.extractEntities).toHaveBeenCalledWith('source text', undefined, undefined, undefined);
        expect(codex.extractTextFromImage).toHaveBeenCalledWith('/tmp/evidence.png', undefined, undefined);
        expect(codex.chat).toHaveBeenCalledWith('system rules', 'question', undefined, undefined);
        expect(claude.chat).not.toHaveBeenCalled();
    });

    it('can address Claude explicitly while Codex remains the extraction default', async () => {
        const api = new GraphApiService();
        const claude = fakeService('claude-code');
        const codex = fakeService('codex');
        api.setLocalCliService(claude);
        api.setLocalCliService(codex);
        configure(api, 'codex');

        await expect(
            api.callLocalProviderModel('claude-code', [{ role: 'user', content: 'hello' }], true),
        ).resolves.toBe('claude-code-answer');

        expect(claude.chat).toHaveBeenCalledWith(
            expect.stringContaining('Respond ONLY with valid JSON'),
            'hello',
            undefined,
            undefined,
        );
        expect(codex.chat).not.toHaveBeenCalled();
    });

    it('probes the runtime it is asked about, not the selected one', async () => {
        const api = new GraphApiService();
        const claude = fakeService('claude-code');
        const codex = fakeService('codex');
        vi.mocked(claude.isAvailable).mockResolvedValue(false);
        api.setLocalCliService(claude);
        api.setLocalCliService(codex);
        configure(api, 'codex');

        await expect(api.checkHealth('codex')).resolves.toMatchObject({ status: 'ok' });
        await expect(api.checkHealth('claude-code')).resolves.toBeNull();
    });

    it.each([false, true])('propagates final-chunk cancellation instead of returning partial success (prior ops: %s)', async (withPriorOps) => {
        const api = new GraphApiService();
        const codex = fakeService('codex');
        api.setLocalCliService(codex);
        configure(api, 'codex');
        const controller = new AbortController();
        let calls = 0;
        vi.mocked(codex.extractEntities).mockImplementation(async () => {
            calls++;
            if (calls === 1) {
                return withPriorOps
                    ? {
                        success: true,
                        operations: [{
                            action: 'create',
                            entities: [{ type: 'Person', properties: { full_name: 'Before cancel' } }],
                        }],
                    }
                    : { success: true, operations: [] };
            }
            controller.abort();
            throw new DOMException('Aborted', 'AbortError');
        });

        await expect(api.processTextInChunks(
            'x'.repeat(1300),
            [],
            undefined,
            controller.signal,
        )).rejects.toMatchObject({ name: 'AbortError' });
        expect(calls).toBe(2);
    });
});
