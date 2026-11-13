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
  convert: vi.fn(async (_id: string, _o?: unknown): Promise<unknown> => ({ applied: true, micros: 100 })),
  heldRows: [] as any[],
}));

vi.mock('~/db.server', () => ({
  db: {
    bulkTranslateBatch: {
      findMany: vi.fn(async (args: any) => {
        if (h.findManyError) throw h.findManyError;
        // the sweep of OTHER rows that still hold a reservation
        if (args?.where?.reservationState === 'held') return h.heldRows;
        return h.rows;
      }),
      // the settlement accessor re-loads the row by id inside ai-credentials
      findUnique: vi.fn(async ({ where }: any) => [...h.rows, ...h.heldRows].find((r) => r.id === where.id) ?? null),
      updateMany: (a: unknown) => h.batchUpdateMany(a),
    },
    task: { updateMany: (a: unknown) => h.taskUpdateMany(a) },
    aISettings: { findUnique: vi.fn(async () => h.settings) },
  },
}));
vi.mock('~/services/ai/usage-meter.server', () => ({
  releaseBudget: (id: string) => h.release(id),
  convertReservation: (id: string, o?: unknown) => h.convert(id, o),
}));
vi.mock('~/utils/encryption.server', () => ({ tryDecryptApiKey: (v: string | null | undefined) => v ?? null }));
const warn = vi.fn();
vi.mock('~/utils/logger.server', () => ({
  logger: { warn: (...a: unknown[]) => warn(...a), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  loggers: { ai: vi.fn() },
}));

import {
  cancelOpenBatches,
  OPEN_BATCH_STATES,
  OVERALL_DEADLINE_MS,
  PROVIDER_CALL_DEADLINE_MS,
} from '~/services/bulk-editor/translate-batch-cancel.server';
import { __setSettlementOpsFactoryForTests } from '~/services/ai/ai-credentials.server';
import type { SettlementProviderOps } from '~/services/ai/batch-settlement.shared';

const SHOP = 'a.myshopify.com';
const ENV = [
  'MANAGED_AI_ENABLED', 'MANAGED_AI_PROVIDER', 'MANAGED_AI_MODEL', 'MANAGED_AI_API_KEY',
  'SHOPIFY_API_KEY', 'APP_ENV',
];
let saved: Record<string, string | undefined>;

const MANIFEST = JSON.stringify({
  v: 1, rowType: 'product', moType: '', locales: ['fr'], primaryLocale: 'de', units: 1, cells: [],
  requests: [{ customId: 'tx_p0', kind: 'short', items: [], maxTokens: 500, inputEstimate: 100 }],
  plan: { skippedChanged: 0, failures: [], mismatchesByKey: {}, notStarted: 0 },
  submittedAt: '2026-11-10T00:00:00Z',
});
const row = (over: Record<string, unknown> = {}) => ({
  id: 'row-1',
  taskId: 'task-1',
  shop: SHOP,
  state: 'waiting',
  provider: 'claude',
  model: 'claude-haiku-4-5',
  reservationState: 'held',
  manifest: MANIFEST,
  source: 'managed',
  role: 'default',
  batchIds: ['msgbatch_1', 'msgbatch_2'],
  fileIds: ['file_in'],
  ...over,
});

const ENDED = (succeeded: number) => ({
  providerStatus: 'ended', ended: true,
  requestCounts: { total: 2, processing: 0, succeeded, errored: 0, expired: 0, canceled: 2 - succeeded },
});
const RUNNING = async () => ({ providerStatus: 'canceling', ended: false });

function opsRig(overrides: Partial<SettlementProviderOps> = {}) {
  const calls: string[] = [];
  const ops: SettlementProviderOps = {
    // default: the provider PROVES nothing ran (ended, nothing succeeded)
    retrieve: vi.fn(async () => ENDED(0)),
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
  h.heldRows = [];
  h.findManyError = null;
  h.settings = null;
  h.batchUpdateMany.mockClear();
  h.taskUpdateMany.mockClear();
  h.release.mockClear();
  h.convert.mockClear();
  h.release.mockResolvedValue({ applied: true, micros: 100 });
  h.convert.mockResolvedValue({ applied: true, micros: 100 });
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
    expect(await cancelOpenBatches(SHOP)).toEqual({ rows: 0, cancelled: 0, failed: 0, released: 0, converted: 0 });
    expect(calls).toEqual([]);
    expect(h.batchUpdateMany).not.toHaveBeenCalled();
  });

  it('marks the row (state only, conditional), flips the task, cancels every batch, deletes the files, releases the hold', async () => {
    h.rows = [row()];
    const { calls } = opsRig();

    const res = await cancelOpenBatches(SHOP);

    expect(res).toEqual({ rows: 1, cancelled: 2, failed: 0, released: 1, converted: 0 });
    expect(calls).toEqual(['cancel:msgbatch_1', 'cancel:msgbatch_2', 'deleteFile:file_in']);
    expect(h.batchUpdateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', state: { in: [...OPEN_BATCH_STATES] } },
      data: { state: 'cancel_requested' },
    });
    // never the manifest
    expect(Object.keys((h.batchUpdateMany.mock.calls[0] as any[])[0].data)).not.toContain('manifest');
    expect(h.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: 'task-1', shop: SHOP, status: { in: ['submitting', 'waiting_batch', 'cancel_requested'] } },
      data: { status: 'cancel_requested' },
    });
    expect(h.release).toHaveBeenCalledWith('row-1');
    // L5: the row is CLOSED and its task settled, not left in cancel_requested
    expect(h.batchUpdateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', state: { in: [...OPEN_BATCH_STATES] } },
      data: { state: 'done', lastError: null },
    });
    expect(h.taskUpdateMany).toHaveBeenCalledWith({
      where: { id: 'task-1', shop: SHOP, status: { in: ['submitting', 'waiting_batch', 'cancel_requested'] } },
      data: { status: 'cancelled', completedAt: expect.any(Date) },
    });
  });

  it('a batch that RAN before the cancel arrived is booked pro rata from the counts, not released (the cancel call proves nothing)', async () => {
    h.rows = [row()];
    opsRig({ retrieve: vi.fn(async () => ENDED(1)) });
    const res = await cancelOpenBatches(SHOP);
    expect(res).toMatchObject({ released: 0, converted: 1 });
    expect(h.convert).toHaveBeenCalledWith('row-1', { bookMicros: expect.any(Number) });
    expect(h.release).not.toHaveBeenCalled();
  });

  it('a cancel that has not taken effect yet (canceling): nothing is proven, the upper bound is booked (the last look)', async () => {
    h.rows = [row()];
    opsRig({ retrieve: vi.fn(RUNNING) });
    const res = await cancelOpenBatches(SHOP);
    expect(res).toMatchObject({ released: 0, converted: 1 });
    expect(h.convert).toHaveBeenCalledWith('row-1', undefined);
  });

  it('looks only at OPEN states of this shop', async () => {
    const { calls } = opsRig();
    h.rows = [];
    await cancelOpenBatches(SHOP);
    expect(calls).toEqual([]);
    expect([...OPEN_BATCH_STATES]).toEqual(['submitting', 'create_unknown', 'waiting', 'cancel_requested', 'collecting']);
  });

  it('a provider that fails does not stop the rest, and the row is still marked and the hold released', async () => {
    h.rows = [row()];
    const calls: string[] = [];
    opsRig({
      retrieve: vi.fn(RUNNING),
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

    // one cancel was not confirmed: that batch may still bill, so the hold is BOOKED (M5), not released
    expect(res).toMatchObject({ rows: 1, cancelled: 1, failed: 1, released: 0, converted: 1 });
    expect(calls).toContain('cancel:msgbatch_2');
    expect(calls).toContain('deleteFile:file_in');
    expect(h.convert).toHaveBeenCalledWith('row-1', undefined);
    expect(h.release).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('provider 503'))).toBe(true);
    // the unconfirmed cancel keeps the row open for the poller: never closed here, no cancelRequestedAt
    expect(h.batchUpdateMany.mock.calls.some((c: any[]) => c[0].data.state === 'done')).toBe(false);
    expect(h.batchUpdateMany.mock.calls.some((c: any[]) => c[0].data.cancelRequestedAt)).toBe(false);
    // no marker is written: the row's state is left untouched (the expiry reads the Task's cancel_requested)
    expect(h.batchUpdateMany.mock.calls.some((c: any[]) => 'lastError' in c[0].data && !c[0].data.state)).toBe(false);
  });

  it('a provider that cannot be reached: the rows are still marked, the hold is BOOKED (not released), nothing throws', async () => {
    h.rows = [row({ provider: 'openai' })]; // no real provider calls for openai yet: the stub says so
    process.env.MANAGED_AI_PROVIDER = 'openai';
    process.env.MANAGED_AI_MODEL = 'gpt-5-nano';
    __setSettlementOpsFactoryForTests(null);
    const res = await cancelOpenBatches(SHOP);
    expect(res.rows).toBe(1);
    expect(res.cancelled).toBe(0);
    expect(res.failed).toBeGreaterThan(0);
    expect(res.released).toBe(0);
    expect(res.converted).toBe(1);
    expect(h.batchUpdateMany).toHaveBeenCalled();
  });

  it('no settlement access (kill switch off) is logged and counted, the row is still marked', async () => {
    h.rows = [row()];
    const { calls } = opsRig();
    process.env.MANAGED_AI_ENABLED = 'false';
    const res = await cancelOpenBatches(SHOP);
    // no settlement access = no confirmed cancel: the hold becomes the charge
    expect(res).toMatchObject({ rows: 1, cancelled: 0, failed: 1, released: 0, converted: 1 });
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

  it('a row still submitting with no batch id yet cancels nothing at the provider; its create may have been sent, so the hold is BOOKED, not released', async () => {
    h.rows = [row({ state: 'submitting', batchIds: [], fileIds: [] })];
    const { calls } = opsRig();
    const res = await cancelOpenBatches(SHOP);
    expect(res).toEqual({ rows: 1, cancelled: 0, failed: 0, released: 0, converted: 1 });
    expect(calls).toEqual([]);
    expect(h.release).not.toHaveBeenCalled();
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

  it('settles the hold of EVERY other row of the shop that still holds one, whatever its state (M2): a done row that never named a batch is released', async () => {
    h.rows = [row()];
    h.heldRows = [
      row({ id: 'row-done', taskId: 'task-done', state: 'done', batchIds: [], fileIds: [], reservationState: 'held' }),
      row({ id: 'row-1', reservationState: 'held' }), // an open row is handled once, not twice
    ];
    opsRig();
    const res = await cancelOpenBatches(SHOP);
    expect(h.release.mock.calls.map((c) => c[0]).sort()).toEqual(['row-1', 'row-done']);
    expect(res.released).toBe(2);
  });

  it('a provider call that hangs hits its own deadline: the redaction does not wait for it, the hold is booked', async () => {
    vi.useFakeTimers();
    try {
      h.rows = [row({ batchIds: ['msgbatch_1'], fileIds: [] })];
      opsRig({ retrieve: vi.fn(RUNNING), cancel: vi.fn(() => new Promise<never>(() => undefined)) });
      const pending = cancelOpenBatches(SHOP);
      await vi.advanceTimersByTimeAsync(PROVIDER_CALL_DEADLINE_MS + 100);
      const res = await pending;
      expect(res).toMatchObject({ cancelled: 0, failed: 1, converted: 1, released: 0 });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('exceeded'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('after the overall deadline further provider calls are skipped and counted, never hung on', async () => {
    vi.useFakeTimers();
    try {
      h.rows = [
        row({ id: 'a', taskId: 'ta', batchIds: ['b1'], fileIds: [] }),
        row({ id: 'b', taskId: 'tb', batchIds: ['b2'], fileIds: [] }),
      ];
      const cancel = vi.fn(() => new Promise<never>(() => undefined));
      opsRig({ cancel, retrieve: vi.fn(RUNNING) });
      const pending = cancelOpenBatches(SHOP);
      // first row hangs 15 s; push the clock past the overall deadline before the second row starts
      await vi.advanceTimersByTimeAsync(OVERALL_DEADLINE_MS + 1000);
      const res = await pending;
      expect(res.rows).toBe(2);
      expect(cancel.mock.calls.length).toBeLessThanOrEqual(2);
      expect(res.converted).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
