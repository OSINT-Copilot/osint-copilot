/**
 * The slice of chat history that travels with each agent turn.
 *
 * It used to be every message, in full, stringified into the prompt on every send --
 * including previous answers with their appended retrieval and enricher blocks. A long
 * investigation got slower with each turn and eventually hit the CLI timeout, with the
 * timeout message as the only clue. Every other prompt section is capped (50 entities,
 * 50k of tool output); this caps the memory the same way, keeping the most recent turns.
 */
export interface MemoryMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface MemoryBudget {
    maxMessages: number;
    maxCharsPerMessage: number;
    maxTotalChars: number;
}

const DEFAULT_MEMORY_BUDGET: MemoryBudget = {
    maxMessages: 20,
    maxCharsPerMessage: 6_000,
    maxTotalChars: 48_000,
};

const TRUNCATION_MARK = '\n\u2026[earlier part of this message omitted]';

export function capConversationMemory(
    messages: readonly MemoryMessage[],
    budget: MemoryBudget = DEFAULT_MEMORY_BUDGET,
): MemoryMessage[] {
    const recent = messages.slice(-budget.maxMessages);
    const kept: MemoryMessage[] = [];
    let total = 0;
    // Newest first, so the budget is spent on what the agent is most likely to need.
    for (let i = recent.length - 1; i >= 0; i--) {
        let content = recent[i].content ?? '';
        if (content.length > budget.maxCharsPerMessage) {
            content = content.slice(0, budget.maxCharsPerMessage) + TRUNCATION_MARK;
        }
        if (total + content.length > budget.maxTotalChars) break;
        total += content.length;
        kept.unshift({ role: recent[i].role, content });
    }
    return kept;
}
