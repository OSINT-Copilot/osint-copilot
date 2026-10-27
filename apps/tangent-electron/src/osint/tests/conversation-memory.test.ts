import { describe, it, expect } from 'vitest';
import { capConversationMemory } from '../services/agent-runtime/conversation-memory';

const msg = (role: 'user' | 'assistant', content: string) => ({ role, content });

describe('capConversationMemory', () => {
    it('keeps the most recent messages and drops the oldest', () => {
        const history = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`));
        const kept = capConversationMemory(history, { maxMessages: 4, maxCharsPerMessage: 100, maxTotalChars: 1000 });
        expect(kept.map((m) => m.content)).toEqual(['m26', 'm27', 'm28', 'm29']);
    });

    it('truncates an oversized message and marks it', () => {
        const kept = capConversationMemory([msg('assistant', 'x'.repeat(50))], { maxMessages: 5, maxCharsPerMessage: 10, maxTotalChars: 1000 });
        expect(kept[0].content.startsWith('x'.repeat(10))).toBe(true);
        expect(kept[0].content).toMatch(/omitted/);
    });

    it('spends the total budget on the newest turns first', () => {
        const history = [msg('user', 'a'.repeat(40)), msg('assistant', 'b'.repeat(40)), msg('user', 'c'.repeat(40))];
        const kept = capConversationMemory(history, { maxMessages: 10, maxCharsPerMessage: 100, maxTotalChars: 85 });
        expect(kept.map((m) => m.content[0])).toEqual(['b', 'c']);
    });

    it('leaves a short history untouched', () => {
        const history = [msg('user', 'hi'), msg('assistant', 'hello')];
        expect(capConversationMemory(history)).toEqual(history);
    });
});
