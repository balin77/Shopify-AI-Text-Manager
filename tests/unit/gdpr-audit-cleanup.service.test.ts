/**
 * Unit Tests for gdpr-audit-cleanup.service.ts
 *
 * Verifies the 3-year retention job removes ONLY GdprAuditLog rows older than
 * 3 years (Art. 5(1)(e) storage limitation) and nothing else.
 *
 * ✅ No real database needed (db is mocked)
 * ✅ Fast
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GdprAuditLogCleanupService } from '../../src/services/gdpr-audit-cleanup.service';

// ── Mocks ────────────────────────────────────────────────────────────────────

const { mockDeleteMany, mockQueue } = vi.hoisted(() => ({
  mockDeleteMany: vi.fn(),
  mockQueue: vi.fn(),
}));

vi.mock('~/db.server', () => ({
  db: {
    gdprAuditLog: {
      deleteMany: mockDeleteMany,
    },
  },
}));

vi.mock('~/utils/logger.server', () => ({
  loggers: {
    queue: mockQueue,
  },
}));

const THREE_YEARS_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('GdprAuditLogCleanupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMany.mockResolvedValue({ count: 0 });
  });

  it('deletes ONLY by requestedAt < now − 3 years, with no other filter', async () => {
    mockDeleteMany.mockResolvedValueOnce({ count: 4 });

    const before = Date.now();
    const deleted = await GdprAuditLogCleanupService.getInstance().triggerCleanup();
    const after = Date.now();

    expect(deleted).toBe(4);
    expect(mockDeleteMany).toHaveBeenCalledOnce();

    const arg = mockDeleteMany.mock.calls[0][0];
    // The where clause must contain exactly one key: requestedAt.lt
    expect(Object.keys(arg.where)).toEqual(['requestedAt']);
    expect(Object.keys(arg.where.requestedAt)).toEqual(['lt']);
    // No shop / customer / status scope that could touch in-retention rows.
    expect(arg.where.shop).toBeUndefined();
    expect(arg.where.customerId).toBeUndefined();
    expect(arg.where.customerEmail).toBeUndefined();

    const cutoff = (arg.where.requestedAt.lt as Date).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - THREE_YEARS_MS - 1000);
    expect(cutoff).toBeLessThanOrEqual(after - THREE_YEARS_MS + 1000);
  });

  it('a row older than 3 years falls under the cutoff; a younger one does not', async () => {
    await GdprAuditLogCleanupService.getInstance().triggerCleanup();

    const cutoff = (mockDeleteMany.mock.calls[0][0].where.requestedAt.lt as Date).getTime();

    // 3 years + 1 day old → deleted (strictly before cutoff)
    const olderThan3Years = Date.now() - THREE_YEARS_MS - DAY_MS;
    expect(olderThan3Years).toBeLessThan(cutoff);

    // 3 years − 1 day old → retained (not before cutoff)
    const youngerThan3Years = Date.now() - THREE_YEARS_MS + DAY_MS;
    expect(youngerThan3Years).toBeGreaterThanOrEqual(cutoff);
  });

  it('logs the number of deleted rows', async () => {
    mockDeleteMany.mockResolvedValueOnce({ count: 7 });

    await GdprAuditLogCleanupService.getInstance().cleanup();

    expect(
      mockQueue.mock.calls.some(
        ([, message]) => typeof message === 'string' && message.includes('Deleted 7'),
      ),
    ).toBe(true);
  });

  it('swallows db errors in cleanup() (does not throw, logs error)', async () => {
    mockDeleteMany.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(
      GdprAuditLogCleanupService.getInstance().cleanup(),
    ).resolves.toBeUndefined();

    expect(
      mockQueue.mock.calls.some(([level]) => level === 'error'),
    ).toBe(true);
  });
});
