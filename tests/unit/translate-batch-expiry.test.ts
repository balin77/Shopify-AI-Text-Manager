/**
 * The ABSOLUTE END of an open batch run (PLAN_BULK_TRANSLATE_BATCHING 19.4, M4):
 * a run still open after OPEN_BATCH_MAX_AGE_MS is closed -- unless a poller holds
 * a valid lease on it (mid collection) -- and the Tasks tab never hides an open
 * batch task behind its 24 h date window. The HOLD is settled by the guiding rule
 * (PLAN 16): read the counts where the credentials module allows it, book the
 * upper bound where not, release only on proof -- and BEFORE the row is marked
 * done.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  rows: [] as any[],
  claimCount: 1,
  flipCount: 1,
  findManyArgs: null as any,
  order: [] as string[],
  batchUpdate: vi.fn(async (_a: any) => ({ count: 1 })),
  taskUpdate: vi.fn(async (_a: any) => ({ count: 1 })),
  release: vi.fn(async (_id: string) => ({ applied: true, micros: 1 })),
  convert: vi.fn(async (_id: string, _o?: any) => ({ applied: true, micros: 1 })),
  settle: vi.fn(),
  retrieve: vi.fn(),
  txFails: false,
}));

vi.mock('~/db.server', () => {
  const tx = {
    bulkTranslateBatch: { updateMany: async (a: any) => (h.order.push('row.done'), h.batchUpdate(a), { count: h.flipCount }) },
    task: { updateMany: (a: any) => h.taskUpdate(a) },
  };
  return {
    db: {
      bulkTranslateBatch: {
        findMany: vi.fn(async (a: any) => {
          h.findManyArgs = a;
          return h.rows;
        }),
        updateMany: vi.fn(async (a: any) => {
          h.batchUpdate(a);
          return { count: a.data.leaseToken ? h.claimCount : 1 };
        }),
      },
      $transaction: async (fn: (t: any) => Promise<unknown>) => {
        if (h.txFails) throw new Error('tx failed');
        return fn(tx);
      },
    },
  };
});
vi.mock('~/services/ai/usage-meter.server', () => ({
  releaseBudget: (id: string) => (h.order.push('release'), h.release(id)),
  convertReservation: (id: string, o?: any) => (h.order.push('convert'), h.convert(id, o)),
}));
vi.mock('~/services/ai/ai-credentials.server', () => ({ settlementCredentialsFor: (...a: unknown[]) => h.settle(...a) }));
vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  expireStaleBatches,
  OPEN_BATCH_MAX_AGE_MS,
  BATCH_UNREACHABLE_ERROR,
  BATCH_SUBMIT_UNCONFIRMED_ERROR,
} from '~/services/bulk-editor/translate-batch-expiry.server';
import { serializeManifest } from '~/services/bulk-editor/translate-batch.shared';

const manifest = serializeManifest({
  v: 1, rowType: 'product', moType: '', locales: ['fr'], primaryLocale: 'de', units: 1, cells: [],
  requests: [{ customId: 'tx_p0', kind: 'short', items: [], maxTokens: 500, inputEstimate: 100 }],
  plan: { skippedChanged: 0, failures: [], mismatchesByKey: {}, notStarted: 0 },
  submittedAt: '2026-11-10T00:00:00Z',
});
const row = (over: Record<string, unknown> = {}) => ({
  id: 'row-1', taskId: 'task-1', shop: 's.myshopify.com', source: 'managed', provider: 'claude', model: 'claude-haiku-4-5',
  reservationState: 'held', batchIds: ['msgbatch_1'], manifest, ...over,
});
const COUNTS = (succeeded: number, ended = true) => ({
  providerStatus: ended ? 'ended' : 'in_progress', ended,
  requestCounts: { total: 1, processing: ended ? 0 : 1, succeeded, errored: 0, expired: 0, canceled: 0 },
});

beforeEach(() => {
  h.rows = [];
  h.claimCount = 1;
  h.flipCount = 1;
  h.txFails = false;
  h.order.length = 0;
  for (const fn of [h.batchUpdate, h.taskUpdate, h.release, h.convert, h.settle, h.retrieve]) fn.mockClear();
  h.settle.mockResolvedValue({ ok: true, transport: { retrieve: (...a: unknown[]) => h.retrieve(...a) } });
  h.retrieve.mockResolvedValue(COUNTS(1));
});

describe('expireStaleBatches', () => {
  const now = new Date('2026-11-12T12:00:00Z');

  it('selects only OPEN rows (create_unknown included) older than the limit whose lease is free or expired', async () => {
    await expireStaleBatches(now);
    const where = h.findManyArgs.where;
    expect(where.state.in).toEqual(['submitting', 'create_unknown', 'waiting', 'cancel_requested', 'collecting']);
    expect(where.createdAt.lt).toEqual(new Date(now.getTime() - OPEN_BATCH_MAX_AGE_MS));
    expect(where.OR).toEqual([{ leaseUntil: null }, { leaseUntil: { lt: now } }]);
  });

  it('a batch that RAN is booked pro rata from the counts (never released), the hold is settled BEFORE the row is marked done', async () => {
    h.rows = [row()];
    const res = await expireStaleBatches(now);
    expect(res).toEqual({ expired: 1, failed: 0 });
    expect(h.convert).toHaveBeenCalledWith('row-1', { bookMicros: expect.any(Number) });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.order.indexOf('convert')).toBeLessThan(h.order.indexOf('row.done'));
    expect(h.batchUpdate).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'row-1', leaseToken: expect.any(String) }),
      data: expect.objectContaining({ state: 'done', lastError: BATCH_UNREACHABLE_ERROR }),
    });
    expect(h.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'task-1', status: { in: ['submitting', 'waiting_batch', 'cancel_requested'] } },
      data: { status: 'batch_unreachable', error: BATCH_UNREACHABLE_ERROR, completedAt: now },
    });
  });

  it('the provider PROVES nothing ran (ended, nothing succeeded): the hold goes back', async () => {
    h.rows = [row()];
    h.retrieve.mockResolvedValue(COUNTS(0));
    await expireStaleBatches(now);
    expect(h.release).toHaveBeenCalledWith('row-1');
    expect(h.convert).not.toHaveBeenCalled();
  });

  it('nothing can be read (kill switch on, key gone): the reserved upper bound is booked, never released', async () => {
    h.rows = [row()];
    h.settle.mockResolvedValue({ ok: false, reason: 'managedDisabled' });
    const res = await expireStaleBatches(now);
    expect(res.expired).toBe(1);
    expect(h.convert).toHaveBeenCalledWith('row-1', undefined);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('a batch that never ended is not proof of anything: the upper bound is booked', async () => {
    h.rows = [row()];
    h.retrieve.mockResolvedValue(COUNTS(0, false));
    await expireStaleBatches(now);
    expect(h.convert).toHaveBeenCalledWith('row-1', undefined);
  });

  it('a create of unknown outcome that was never found: the Task fails as batch_submit_unconfirmed and the upper bound is booked', async () => {
    h.rows = [row({ batchIds: [], state: 'create_unknown' })];
    await expireStaleBatches(now);
    expect(h.convert).toHaveBeenCalledWith('row-1', undefined);
    expect(h.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'task-1', status: { in: ['submitting', 'waiting_batch', 'cancel_requested'] } },
      data: { status: 'failed', error: BATCH_SUBMIT_UNCONFIRMED_ERROR, completedAt: now },
    });
  });

  const taskData = () => (h.taskUpdate.mock.calls[0][0] as any).data;

  it('a collect marker in lastError: the Task fails as batch_collect_failed, not "nothing was written"', async () => {
    h.rows = [row({ lastError: 'batch_collect_failed:booking_failed' })];
    await expireStaleBatches(now);
    expect(taskData()).toEqual({ status: 'failed', error: 'batch_collect_failed', completedAt: now });
    expect(h.batchUpdate).toHaveBeenCalledWith({
      where: expect.anything(),
      data: expect.objectContaining({ state: 'done', lastError: 'batch_collect_failed' }),
    });
  });

  it('a managed row whose reservation left "held" (booked): batch_collect_failed', async () => {
    h.rows = [row({ reservationState: 'converted' })];
    await expireStaleBatches(now);
    expect(taskData()).toEqual({ status: 'failed', error: 'batch_collect_failed', completedAt: now });
  });

  it('a released managed reservation is no collect evidence: not batch_collect_failed', async () => {
    h.rows = [row({ reservationState: 'released' })];
    await expireStaleBatches(now);
    expect(taskData().error).not.toBe('batch_collect_failed');
  });

  it('a row the shop removal left open (shop_removed, converted): the Task is cancelled, not a collect failure', async () => {
    h.rows = [row({ lastError: 'shop_removed', reservationState: 'converted' })];
    await expireStaleBatches(now);
    expect(taskData()).toEqual({ status: 'cancelled', error: 'shop_removed', completedAt: now });
  });

  it('a non-managed row with a non-held reservation keeps the unchanged code', async () => {
    h.rows = [row({ source: 'own', reservationState: 'none' })];
    await expireStaleBatches(now);
    expect(taskData().error).toBe(BATCH_UNREACHABLE_ERROR);
  });

  it('consent withdrawn: failed with managed_ai_refused:consentMissing', async () => {
    h.rows = [row({ consentWithdrawnAt: new Date('2026-11-10T00:00:00Z') })];
    await expireStaleBatches(now);
    expect(taskData()).toEqual({ status: 'failed', error: 'managed_ai_refused:consentMissing', completedAt: now });
  });

  it('a row a poller took the lease on between the select and the claim is left alone: no settlement, no task change', async () => {
    h.rows = [row()];
    h.claimCount = 0;
    const res = await expireStaleBatches(now);
    expect(res.expired).toBe(0);
    expect(h.taskUpdate).not.toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('a failing transaction is counted, never thrown, and the next row is still tried', async () => {
    h.rows = [row({ id: 'a', taskId: 'ta' }), row({ id: 'b', taskId: 'tb' })];
    h.txFails = true;
    const res = await expireStaleBatches(now);
    expect(res).toEqual({ expired: 0, failed: 2 });
  });

  it('a settlement that FAILED (bookkeeping) leaves the row open and gives the lease back', async () => {
    h.rows = [row()];
    h.convert.mockResolvedValue({ applied: false, reason: 'failed' } as never);
    h.retrieve.mockResolvedValue(COUNTS(1));
    const res = await expireStaleBatches(now);
    expect(res).toEqual({ expired: 0, failed: 1 });
    expect(h.taskUpdate).not.toHaveBeenCalled();
  });
});

describe('where it is wired', () => {
  const root = join(__dirname, '..', '..');
  it("the scheduler's daily cleanup runs it AND the reservation sweep, so the end holds when the poller is off", () => {
    const src = readFileSync(join(root, 'app/services/sync-scheduler.service.ts'), 'utf8');
    expect(src).toMatch(/expireStaleBatches\(\)/);
    expect(src).toMatch(/releaseSettledReservations\(\)/);
  });

  it('the Tasks tab never filters an open batch task out by the date window', () => {
    const src = readFileSync(join(root, 'app/routes/app.tasks.tsx'), 'utf8');
    expect(src).toMatch(/\{ status: \{ in: \[\.\.\.OPEN_BATCH_TASK_STATUSES\] \} \}/);
    expect(src).toMatch(/where\.OR = \[\{ createdAt: \{ gte: dateFrom \} \}/);
  });
});
