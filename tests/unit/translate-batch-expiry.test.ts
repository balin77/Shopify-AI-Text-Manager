/**
 * The ABSOLUTE END of an open batch run (PLAN_BULK_TRANSLATE_BATCHING 19.4, M4):
 * a run still open after OPEN_BATCH_MAX_AGE_MS is closed as batch_unreachable
 * with its hold released -- unless a poller holds a valid lease on it (mid
 * collection) -- and the Tasks tab never hides an open batch task behind its
 * 24 h date window.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  rows: [] as any[],
  flipCount: 1,
  findManyArgs: null as any,
  batchUpdate: vi.fn(async (_a: any) => ({ count: 1 })),
  taskUpdate: vi.fn(async (_a: any) => ({ count: 1 })),
  release: vi.fn(async (_id: string) => ({ applied: true, micros: 1 })),
  txFails: false,
}));

vi.mock('~/db.server', () => {
  const tx = {
    bulkTranslateBatch: { updateMany: async (a: any) => (h.batchUpdate(a), { count: h.flipCount }) },
    task: { updateMany: (a: any) => h.taskUpdate(a) },
  };
  return {
    db: {
      bulkTranslateBatch: {
        findMany: vi.fn(async (a: any) => {
          h.findManyArgs = a;
          return h.rows;
        }),
      },
      $transaction: async (fn: (t: any) => Promise<unknown>) => {
        if (h.txFails) throw new Error('tx failed');
        return fn(tx);
      },
    },
  };
});
vi.mock('~/services/ai/usage-meter.server', () => ({ releaseBudget: (id: string) => h.release(id) }));
vi.mock('~/utils/logger.server', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  expireStaleBatches,
  OPEN_BATCH_MAX_AGE_MS,
  BATCH_UNREACHABLE_ERROR,
} from '~/services/bulk-editor/translate-batch-expiry.server';

beforeEach(() => {
  h.rows = [];
  h.flipCount = 1;
  h.txFails = false;
  h.batchUpdate.mockClear();
  h.taskUpdate.mockClear();
  h.release.mockClear();
});

describe('expireStaleBatches', () => {
  const now = new Date('2026-11-12T12:00:00Z');

  it('selects only OPEN rows older than the limit whose lease is free or expired', async () => {
    await expireStaleBatches(now);
    const where = h.findManyArgs.where;
    expect(where.state.in).toEqual(['submitting', 'waiting', 'cancel_requested', 'collecting']);
    expect(where.createdAt.lt).toEqual(new Date(now.getTime() - OPEN_BATCH_MAX_AGE_MS));
    expect(where.OR).toEqual([{ leaseUntil: null }, { leaseUntil: { lt: now } }]);
  });

  it('closes the row, fails the task as batch_unreachable (conditionally on open statuses) and releases the hold', async () => {
    h.rows = [{ id: 'row-1', taskId: 'task-1' }];
    const res = await expireStaleBatches(now);
    expect(res).toEqual({ expired: 1, failed: 0 });
    expect(h.batchUpdate).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'row-1', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }),
      data: { state: 'done', lastError: BATCH_UNREACHABLE_ERROR },
    });
    expect(h.taskUpdate).toHaveBeenCalledWith({
      where: { id: 'task-1', status: { in: ['submitting', 'waiting_batch', 'cancel_requested'] } },
      data: { status: 'batch_unreachable', error: BATCH_UNREACHABLE_ERROR, completedAt: now },
    });
    expect(h.release).toHaveBeenCalledWith('row-1');
  });

  it('a row a poller took the lease on between the select and the flip is left alone: no task change, no release', async () => {
    h.rows = [{ id: 'row-1', taskId: 'task-1' }];
    h.flipCount = 0;
    const res = await expireStaleBatches(now);
    expect(res.expired).toBe(0);
    expect(h.taskUpdate).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('a failing transaction is counted, never thrown, and the next row is still tried', async () => {
    h.rows = [{ id: 'a', taskId: 'ta' }, { id: 'b', taskId: 'tb' }];
    h.txFails = true;
    const res = await expireStaleBatches(now);
    expect(res).toEqual({ expired: 0, failed: 2 });
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
