/**
 * WHERE the meter charges — PLAN_MANAGED_AI_KEY §4.1.
 *
 * The one property these tests exist for cannot be seen in `usage-meter.server.ts`
 * and cannot be seen in `ai.service.ts` either, because it is about which of
 * two methods the charge sits in: `executeAIRequest`, not `askAI`.
 * `replayRequest` — the task-recovery path — calls `executeAIRequest` directly,
 * past the queue and past everything `askAI` does, so a meter placed one level
 * up would silently miss every recovered task. That is the kind of hole nobody
 * notices until an invoice does.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIService } from '../../src/services/ai.service';
import type { AIServiceConfig } from '../../src/services/ai.service';

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: vi.fn() };
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

vi.mock('../../app/db.server', () => ({
  db: { task: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) } },
}));

const { mockRecordAiUsage } = vi.hoisted(() => ({
  mockRecordAiUsage: vi.fn().mockResolvedValue({
    period: '2026-09',
    costMicros: 0,
    billedMicros: 0,
    recorded: true,
  }),
}));

vi.mock('../../app/services/ai/usage-meter.server', () => ({
  recordAiUsage: mockRecordAiUsage,
}));

const CONFIG: AIServiceConfig = { claudeApiKey: 'test-claude-key' };

/** One provider call, as `_executeAIRequestInner` reports it. */
const inner = (text: string, usage: Record<string, unknown>) => ({ text, usage });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the charge point', () => {
  it('meters a normal generation, with the shop, provider and model of the call', async () => {
    const svc = new AIService('claude', CONFIG, 'demo.myshopify.com');
    vi.spyOn(svc as any, '_executeAIRequestInner').mockResolvedValue(
      inner('<p>ok</p>', {
        inputTokens: 1500,
        outputTokens: 700,
        model: 'claude-haiku-4-5',
        source: 'provider',
      }),
    );

    await svc.generateProductDescription('t', 'p');

    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        shop: 'demo.myshopify.com',
        provider: 'claude',
        model: 'claude-haiku-4-5',
        inputTokens: 1500,
        outputTokens: 700,
        estimated: false,
      }),
    );
  });

  it('meters a REPLAYED request too — the path that goes past askAI', async () => {
    const svc = new AIService('claude', CONFIG, 'demo.myshopify.com', 'task-1');
    vi.spyOn(svc as any, '_executeAIRequestInner').mockResolvedValue(
      inner('replayed', {
        inputTokens: 10,
        outputTokens: 20,
        model: 'claude-haiku-4-5',
        source: 'provider',
      }),
    );

    await svc.replayRequest('a stored prompt');

    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', inputTokens: 10 }),
    );
  });

  it('flags an ESTIMATED call as estimated', async () => {
    const svc = new AIService('claude', CONFIG, 'demo.myshopify.com');
    vi.spyOn(svc as any, '_executeAIRequestInner').mockResolvedValue(
      inner('x', { inputTokens: 4, outputTokens: 1, model: 'm', source: 'estimate' }),
    );

    await svc.replayRequest('p');

    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ estimated: true }),
    );
  });

  it('defaults the key source to the MERCHANT\'s, and reports the operator\'s when told', async () => {
    const byo = new AIService('claude', CONFIG, 'demo.myshopify.com');
    vi.spyOn(byo as any, '_executeAIRequestInner').mockResolvedValue(
      inner('x', { inputTokens: 1, outputTokens: 1, model: 'm', source: 'provider' }),
    );
    await byo.replayRequest('p');
    expect(mockRecordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ source: 'byo' }));

    mockRecordAiUsage.mockClear();
    const managed = new AIService(
      'claude',
      { ...CONFIG, credentialSource: 'managed' },
      'demo.myshopify.com',
    );
    vi.spyOn(managed as any, '_executeAIRequestInner').mockResolvedValue(
      inner('x', { inputTokens: 1, outputTokens: 1, model: 'm', source: 'provider' }),
    );
    await managed.replayRequest('p');
    expect(mockRecordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'managed' }),
    );
  });

  it('does not meter without a shop — there is nothing to meter against', async () => {
    const svc = new AIService('claude', CONFIG);
    vi.spyOn(svc as any, '_executeAIRequestInner').mockResolvedValue(
      inner('x', { inputTokens: 1, outputTokens: 1, model: 'm', source: 'provider' }),
    );

    await svc.replayRequest('p');

    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it('a meter that throws does NOT fail the generation', async () => {
    mockRecordAiUsage.mockRejectedValueOnce(new Error('database is on fire'));

    const svc = new AIService('claude', CONFIG, 'demo.myshopify.com');
    vi.spyOn(svc as any, '_executeAIRequestInner').mockResolvedValue(
      inner('the answer', {
        inputTokens: 1,
        outputTokens: 1,
        model: 'm',
        source: 'provider',
      }),
    );

    await expect(svc.replayRequest('p')).resolves.toBe('the answer');
  });

  it('does not meter a call the provider never completed', async () => {
    const svc = new AIService('claude', CONFIG, 'demo.myshopify.com');
    vi.spyOn(svc as any, '_executeAIRequestInner').mockRejectedValue(new Error('provider down'));

    await expect(svc.replayRequest('p')).rejects.toThrow('provider down');
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });
});
