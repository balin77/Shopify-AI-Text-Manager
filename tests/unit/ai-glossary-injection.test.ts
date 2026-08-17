import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Central glossary injection (docs/plans/GLOSSARY_IMPLEMENTATION_PLAN.md
 * Phase 2): AIService loads the shop glossary lazily and appends the
 * directive block to every translation prompt — these tests capture the
 * prompt that reaches the provider and assert the block's presence/absence.
 */
const mockState = vi.hoisted(() => ({
  prompts: [] as string[],
  response: '',
  glossaryEntries: [] as any[],
  findManyImpl: null as null | (() => Promise<any[]>),
  findManyCalls: 0,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: vi.fn(async (args: any) => {
        mockState.prompts.push(args.messages[0].content);
        return { content: [{ type: 'text', text: mockState.response }] };
      }),
    };
  },
}));

vi.mock('../../src/services/ai-queue.service', () => ({
  AIQueueService: {
    getInstance: vi.fn().mockReturnValue({
      enqueue: vi.fn(async (_shop, _taskId, _provider, _tokens, fn) => fn()),
    }),
  },
}));

vi.mock('../../app/db.server', () => ({
  db: {
    task: { update: vi.fn() },
    glossaryEntry: {
      findMany: vi.fn(async () => {
        mockState.findManyCalls++;
        if (mockState.findManyImpl) return mockState.findManyImpl();
        return mockState.glossaryEntries;
      }),
    },
  },
}));

import { AIService } from '../../src/services/ai.service';

const SHOP = 'glossary-test.myshopify.com';

function makeService() {
  return new AIService('claude', { claudeApiKey: 'test-key' }, SHOP);
}

function makeShoplessService() {
  return new AIService('claude', { claudeApiKey: 'test-key' });
}

/** Stored-entry shape as listGlossaryEntries returns it (incl. translations). */
function entry(
  sourceTerm: string,
  opts: { doNotTranslate?: boolean; caseSensitive?: boolean; translations?: Record<string, string> } = {},
) {
  return {
    id: `id_${sourceTerm}`,
    shop: SHOP,
    sourceTerm,
    sourceLocale: 'de',
    doNotTranslate: !!opts.doNotTranslate,
    caseSensitive: !!opts.caseSensitive,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    translations: Object.entries(opts.translations ?? {}).map(([locale, value], i) => ({
      id: `t_${sourceTerm}_${i}`,
      entryId: `id_${sourceTerm}`,
      locale,
      value,
    })),
  };
}

beforeEach(() => {
  mockState.prompts.length = 0;
  mockState.response = '';
  mockState.glossaryEntries = [];
  mockState.findManyImpl = null;
  mockState.findManyCalls = 0;
});

describe('AIService glossary injection', () => {
  it('translateContent appends the directive when a term occurs in the source', async () => {
    mockState.glossaryEntries = [
      entry('Hoodie', { translations: { fr: 'sweat à capuche' } }),
    ];
    mockState.response = 'Le Hoodie est chaud';

    const result = await makeService().translateContent('Der Hoodie ist warm', 'de', 'fr');

    expect(result).toBe('Le Hoodie est chaud');
    expect(mockState.prompts).toHaveLength(1);
    expect(mockState.prompts[0]).toContain('Glossary (terminology) rules');
    expect(mockState.prompts[0]).toContain('Always translate "Hoodie" as "sweat à capuche" (fr)');
  });

  it('translateContent omits the directive when no term matches the source text', async () => {
    mockState.glossaryEntries = [
      entry('Zelt', { translations: { fr: 'tente' } }),
    ];
    mockState.response = 'Bonjour';

    await makeService().translateContent('Hallo Welt', 'de', 'fr');

    expect(mockState.prompts[0]).not.toContain('Glossary');
  });

  it('translateContent skips the AI call when the whole text is a doNotTranslate term', async () => {
    mockState.glossaryEntries = [entry('T-Rex Bike', { doNotTranslate: true })];

    const result = await makeService().translateContent('T-Rex Bike', 'de', 'fr');

    expect(result).toBe('T-Rex Bike');
    expect(mockState.prompts).toHaveLength(0); // no provider call at all
  });

  it('translateFields injects only rules for the requested target locales', async () => {
    mockState.glossaryEntries = [
      entry('Hoodie', { translations: { fr: 'sweat à capuche', it: 'felpa' } }),
      entry('Acme', { doNotTranslate: true }),
    ];
    mockState.response = JSON.stringify({ fr: { title: 'Le Acme Hoodie' } });

    await makeService().translateFields({ title: 'Acme Hoodie kaufen' }, ['fr'], 'product');

    const prompt = mockState.prompts[0];
    expect(prompt).toContain('Do NOT translate');
    expect(prompt).toContain('"Acme"');
    expect(prompt).toContain('sweat à capuche');
    expect(prompt).not.toContain('felpa'); // it not requested
  });

  it('translateBatchValues injects the directive for matching values', async () => {
    mockState.glossaryEntries = [entry('Acme', { doNotTranslate: true })];
    mockState.response = JSON.stringify(['Acme perceuse', 'marteau']);

    const out = await makeService().translateBatchValues(
      ['Acme Bohrer', 'Hammer'],
      'de',
      'fr',
      'widget content',
    );

    expect(out).toEqual(['Acme perceuse', 'marteau']);
    expect(mockState.prompts[0]).toContain('Do NOT translate');
  });

  it('loads the glossary only ONCE per instance (lazy + cached)', async () => {
    mockState.glossaryEntries = [entry('Acme', { doNotTranslate: true })];
    mockState.response = 'x';

    const service = makeService();
    await service.translateContent('Acme eins', 'de', 'fr');
    await service.translateContent('Acme zwei', 'de', 'fr');
    mockState.response = JSON.stringify(['Acme trois']);
    await service.translateBatchValues(['Acme drei'], 'de', 'fr');

    expect(mockState.findManyCalls).toBe(1);
  });

  it('a broken glossary never blocks the translation (fail-open)', async () => {
    mockState.findManyImpl = async () => {
      throw new Error('db down');
    };
    mockState.response = 'Bonjour';

    const result = await makeService().translateContent('Hallo', 'de', 'fr');

    expect(result).toBe('Bonjour');
    expect(mockState.prompts[0]).not.toContain('Glossary');
  });

  it('without a shop context the glossary is never queried', async () => {
    mockState.response = 'Bonjour';

    await makeShoplessService().translateContent('Hallo', 'de', 'fr');

    expect(mockState.findManyCalls).toBe(0);
  });
});
