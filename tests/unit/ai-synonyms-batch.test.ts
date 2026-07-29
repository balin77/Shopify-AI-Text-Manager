import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIService } from '../../src/services/ai.service';
import type { AIServiceConfig } from '../../src/services/ai.service';

/**
 * `AIService.generateSynonymsBatch` — the batched anchor-synonym call behind
 * the internal-linking scan (app/services/seo/internal-links.service.ts).
 *
 * The batching itself is the point: the first implementation issued one AI
 * request per target item, so one "Vorschläge generieren" click cost up to 200
 * requests. These tests pin the two properties the matcher depends on:
 *   1. N terms in → N synonym lists out, positionally aligned.
 *   2. Anything unexpected (bad shape, wrong length, provider error) degrades
 *      to EMPTY lists — never a mis-aligned mapping (which would silently
 *      attach product A's synonyms to product B) and never a thrown error
 *      (which would fail the whole scan over a nice-to-have).
 */

// The real Anthropic SDK refuses to construct in a browser-like (jsdom) env;
// every AI test in this suite stubs it the same way. The provider is never
// actually reached here — `executeAIRequest` is spied per test.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: vi.fn() };
  },
}));

vi.mock('../../src/services/ai-queue.service', () => ({
  AIQueueService: {
    getInstance: vi.fn().mockReturnValue({
      enqueue: vi.fn(async (_shop: unknown, _taskId: unknown, _provider: unknown, _tokens: unknown, fn: () => unknown) => fn()),
    }),
  },
}));

vi.mock('../../app/db.server', () => ({
  db: { task: { update: vi.fn() } },
}));

const CONFIG: AIServiceConfig = { claudeApiKey: 'test-claude-key' };

describe('AIService.generateSynonymsBatch', () => {
  let svc: AIService;
  let prompts: string[];

  const respondWith = (text: string) => {
    vi.spyOn(svc as any, 'executeAIRequest').mockImplementation(async (prompt: unknown) => {
      prompts.push(String(prompt));
      return text;
    });
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    prompts = [];
    svc = new AIService('claude', CONFIG);
  });

  it('returns one synonym list per term, in order, from a single request', async () => {
    respondWith('[["Blumenvase", "Ziervase"], [], ["Übertopf"]]');

    const result = await svc.generateSynonymsBatch(['Keramikvase', 'Stifthalter', 'Blumentopf'], 'de');

    expect(result).toEqual([['Blumenvase', 'Ziervase'], [], ['Übertopf']]);
    expect(prompts).toHaveLength(1); // ONE request for three terms
    expect(prompts[0]).toContain('1. "Keramikvase"');
    expect(prompts[0]).toContain('3. "Blumentopf"');
    expect(prompts[0]).toContain('exactly 3 entries');
  });

  it('puts each term\'s already-rejected anchors into the prompt as do-not-repeat', async () => {
    respondWith('[[], []]');

    await svc.generateSynonymsBatch(['Keramikvase', 'Stifthalter'], 'de', {
      avoid: [['Vasi', 'Tonvase'], []],
    });

    expect(prompts[0]).toContain('1. "Keramikvase" — already rejected, do not repeat: "Vasi", "Tonvase"');
    expect(prompts[0]).toContain('2. "Stifthalter"\n');
    expect(prompts[0]).not.toContain('2. "Stifthalter" — already rejected');
  });

  it('caps each list at maxCount and drops blank entries', async () => {
    respondWith('[["one", "  ", "two", "three", "four"]]');

    const result = await svc.generateSynonymsBatch(['term'], 'de', { maxCount: 2 });

    expect(result).toEqual([['one', 'two']]);
  });

  it('degrades to empty lists (never a shifted mapping) when the response length does not match', async () => {
    respondWith('[["a"], ["b"]]'); // 2 lists for 3 terms

    const result = await svc.generateSynonymsBatch(['a', 'b', 'c'], 'de');

    expect(result).toEqual([[], [], []]);
  });

  it('degrades to empty lists when the response is not an array at all', async () => {
    respondWith('sorry, I cannot do that');

    const result = await svc.generateSynonymsBatch(['a', 'b'], 'de');

    expect(result).toEqual([[], []]);
  });

  it('never throws when the provider fails — matching still works without synonyms', async () => {
    vi.spyOn(svc as any, 'executeAIRequest').mockRejectedValue(new Error('provider down'));

    await expect(svc.generateSynonymsBatch(['a', 'b'], 'de')).resolves.toEqual([[], []]);
  });

  it('makes no request for an empty batch', async () => {
    respondWith('[]');

    expect(await svc.generateSynonymsBatch([], 'de')).toEqual([]);
    expect(prompts).toHaveLength(0);
  });
});
