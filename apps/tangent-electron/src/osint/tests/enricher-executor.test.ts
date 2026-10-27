import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestUrl } from 'obsidian';
import { executeEnricherHttp } from '../services/enrichers/enricher-executor';
import type { EnricherSpec } from '../services/enrichers/enricher-schema';
import { executeEnricherTool } from '../skills/skill-executor';
import { OrchestrationService } from '../services/orchestration-service';
import { AGENT_TURN_SCHEMA_VERSION } from '../services/agent-runtime/provider-types';

function minimalSpec(overrides: Partial<EnricherSpec> = {}): EnricherSpec {
	return {
		id: 't1',
		name: 'Test',
		description: '',
		status: 'active',
		enabled: true,
		allowedDomains: ['api.example.com'],
		auth: { type: 'none' },
		request: {
			method: 'GET',
			urlTemplate: 'https://api.example.com/v?q={{query}}',
			headers: {},
		},
		inputHints: [],
		skillInstructions: '',
		limits: { timeoutMs: 8000, retries: 0, maxResponseChars: 8000 },
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe('executeEnricherHttp', () => {
	beforeEach(() => {
		vi.mocked(requestUrl).mockReset();
	});

	it('uses requestUrl for GET and returns formatted JSON body', async () => {
		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			text: '{"hits":1}',
			headers: { 'content-type': 'application/json' },
			json: { hits: 1 },
			arrayBuffer: new ArrayBuffer(0),
		} as any);

		const out = await executeEnricherHttp(minimalSpec(), 'x@y.com', '', undefined, undefined);
		expect(out).toContain('Enricher Test succeeded');
		expect(out).toContain('"hits": 1');
		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://api.example.com/v?q=x%40y.com',
				method: 'GET',
				throw: false,
			}),
		);
	});

	it('URL-encodes query in urlTemplate for path segments (e.g. names with spaces)', async () => {
		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			text: '{}',
			headers: {},
			json: {},
			arrayBuffer: new ArrayBuffer(0),
		} as any);

		const spec = minimalSpec({
			request: {
				method: 'GET',
				urlTemplate: 'https://api.example.com/v2/query/{{query}}',
				headers: {},
			},
		});

		await executeEnricherHttp(spec, 'Paolo De Lellis', '', undefined, undefined);

		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://api.example.com/v2/query/Paolo%20De%20Lellis',
				method: 'GET',
				throw: false,
			}),
		);
	});

	it('throws on non-2xx from requestUrl', async () => {
		vi.mocked(requestUrl).mockResolvedValue({
			status: 403,
			text: 'denied',
			headers: {},
			json: null,
			arrayBuffer: new ArrayBuffer(0),
		} as any);

		await expect(executeEnricherHttp(minimalSpec(), 'q', '', undefined, undefined)).rejects.toThrow(
			/status=403/,
		);
	});

	it('sends POST body and contentType application/json', async () => {
		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			text: '{}',
			headers: {},
			json: {},
			arrayBuffer: new ArrayBuffer(0),
		} as any);

		const spec = minimalSpec({
			request: {
				method: 'POST',
				urlTemplate: 'https://api.example.com/v',
				headers: {},
				bodyTemplate: '{"email":"{{query}}"}',
			},
		});

		await executeEnricherHttp(spec, 'u@d.com', '', undefined, undefined);

		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				method: 'POST',
				body: '{"email":"u@d.com"}',
				contentType: 'application/json',
				throw: false,
			}),
		);
	});

	it('query_vault passes a credential REFERENCE, never the secret itself', async () => {
		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			text: '{"ok":true}',
			headers: {},
			json: { ok: true },
			arrayBuffer: new ArrayBuffer(0),
		} as any);

		const spec = minimalSpec({
			auth: {
				type: 'query_vault',
				queryParam: 'key',
				vaultRelativePath: 'leakcheck/api-key.txt',
			},
		});

		await executeEnricherHttp(
			spec,
			'test@example.com',
			'',
			undefined,
			'OSINTCopilot/custom/credentials',
		);

		// The secret is resolved and injected in the main process, so the renderer
		// only ever passes a reference. Asserting on the reference IS the security
		// property: if a secret value ever appears here again, this test fails.
		const call = vi.mocked(requestUrl).mock.calls[0][0] as unknown as Record<string, unknown>;
		expect(call.auth).toEqual({
			placement: 'query',
			queryParam: 'key',
			ref: {
				source: 'vault-file',
				name: 'OSINTCopilot/custom/credentials/leakcheck/api-key.txt',
			},
		});
		expect(call.allowedDomains).toEqual(spec.allowedDomains);
	});
});

