import type { GraphApiService } from '../api-service';
import type { ExtractionLogOptions } from '../claude-code-service';
import { buildUnifiedAgentSystemPrompt, buildUnifiedAgentUserPrompt } from './build-unified-agent-prompt';
import { parseAgentTurnResult } from './parse-agent-turn-json';
import type { AgentProvider, AgentTurnContext, AgentTurnResult } from './provider-types';

/** A built-in local CLI (Claude Code or Codex) run through GraphApiService's CLI services. */
export class LocalCliAgentProvider implements AgentProvider {
    constructor(
        private readonly graphApi: GraphApiService,
        readonly id: 'claude-code' | 'codex',
        /** Shown in the progress message, e.g. "Claude Code". */
        private readonly progressLabel: string,
        /** Passed to the system prompt, e.g. "Codex CLI". */
        private readonly promptLabel: string,
    ) {}

    async runTurn(
        ctx: AgentTurnContext,
        signal: AbortSignal | undefined,
        onProgress?: (message: string, percent: number) => void,
        logOptions?: ExtractionLogOptions,
    ): Promise<AgentTurnResult> {
        onProgress?.(`Running ${this.progressLabel} agent (JSON turn)...`, 40);
        const system = buildUnifiedAgentSystemPrompt(this.promptLabel);
        const user = buildUnifiedAgentUserPrompt(ctx);
        const raw = await this.graphApi.callLocalProviderModel(
            this.id,
            [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            true,
            signal,
            logOptions,
        );
        onProgress?.('Parsing agent response...', 85);
        return parseAgentTurnResult(raw);
    }

    async healthCheck(): Promise<boolean> {
        const health = await this.graphApi.checkHealth(this.id);
        return health !== null && health.status === 'ok';
    }
}
