/**
 * cancelOpenBatches (PLAN_BULK_TRANSLATE_BATCHING 6.7): the seam GDPR redaction
 * and the uninstall cleanup call BEFORE they delete the shop's Task / batch
 * rows. Best effort, logged, NEVER blocking: marks the rows, cancels at the
 * provider through the settlement transport, deletes the files the run
 * uploaded, releases the hold -- and survives a down provider, a missing
 * credential and a failed lookup without throwing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as any[],
  findManyError: null as Error | null,
  settings: null as any,
  batchUpdateMany: vi.fn(async (_a: unknown) => ({ count: 1 })),
  taskUpdateMany: vi.fn(async (_a: unknown) => ({ count: 1 })),
  release: vi.fn(async (_id: string): Promise<unknown> => ({ applied: true, micros: 100 })),
}));

vi.mock('~/db.server', () => ({
  db: {
    bulkTranslateBatch: {
      findMany: vi.fn(async () => {
        if (h.findManyError) throw h.findManyError;
        return h.rows;
      }),
      updateMany: (a: unknown) => h.batchUpdateMany(a),
    },
    task: { updateMany: (a: unknown) => h.taskUpdateMany(a) },
    aISettings: { findUnique: vi.fn(async () => h.settings) },
  },
}));
vi.mock('~/services/ai/usage-meter.server', () => ({ releaseBudget: (id: string) => h.release(id) }));
vi.mock('~/utils/encryption.server', () => ({ tryDecryptApiKey: (v: string | null | undefined) => v ?? null }));
const warn = vi.fn();
vi.mock('~/utils/logger.server', () => ({
  logger: { warn: (...a: unknown[]) => warn(...a), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

import { cancelOpenBatches, OPEN_BATCH_STATES } from '~/services/bulk-editor/translate-batch-cancel.server';
import { __setSettlementOpsFactoryForTests } from '~/services/ai/ai-credentials.server';
import type { SettlementProviderOps } from '~/services/ai/batch-settlement.shared';

const SHOP = 'a.myshopify.com';
const ENV = [
  'MANAGED_AI_ENABLED', 'MANAGED_AI_PROVIDER', 'MANAGED_AI_MODEL', 'MANAGED_AI_API_KEY',
  'SHOPIFY_API_KEY', 'APP_ENV',
];
let saved: Record<string, string | undefined>;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'row-1',
  taskId: 'task-1',
  shop: SHOP,
  state: 'waiting',
  provider: 'claude',
  source: 'managed',
  role: 'default',
  batchIds: ['msgbatch_1', 'msgbatch_2'],
  fileIds: ['file_in'],
  ...over,
});

function opsRig(overrides: Partial<SettlementProviderOps> = {}) {
  const calls: string[] = [];
  const ops: SettlementProviderOps = {
    retrieve: vi.fn(async () => ({ providerStatus: 'x', ended: false })),
    results: vi.fn(() => (async function* () {})()),
    cancel: vi.fn(async (id: string) => {
      calls.push(`cancel:${id}`);
      return { providerStatus: 'canceling', ended: false, canceling: true };
    }),
    deleteFile: vi.fn(async (id: string) => {
      calls.push(`deleteFile:${id}`);
    }),
    ...overrides,
  };
  __setSettlementOpsFactoryForTests(() => ops);
  return { calls, ops };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.MANAGED_AI_ENABLED = 'true';
  process.env.MANAGED_AI_PROVIDER = 'claude';
  process.env.MANAGED_AI_MODEL = 'claude-haiku-4-5';
  process.env.MANAGED_AI_API_KEY = 'sk-operator';
  h.rows = [];
  h.findManyError = null;
  h.settings = null;
  h.batchUpdateMany.mockClear();
  h.taskUpdateMany.mockClear();
  h.release.mockClear();
  h.release.mockResolvedValue({ applied: true, micros: 100 });
  warn.mockClear();
});
afterEach(() => {
  __setSettlementOpsFactoryForTests(null);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('cancelOpenBatches', () => {
  it('a shop with no open batch is a no-op', async () => {
    const { calls } = opsRig();
    expect(await cancelOpenBatches(SHOP)).toEqual({ rows: 0, cancelled: 0, failed: 0, released: 0 });
    expect(calls).toEqual([]);
    expect(h.batchUpdateMany).not.toHaveBeenCalled();
  });

  it('marks the row (state only, conditional), flips the task, cancels every batch, deletes the files, releases the hold', async () => {
    h.rows = [row()];
    const { calls } = opsRig();

    const res = await cancelOpenBatches(SHOP);

    expect(res).toEqual({ rows: 1, cancelled: 2, failed: 0, released: 1 });
    expect(calls).toEqual(['cancel:msgbatch_1', 'cancel:msgbatch_2', 'deleteFile:file_in']);
    expect(h.batchUpdateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', state: { in: [...OPEN_BATCH_STATES] } },
      data: { state: 'cancel_requested', cancelRequestedAt: expect.any(Date) },
    });
    // never the manifest
    expect(Object.keys((h.batchUpdateMany.mock.calls[0] as any[])[0].data)).not.toContain('manifest');
    expect(h.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: 'task-1', shop: SHOP, status: { in: ['submitting', 'waiting_batch', 'cancel_requested'] } },
      data: { status: 'cancel_requested' },
    });
    expect(h.release).toHaveBeenCalledWith('row-1');
  });

  it('looks only at OPEN states of this shop', async () => {
    const { calls } = opsRig();
    h.rows = [];
    await cancelOpenBatches(SHOP);
    expect(calls).toEqual([]);
    expect([...OPEN_BATCH_STATES]).toEqual(['submitting', 'waiting', 'cancel_requested', 'collecting']);
  });

  it('a provider that fails does not stop the rest, and the row is still marked and the hold released', async () => {
    h.rows = [row()];
    const calls: string[] = [];
    opsRig({
      cancel: vi.fn(async (id: string) => {
        calls.push(`cancel:${id}`);
        if (id === 'msgbatch_1') throw new Error('provider 503');
        return { providerStatus: 'canceling', ended: false };
      }),
      deleteFile: vi.fn(async (id: string) => {
        calls.push(`deleteFile:${id}`);
      }),
    });

    const res = await cancelOpenBatches(SHOP);

    expect(res).toMatchObject({ rows: 1, cancelled: 1, failed: 1, released: 1 });
    expect(calls).toContain('cancel:msgbatch_2');
    expect(calls).toContain('deleteFile:file_in');
    expect(h.release).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('provider 503'))).toBe(true);
  });

  it('before the provider calls exist (default stub) the rows are still marked and the hold released, nothing throws', async () => {
    h.rows = [row()];
    __setSettlementOpsFactoryForTests(null);
    const res = await cancelOpenBatches(SHOP);
    expect(res.rows).toBe(1);
    expect(res.cancelled).toBe(0);
    expect(res.failed).toBeGreaterThan(0);
    expect(res.released).toBe(1);
    expect(h.batchUpdateMany).toHaveBeenCalled();
  });

  it('no settlement access (kill switch off) is logged and counted, the row is still marked', async () => {
    h.rows = [row()];
    const { calls } = opsRig();
    process.env.MANAGED_AI_ENABLED = 'false';
    const res = await cancelOpenBatches(SHOP);
    expect(res).toMatchObject({ rows: 1, cancelled: 0, failed: 1, released: 1 });
    expect(calls).toEqual([]);
    expect(h.batchUpdateMany).toHaveBeenCalled();
  });

  it('a BYO row uses the merchant key from the shop settings', async () => {
    h.rows = [row({ source: 'byo', batchIds: ['msgbatch_9'], fileIds: [] })];
    h.settings = { claudeApiKey: 'sk-merchant' };
    const seen: string[] = [];
    const calls: string[] = [];
    __setSettlementOpsFactoryForTests((ctx) => {
      seen.push(ctx.apiKey);
      return {
        retrieve: vi.fn(), results: vi.fn(), deleteFile: vi.fn(),
        cancel: vi.fn(async (id: string) => { calls.push(id); return { providerStatus: 'c', ended: false }; }),
      } as never;
    });
    const res = await cancelOpenBatches(SHOP);
    expect(res).toMatchObject({ cancelled: 1, failed: 0 });
    expect(seen).toEqual(['sk-merchant']);
    expect(calls).toEqual(['msgbatch_9']);
  });

  it('a row still submitting with no batch id yet cancels nothing at the provider but is marked and its hold released', async () => {
    h.rows = [row({ state: 'submitting', batchIds: [], fileIds: [] })];
    const { calls } = opsRig();
    const res = await cancelOpenBatches(SHOP);
    expect(res).toEqual({ rows: 1, cancelled: 0, failed: 0, released: 1 });
    expect(calls).toEqual([]);
  });

  it('a failing lookup is reported in the result and never thrown', async () => {
    h.findManyError = new Error('db down');
    const res = await cancelOpenBatches(SHOP);
    expect(res.error).toBe('db down');
    expect(res.rows).toBe(0);
  });

  it('a failing release is counted, not thrown, and the next row is still processed', async () => {
    h.rows = [row(), row({ id: 'row-2', taskId: 'task-2', batchIds: ['msgbatch_7'], fileIds: [] })];
    opsRig();
    h.release.mockRejectedValueOnce(new Error('tx failed'));
    const res = await cancelOpenBatches(SHOP);
    expect(res.rows).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.released).toBe(1);
  });
});