describe('enricher_invocations', () => {
	beforeEach(() => {
		vi.mocked(requestUrl).mockReset();
		vi.mocked(requestUrl).mockResolvedValue({
			status: 200,
			text: '{"hits":1}',
			headers: {},
			json: { hits: 1 },
			arrayBuffer: new ArrayBuffer(0),
		} as any);
	});

	/** A plugin whose model asks for enricher t1, which the registry holds as `spec`. */
	function pluginWith(spec: EnricherSpec): any {
		const turnJson = JSON.stringify({
			version: AGENT_TURN_SCHEMA_VERSION,
			answer_markdown: 'Checking the address.',
			retrieval_hits: [],
			graph_operations: [],
			custom_vault_operations: [],
			enricher_invocations: [{ enricher_id: spec.id, query: 'x@y.com' }],
		});
		return {
			settings: {
				enableGraphFeatures: true,
				credentialsFolder: 'OSINTCopilot/custom/credentials',
				agentRuntimeProvider: 'claude-code',
				customAgentRuntimes: [],
			},
			graphApiService: {
				tryExtractTextFromUrl: vi.fn().mockResolvedValue({ ok: true, text: '' }),
				callLocalProviderModel: vi.fn().mockResolvedValue(turnJson),
			},
			vaultPromptLoader: { getOrchestrationAugmentation: vi.fn().mockResolvedValue('') },
			enricherRegistry: {
				listRunnable: vi.fn().mockResolvedValue([]),
				getById: vi.fn().mockResolvedValue(spec),
			},
		};
	}

	async function turn(plugin: any): Promise<string> {
		const orch = new OrchestrationService(plugin);
		const result = await orch.processRequest('check x@y.com', '', { entities: [], connections: [] }, [], vi.fn(), {});
		return result.finalResponse ?? '';
	}

	it.each([
		['a draft', minimalSpec({ status: 'draft', enabled: false })],
		['active but disabled', minimalSpec({ status: 'active', enabled: false })],
		['disabled', minimalSpec({ status: 'disabled', enabled: false })],
	])('makes no request for an enricher that is %s, and says why', async (state, spec) => {
		const out = await turn(pluginWith(spec));
		expect(requestUrl).not.toHaveBeenCalled();
		expect(out).toContain(`Enricher \`t1\` is ${state}, so no request was made.`);
		expect(out).toContain('"Set HTTP enricher enabled state"');
		expect(out).toContain('No enricher HTTP requests succeeded (1 failed)');
	});

	it('runs an active enricher', async () => {
		const out = await turn(pluginWith(minimalSpec()));
		expect(requestUrl).toHaveBeenCalledTimes(1);
		expect(out).toContain('Enricher Test succeeded');
		expect(out).toContain('1 enricher call(s) completed');
	});

	it('refuses an active enricher with no request URL', async () => {
		const spec = minimalSpec({ request: { method: 'GET', urlTemplate: '', headers: {} } });
		await expect(executeEnricherTool(pluginWith(spec), 'ENRICH_t1', 'q', '', undefined))
			.rejects.toThrow('has no request URL');
		expect(requestUrl).not.toHaveBeenCalled();
	});
});
