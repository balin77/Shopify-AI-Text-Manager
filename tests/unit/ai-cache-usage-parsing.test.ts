/**
 * Cache-token usage parsing (PLAN_BULK_TRANSLATE_BATCHING Phase 1a-meter).
 * Groundwork only: no cache_control is sent, so real answers carry 0.
 * inputTokens stays the SUM of all input tokens; cache parts ride separately.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIService } from '../../src/services/ai.service';
import type { AIServiceConfig } from '../../src/services/ai.service';

// The real SDKs refuse to construct in a browser-like (jsdom) env; every AI
// test in this suite stubs them the same way. The fakes below are replaced
// per test with one that answers a measured usage shape.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: vi.fn() };
  },
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: vi.fn() } };
  },
}));

vi.mock('../../src/services/ai-queue.service', () => ({
  AIQueueService: {
    getInstance: vi.fn().mockReturnValue({
      enqueue: vi.fn(
        async (
          _shop: unknown,
          _taskId: unknown,
          _provider: unknown,
          _tokens: unknown,
          fn: () => unknown,
        ) => fn(),
      ),
    }),
  },
}));

const { mockTaskFindUnique } = vi.hoisted(() => ({
  mockTaskFindUnique: vi.fn().mockResolvedValue({ type: 'bulkTranslation' }),
}));

vi.mock('../../app/db.server', () => ({
  db: { task: { update: vi.fn(), findUnique: mockTaskFindUnique } },
}));

const { mockRecordAiUsage } = vi.hoisted(() => ({
  mockRecordAiUsage: vi.fn().mockResolvedValue({
    period: 'm:2026-09',
    costMicros: 0,
    billedMicros: 0,
    ledgerWritten: true,
    taskWritten: null,
  }),
}));

vi.mock('../../app/services/ai/usage-meter.server', () => ({
  recordAiUsage: mockRecordAiUsage,
}));

const CONFIG: AIServiceConfig = { claudeApiKey: 'test-claude-key' };

beforeEach(() => {
  vi.clearAllMocks();
  mockTaskFindUnique.mockResolvedValue({ type: 'bulkTranslation' });
});

/**
 * Build a service whose one provider client is a fake.
 *
 * The field an AIService keeps its client in is the provider's name for every
 * provider but Claude, whose field is `anthropic` — the one mapping that has
 * to be stated. Getting it wrong would leave the constructor-built client in
 * place and fail loudly rather than pass vacuously, but the map should still
 * say what it maps.
 */
const CLIENT_FIELD: Record<string, string> = { claude: 'anthropic' };

function withClient(provider: string, client: unknown, shop?: string, taskId?: string) {
  const svc = new AIService(provider as never, { ...CONFIG, openaiApiKey: 'k', geminiApiKey: 'k', grokApiKey: 'k', deepseekApiKey: 'k', huggingfaceApiKey: 'k' }, shop, taskId);
  (svc as unknown as Record<string, unknown>)[CLIENT_FIELD[provider] ?? provider] = client;
  return svc;
}


const chatOk = (content: string, usage: Record<string, unknown>) => ({
  chat: { completions: { create: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage }) } },
});

describe('cache usage parsing', () => {
  it('Anthropic: input_tokens EXCLUDES cache, so the total is the sum', async () => {
    const svc = new AIService('claude', CONFIG, 'demo.myshopify.com');
    (svc as unknown as { anthropic: unknown }).anthropic = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500 },
        }),
      },
    };
    await svc.replayRequest('p');
    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 4600, outputTokens: 10, cacheReadTokens: 4000, cacheWriteTokens: 500, estimated: false }),
    );
  });

  it('Anthropic without cache fields is unchanged and sends no cache keys', async () => {
    const svc = new AIService('claude', CONFIG, 'demo.myshopify.com');
    (svc as unknown as { anthropic: unknown }).anthropic = {
      messages: { create: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 900, output_tokens: 80 } }) },
    };
    await svc.replayRequest('p');
    const arg = mockRecordAiUsage.mock.calls[0][0];
    expect(arg.inputTokens).toBe(900);
    expect(arg).not.toHaveProperty('cacheReadTokens');
    expect(arg).not.toHaveProperty('cacheWriteTokens');
  });

  it('OpenAI: cached_tokens is INCLUDED in prompt_tokens, total unchanged', async () => {
    const svc = new AIService('openai', { ...CONFIG, openaiApiKey: 'k' }, 'demo.myshopify.com');
    (svc as unknown as { openai: unknown }).openai = chatOk('hi', {
      prompt_tokens: 2000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 1536 },
    });
    await svc.replayRequest('p');
    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 2000, cacheReadTokens: 1536 }),
    );
  });

  it('DeepSeek: prompt_cache_hit_tokens is read; a value above the total is clamped', async () => {
    const svc = new AIService('deepseek', { ...CONFIG, deepseekApiKey: 'k' }, 'demo.myshopify.com');
    (svc as unknown as { deepseek: unknown }).deepseek = chatOk('hi', {
      prompt_tokens: 500, completion_tokens: 5, prompt_cache_hit_tokens: 9999,
    });
    await svc.replayRequest('p');
    const arg = mockRecordAiUsage.mock.calls[0][0];
    expect(arg.inputTokens).toBe(500);
    expect(arg.cacheReadTokens).toBe(500);
  });
});
