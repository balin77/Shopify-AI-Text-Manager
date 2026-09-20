/**
 * WHERE the meter charges, and WHAT each SDK's answer is read as —
 * PLAN_MANAGED_AI_KEY §4.1.
 *
 * Two properties live here that cannot be seen in either module alone.
 *
 * The first is which method holds the charge: `executeAIRequest`, not `askAI`.
 * `replayRequest` — the task-recovery path — calls `executeAIRequest` directly,
 * past the queue and past everything `askAI` does, so a meter one level up
 * would silently miss every recovered task.
 *
 * The second is that a provider ANSWERING and a call SUCCEEDING are different
 * events. Sixteen guards in `_executeAIRequestInner` reject an answer the
 * provider has already charged for, the most expensive of them being a
 * `finish_reason: length` truncation that comes back with empty content after
 * generating the full output allowance. Anything asserted through a stubbed
 * `_executeAIRequestInner` would not see any of it, which is why the SDK
 * clients themselves are faked here.
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

/** Build a service whose one provider client is a fake. */
function withClient(provider: string, client: unknown, shop?: string, taskId?: string) {
  const svc = new AIService(provider as never, { ...CONFIG, openaiApiKey: 'k', geminiApiKey: 'k', grokApiKey: 'k', deepseekApiKey: 'k', huggingfaceApiKey: 'k' }, shop, taskId);
  (svc as unknown as Record<string, unknown>)[provider === 'huggingface' ? 'huggingface' : provider] = client;
  return svc;
}

const chatOk = (content: string, usage: Record<string, number>) => ({
  chat: { completions: { create: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage }) } },
});

describe('per-SDK usage shapes', () => {
  it('reads OpenAI / Grok / DeepSeek `usage.prompt_tokens` / `completion_tokens`', async () => {
    for (const provider of ['openai', 'grok', 'deepseek']) {
      mockRecordAiUsage.mockClear();
      const svc = withClient(provider, chatOk('hi', { prompt_tokens: 111, completion_tokens: 22 }), 'demo.myshopify.com');

      await svc.replayRequest('p');

      expect(mockRecordAiUsage, provider).toHaveBeenCalledWith(
        expect.objectContaining({ provider, inputTokens: 111, outputTokens: 22, estimated: false }),
      );
    }
  });

  it('reads HuggingFace the same way, and estimates when the routed provider fills nothing', async () => {
    const svc = withClient('huggingface', {
      chatCompletion: async () => ({ choices: [{ message: { content: 'hello there' } }] }),
    }, 'demo.myshopify.com');

    await svc.replayRequest('a prompt');

    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'huggingface', estimated: true }),
    );
    expect(mockRecordAiUsage.mock.calls[0][0].inputTokens).toBeGreaterThan(0);
  });

  it('reads Anthropic `usage.input_tokens` / `output_tokens`', async () => {
    const svc = new AIService('claude', CONFIG, 'demo.myshopify.com');
    (svc as unknown as { anthropic: unknown }).anthropic = {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 900, output_tokens: 80 },
        }),
      },
    };

    await svc.replayRequest('p');

    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 900, outputTokens: 80, estimated: false }),
    );
  });

  it('reads Gemini `usageMetadata.promptTokenCount` / `candidatesTokenCount`', async () => {
    const svc = withClient('gemini', {
      generateContent: async () => ({
        response: {
          text: () => 'geminis answer',
          usageMetadata: { promptTokenCount: 240, candidatesTokenCount: 60 },
        },
      }),
    }, 'demo.myshopify.com');

    await svc.replayRequest('p');

    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'gemini', inputTokens: 240, outputTokens: 60, estimated: false }),
    );
  });

  it('records the model the call RAN on', async () => {
    const svc = withClient('openai', chatOk('x', { prompt_tokens: 1, completion_tokens: 1 }), 'demo.myshopify.com');
    (svc as unknown as { config: AIServiceConfig }).config.selectedModel = 'gpt-4o-mini';

    await svc.replayRequest('p');

    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o-mini' }),
    );
  });
});

