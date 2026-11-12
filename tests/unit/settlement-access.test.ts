/**
 * The settlement accessor (PLAN_BULK_TRANSLATE_BATCHING 19.3): access to a
 * provider batch for SETTLING it (retrieve / results / cancel / deleteFile)
 * without the per-shop gates (consent, budget, pool) -- but never without the
 * deployment's gates (kill switch, dev-build guard), and never as a way to use
 * the operator key for anything else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('~/utils/encryption.server', () => ({
  tryDecryptApiKey: (value: string | null | undefined) => value ?? null,
}));
const warn = vi.fn();
const info = vi.fn();
vi.mock('~/utils/logger.server', () => ({
  logger: { warn: (...a: unknown[]) => warn(...a), error: vi.fn(), info: (...a: unknown[]) => info(...a), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

import {
  settlementCredentialsFor,
  __setSettlementOpsFactoryForTests,
} from '~/services/ai/ai-credentials.server';
import {
  SETTLEMENT_TRANSPORT_METHODS,
  SettlementAccessError,
  SettlementNotImplementedError,
  type SettlementBatchRow,
  type SettlementProviderOps,
} from '~/services/ai/batch-settlement.shared';
import { DEV_APP_CLIENT_ID } from '~/services/dev-plan-override.server';

const ENV_KEYS = [
  'MANAGED_AI_ENABLED',
  'MANAGED_AI_PROVIDER',
  'MANAGED_AI_MODEL',
  'MANAGED_AI_API_KEY',
  'MANAGED_AI_FALLBACK_PROVIDER',
  'MANAGED_AI_FALLBACK_MODEL',
  'MANAGED_AI_FALLBACK_API_KEY',
  'SHOPIFY_API_KEY',
  'APP_ENV',
  'MANAGED_AI_ALLOW_DEV_BUILD',
  'MANAGED_AI_POOL_MICROS',
  'MANAGED_AI_TASTER_POOL_MICROS',
  'MANAGED_AI_FAILOVER_POOL_MICROS',
];
let saved: Record<string, string | undefined>;

const SHOP = 'a.myshopify.com';
const row = (over: Partial<SettlementBatchRow> = {}): SettlementBatchRow => ({
  id: 'row-1',
  taskId: 'task-1',
  shop: SHOP,
  provider: 'claude',
  source: 'managed',
  role: 'default',
  batchIds: ['msgbatch_1', 'msgbatch_2'],
  fileIds: ['file_in'],
  ...over,
});

function configureManaged(provider = 'claude', model = 'claude-haiku-4-5') {
  process.env.MANAGED_AI_ENABLED = 'true';
  process.env.MANAGED_AI_PROVIDER = provider;
  process.env.MANAGED_AI_MODEL = model;
  process.env.MANAGED_AI_API_KEY = 'sk-default-operator';
  process.env.MANAGED_AI_FALLBACK_PROVIDER = 'openai';
  process.env.MANAGED_AI_FALLBACK_MODEL = 'gpt-5-nano';
  process.env.MANAGED_AI_FALLBACK_API_KEY = 'sk-failover-operator';
}

/** Records the key each factory call received -- the only place a test may see it. */
function fakeOps() {
  const seen: Array<{ provider: string; apiKey: string }> = [];
  const calls: string[] = [];
  const ops: SettlementProviderOps = {
    retrieve: vi.fn(async (id: string) => {
      calls.push(`retrieve:${id}`);
      return { providerStatus: 'ended', ended: true, outputFileId: 'file_out', errorFileId: 'file_err' };
    }),
    results: vi.fn((id: string) => {
      calls.push(`results:${id}`);
      return (async function* () {
        yield { customId: 'c1', outcome: 'succeeded' as const, text: 'x' };
      })();
    }),
    cancel: vi.fn(async (id: string) => {
      calls.push(`cancel:${id}`);
      return { providerStatus: 'canceling', ended: false, canceling: true };
    }),
    deleteFile: vi.fn(async (id: string) => {
      calls.push(`deleteFile:${id}`);
    }),
  };
  __setSettlementOpsFactoryForTests((ctx) => {
    seen.push({ provider: ctx.provider, apiKey: ctx.apiKey });
    return ops;
  });
  return { seen, calls, ops };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  warn.mockClear();
  info.mockClear();
});