describe('a provider that answered is charged, even when we reject the answer', () => {
  it('charges a `finish_reason: length` truncation — the most expensive call shape', async () => {
    const svc = withClient('openai', {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: '' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 8000, completion_tokens: 2048 },
          }),
        },
      },
    }, 'demo.myshopify.com');

    await expect(svc.replayRequest('p')).rejects.toThrow(/finish_reason: length/);

    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 8000, outputTokens: 2048 }),
    );
  });

  it('charges a Claude answer with no text block', async () => {
    const svc = new AIService('claude', CONFIG, 'demo.myshopify.com');
    (svc as unknown as { anthropic: unknown }).anthropic = {
      messages: {
        create: async () => ({ content: [], usage: { input_tokens: 500, output_tokens: 0 } }),
      },
    };

    await expect(svc.replayRequest('p')).rejects.toThrow(/no text block/);
    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 500 }),
    );
  });

  it('charges a Gemini response whose text() throws (a safety block is still billed)', async () => {
    const svc = withClient('gemini', {
      generateContent: async () => ({
        response: {
          text: () => {
            throw new Error('response was blocked due to SAFETY');
          },
          usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 0 },
        },
      }),
    }, 'demo.myshopify.com');

    await expect(svc.replayRequest('p')).rejects.toThrow();
    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 1500 }),
    );
  });

  it('charges BOTH calls of a Gemini vision fallback, as TWO calls', async () => {
    let call = 0;
    const svc = withClient('gemini', {
      generateContent: async () => {
        call += 1;
        if (call === 1) {
          return {
            response: {
              text: () => '',
              usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 0 },
            },
          };
        }
        return {
          response: {
            text: () => 'text-only answer',
            usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40 },
          },
        };
      },
    }, 'demo.myshopify.com');
    // The image never has to be fetched for real.
    (svc as unknown as { fetchImageAsBase64: unknown }).fetchImageAsBase64 = async () => 'AAAA';

    const out = await (svc as unknown as {
      _executeAIRequestInner: (p: string, i: string[] | undefined, cb: unknown) => Promise<string>;
    })._executeAIRequestInner('p', ['https://cdn.shopify.com/x.jpg'], () => {});
    expect(out).toBe('text-only answer');

    // Through the charge point, the two answers are two ledger entries — a sum
    // would report one call and inflate the per-call average this exists to
    // measure.
    mockRecordAiUsage.mockClear();
    call = 0;
    await (svc as unknown as { executeAIRequest: (p: string, i?: string[]) => Promise<string> })
      .executeAIRequest('p', ['https://cdn.shopify.com/x.jpg']);

    expect(mockRecordAiUsage).toHaveBeenCalledTimes(2);
    expect(mockRecordAiUsage.mock.calls[0][0].inputTokens).toBe(2000);
    expect(mockRecordAiUsage.mock.calls[1][0].inputTokens).toBe(300);
  });

  it('charges NOTHING for a call that never reached a provider', async () => {
    const svc = withClient('openai', {
      chat: { completions: { create: async () => { throw new Error('ECONNRESET'); } } },
    }, 'demo.myshopify.com');

    await expect(svc.replayRequest('p')).rejects.toThrow('ECONNRESET');
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });
});

describe('the charge point', () => {
  it('meters a REPLAYED request — the path that goes past askAI', async () => {
    const svc = withClient('openai', chatOk('replayed', { prompt_tokens: 10, completion_tokens: 20 }), 'demo.myshopify.com', 'task-1');

    await svc.replayRequest('a stored prompt');

    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', inputTokens: 10 }),
    );
  });

  it('names the FEATURE from the task, and reads it once for the whole instance', async () => {
    const svc = withClient('openai', chatOk('x', { prompt_tokens: 1, completion_tokens: 1 }), 'demo.myshopify.com', 'task-1');

    await svc.replayRequest('p');
    await svc.replayRequest('p');

    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'bulkTranslation' }),
    );
    expect(mockTaskFindUnique).toHaveBeenCalledTimes(1);
  });

  it('falls back to adhoc without a task, and when the lookup fails', async () => {
    const noTask = withClient('openai', chatOk('x', { prompt_tokens: 1, completion_tokens: 1 }), 'demo.myshopify.com');
    await noTask.replayRequest('p');
    expect(mockRecordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'adhoc' }));

    mockRecordAiUsage.mockClear();
    mockTaskFindUnique.mockRejectedValueOnce(new Error('db down'));
    const broken = withClient('openai', chatOk('x', { prompt_tokens: 1, completion_tokens: 1 }), 'demo.myshopify.com', 'task-9');
    await broken.replayRequest('p');
    expect(mockRecordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: 'adhoc' }));
  });

  it("defaults the key source to the MERCHANT's, and reports the operator's when told", async () => {
    const byo = withClient('openai', chatOk('x', { prompt_tokens: 1, completion_tokens: 1 }), 'demo.myshopify.com');
    await byo.replayRequest('p');
    expect(mockRecordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ source: 'byo' }));

    mockRecordAiUsage.mockClear();
    const managed = withClient('openai', chatOk('x', { prompt_tokens: 1, completion_tokens: 1 }), 'demo.myshopify.com');
    (managed as unknown as { config: AIServiceConfig }).config.credentialSource = 'managed';
    await managed.replayRequest('p');
    expect(mockRecordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ source: 'managed' }));
  });

  it('does not meter without a shop — there is nothing to meter against', async () => {
    const svc = withClient('openai', chatOk('x', { prompt_tokens: 1, completion_tokens: 1 }));
    await svc.replayRequest('p');
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it('charges a TIMED-OUT call at its worst case, never at zero', async () => {
    vi.useFakeTimers();
    try {
      const svc = withClient('openai', {
        chat: { completions: { create: () => new Promise(() => {}) } },
      }, 'demo.myshopify.com');

      // The assertion is attached BEFORE the clock moves: the rejection lands
      // inside advanceTimersByTimeAsync, and a handler attached after it would
      // be one microtask too late — reported as an unhandled rejection by a
      // test that otherwise passes.
      const rejected = expect(
        svc.replayRequest('a prompt that never comes back'),
      ).rejects.toThrow(/timed out/);
      // The backstop timer is 120s; the provider keeps generating and billing
      // on the other side of a race that cannot cancel it.
      await vi.advanceTimersByTimeAsync(121_000);
      await rejected;

      expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
      const charged = mockRecordAiUsage.mock.calls[0][0];
      expect(charged.estimated).toBe(true);
      // The worst case is the whole output allowance, not a guess at what it
      // might have produced: these are the longest calls there are.
      expect(charged.outputTokens).toBe(8192);
      expect(charged.inputTokens).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a meter that throws does NOT fail the generation', async () => {
    mockRecordAiUsage.mockRejectedValueOnce(new Error('database is on fire'));
    const svc = withClient('openai', chatOk('the answer', { prompt_tokens: 1, completion_tokens: 1 }), 'demo.myshopify.com');

    await expect(svc.replayRequest('p')).resolves.toBe('the answer');
  });
});