afterEach(() => {
  __setSettlementOpsFactoryForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('what it requires -- the deployment gates stay', () => {
  it('refuses a managed row when the kill switch is off, with no key lookup', () => {
    configureManaged();
    process.env.MANAGED_AI_ENABLED = 'false';
    const { seen } = fakeOps();
    expect(settlementCredentialsFor(SHOP, row())).toEqual({ ok: false, reason: 'managedDisabled' });
    expect(seen).toHaveLength(0);
  });

  it('an UNSET switch is off too (opt-in, like the resolver)', () => {
    configureManaged();
    delete process.env.MANAGED_AI_ENABLED;
    expect(settlementCredentialsFor(SHOP, row())).toEqual({ ok: false, reason: 'managedDisabled' });
  });

  it('refuses on the dev/custom-app build, even with the switch on and a key configured', () => {
    configureManaged();
    process.env.SHOPIFY_API_KEY = DEV_APP_CLIENT_ID;
    process.env.APP_ENV = 'development';
    const { seen } = fakeOps();
    expect(settlementCredentialsFor(SHOP, row())).toEqual({ ok: false, reason: 'devBuild' });
    expect(seen).toHaveLength(0);
  });

  it('refuses when no credential is configured for the recorded role', () => {
    configureManaged();
    delete process.env.MANAGED_AI_FALLBACK_API_KEY;
    expect(settlementCredentialsFor(SHOP, row({ provider: 'openai', role: 'failover' }))).toEqual({
      ok: false,
      reason: 'noCredential',
    });
  });

  it('refuses a row of another shop', () => {
    configureManaged();
    expect(settlementCredentialsFor('b.myshopify.com', row())).toEqual({ ok: false, reason: 'shopMismatch' });
  });

  it('refuses a provider without a batch API and an unknown source', () => {
    configureManaged();
    expect(settlementCredentialsFor(SHOP, row({ provider: 'gemini' }))).toEqual({
      ok: false,
      reason: 'unsupportedProvider',
    });
    expect(settlementCredentialsFor(SHOP, row({ provider: 'made-up' }))).toEqual({
      ok: false,
      reason: 'unsupportedProvider',
    });
    expect(settlementCredentialsFor(SHOP, row({ source: 'something' }))).toEqual({
      ok: false,
      reason: 'unknownSource',
    });
  });

  it('refuses when the credential of that role now belongs to ANOTHER provider (key would hit the wrong endpoint)', () => {
    configureManaged('openai', 'gpt-5-nano');
    const { seen } = fakeOps();
    expect(settlementCredentialsFor(SHOP, row({ provider: 'claude' }))).toEqual({
      ok: false,
      reason: 'providerChanged',
    });
    expect(seen).toHaveLength(0);
  });
});

describe('what it skips -- the per-shop gates', () => {
  it('works with no consent, no budget and no settings at all (none of them is even an input)', () => {
    configureManaged();
    fakeOps();
    // the signature takes no consent, no budget, no pool: nothing to check
    const decision = settlementCredentialsFor(SHOP, row());
    expect(decision.ok).toBe(true);
  });

  it('uses the key of the RECORDED role, not the default one', () => {
    configureManaged();
    const { seen } = fakeOps();
    expect(settlementCredentialsFor(SHOP, row({ provider: 'claude', role: 'default' })).ok).toBe(true);
    expect(settlementCredentialsFor(SHOP, row({ provider: 'openai', role: 'failover' })).ok).toBe(true);
    expect(seen).toEqual([
      { provider: 'claude', apiKey: 'sk-default-operator' },
      { provider: 'openai', apiKey: 'sk-failover-operator' },
    ]);
  });

  it('a BYO row uses the merchant key of the recorded provider and does not need the kill switch', () => {
    // nothing managed configured at all
    const { seen } = fakeOps();
    const settings = { claudeApiKey: 'sk-merchant', openaiApiKey: 'sk-other' } as never;
    const decision = settlementCredentialsFor(SHOP, row({ source: 'byo', provider: 'claude' }), settings);
    expect(decision.ok).toBe(true);
    expect(seen).toEqual([{ provider: 'claude', apiKey: 'sk-merchant' }]);
  });

  it('a BYO row whose key is gone is refused as ai_key_missing', () => {
    expect(settlementCredentialsFor(SHOP, row({ source: 'byo' }), {} as never)).toEqual({
      ok: false,
      reason: 'ai_key_missing',
    });
    expect(settlementCredentialsFor(SHOP, row({ source: 'byo' }), null)).toEqual({
      ok: false,
      reason: 'ai_key_missing',
    });
  });
});

describe('the transport reaches nothing else', () => {
  function transportOf() {
    configureManaged();
    const rig = fakeOps();
    const decision = settlementCredentialsFor(SHOP, row());
    if (!decision.ok) throw new Error('expected access');
    return { transport: decision.transport, ...rig, decision };
  }

  it('is frozen and exposes exactly retrieve / results / cancel / deleteFile', () => {
    const { transport } = transportOf();
    expect(Object.isFrozen(transport)).toBe(true);
    expect(Object.keys(transport).sort()).toEqual([...SETTLEMENT_TRANSPORT_METHODS].sort());
  });

  it('carries no key anywhere in what a caller can see', () => {
    const { decision } = transportOf();
    const dump = JSON.stringify(decision) + Object.getOwnPropertyNames(decision).join(',');
    expect(dump).not.toContain('sk-default-operator');
    // not even through a stringified method
    for (const fn of Object.values((decision as { transport: object }).transport)) {
      expect(String(fn)).not.toContain('sk-default-operator');
    }
    expect(Object.keys(decision as object).sort()).toEqual(['ok', 'role', 'source', 'transport']);
  });

  it('only touches batches the row names', async () => {
    const { transport, calls } = transportOf();
    await expect(transport.retrieve('msgbatch_FOREIGN')).rejects.toBeInstanceOf(SettlementAccessError);
    await expect(transport.cancel('msgbatch_FOREIGN')).rejects.toMatchObject({ reason: 'batchNotInManifest' });
    expect(() => transport.results('msgbatch_FOREIGN')).toThrow(SettlementAccessError);
    expect(calls).toEqual([]);

    await transport.retrieve('msgbatch_1');
    await transport.cancel('msgbatch_2');
    expect(calls).toEqual(['retrieve:msgbatch_1', 'cancel:msgbatch_2']);
  });

  it('deletes only files the row uploaded or the provider reported for its batches', async () => {
    const { transport, calls } = transportOf();
    await expect(transport.deleteFile('file_someone_elses')).rejects.toMatchObject({ reason: 'fileNotOwned' });
    await transport.deleteFile('file_in'); // recorded at submit
    // an output file only becomes deletable after the transport saw it reported
    await expect(transport.deleteFile('file_out')).rejects.toBeInstanceOf(SettlementAccessError);
    await transport.retrieve('msgbatch_1');
    await transport.deleteFile('file_out');
    await transport.deleteFile('file_err');
    expect(calls).toEqual(['deleteFile:file_in', 'retrieve:msgbatch_1', 'deleteFile:file_out', 'deleteFile:file_err']);
  });

  it('hands results() the file ids the last retrieve reported', async () => {
    const { transport, ops } = transportOf();
    await transport.retrieve('msgbatch_1');
    const it = transport.results('msgbatch_1');
    expect(ops.results).toHaveBeenCalledWith('msgbatch_1', { outputFileId: 'file_out', errorFileId: 'file_err' });
    const items = [];
    for await (const item of it) items.push(item);
    expect(items).toHaveLength(1);
  });

  it('logs every use with shop, task and action -- never the key', async () => {
    const { transport } = transportOf();
    await transport.retrieve('msgbatch_1');
    await transport.cancel('msgbatch_1');
    const logged = info.mock.calls.map((c) => c[1]);
    expect(logged).toEqual([
      { shop: SHOP, taskId: 'task-1', action: 'retrieve', source: 'managed' },
      { shop: SHOP, taskId: 'task-1', action: 'cancel', source: 'managed' },
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toContain('sk-default-operator');
  });

  it('every refusal is logged too (and names no key)', () => {
    configureManaged();
    process.env.MANAGED_AI_ENABLED = 'false';
    settlementCredentialsFor(SHOP, row());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-default-operator');
  });
});

describe('before the provider calls exist', () => {
  it('the default operations answer SettlementNotImplementedError, not a silent success', async () => {
    configureManaged();
    __setSettlementOpsFactoryForTests(null);
    const decision = settlementCredentialsFor(SHOP, row());
    if (!decision.ok) throw new Error('expected access');
    await expect(decision.transport.cancel('msgbatch_1')).rejects.toBeInstanceOf(SettlementNotImplementedError);
    await expect(decision.transport.retrieve('msgbatch_1')).rejects.toBeInstanceOf(SettlementNotImplementedError);
  });

  it('the test seam refuses to run outside tests', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => __setSettlementOpsFactoryForTests(() => ({}) as never)).toThrow(/test seam/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
