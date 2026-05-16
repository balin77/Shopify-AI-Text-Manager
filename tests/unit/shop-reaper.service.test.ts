/**
 * Unit Tests for shop-reaper.service.ts (R3 fallback deletion)
 *
 * Verifies the 30-day reaper purges shops uninstalled past the retention
 * window via the central redactShopData, and NEVER touches a shop that still
 * has a session or a paid plan.
 *
 * ✅ No real database needed (db + redactShopData mocked)
 * ✅ Fast
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShopReaperService } from '../../src/services/shop-reaper.service';

// ── Mocks ────────────────────────────────────────────────────────────────────

const {
  mockFindMany,
  mockSessionCount,
  mockAiFindUnique,
  mockRedactShopData,
  mockQueue,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockSessionCount: vi.fn(),
  mockAiFindUnique: vi.fn(),
  mockRedactShopData: vi.fn(),
  mockQueue: vi.fn(),
}));

vi.mock('~/db.server', () => ({
  db: {
    shopInstallState: { findMany: mockFindMany },
    session: { count: mockSessionCount },
    aISettings: { findUnique: mockAiFindUnique },
  },
}));

vi.mock('~/services/gdpr.service', () => ({
  redactShopData: mockRedactShopData,
}));

vi.mock('~/utils/logger.server', () => ({
  loggers: { queue: mockQueue },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;

describe('ShopReaperService.reapInactiveShops()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionCount.mockResolvedValue(0);
    mockAiFindUnique.mockResolvedValue(null);
    mockRedactShopData.mockResolvedValue(undefined);
    mockFindMany.mockResolvedValue([]);
  });

  it('selects only uninstalled shops past the 30-day cutoff', async () => {
    const before = Date.now();
    await ShopReaperService.getInstance().triggerReap();
    const after = Date.now();

    expect(mockFindMany).toHaveBeenCalledOnce();
    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.uninstalledAt.not).toBeNull();
    const cutoff = (where.uninstalledAt.lt as Date).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - RETENTION_MS - 1000);
    expect(cutoff).toBeLessThanOrEqual(after - RETENTION_MS + 1000);
  });

  it('purges an expired, session-less, free/absent-plan shop via redactShopData', async () => {
    mockFindMany.mockResolvedValueOnce([
      { shop: 'old-shop.myshopify.com', uninstalledAt: new Date(Date.now() - 40 * DAY_MS) },
    ]);

    const result = await ShopReaperService.getInstance().triggerReap();

    expect(mockRedactShopData).toHaveBeenCalledOnce();
    expect(mockRedactShopData).toHaveBeenCalledWith({
      shop_id: 0,
      shop_domain: 'old-shop.myshopify.com',
    });
    expect(result.purged).toEqual(['old-shop.myshopify.com']);
    expect(result.skipped).toBe(0);
  });

  it('NEVER purges a shop that still has an active session', async () => {
    mockFindMany.mockResolvedValueOnce([
      { shop: 'reinstalled.myshopify.com', uninstalledAt: new Date(Date.now() - 40 * DAY_MS) },
    ]);
    mockSessionCount.mockResolvedValueOnce(2);

    const result = await ShopReaperService.getInstance().triggerReap();

    expect(mockRedactShopData).not.toHaveBeenCalled();
    expect(result.purged).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  // Regression: subscriptionPlan is never reset to "free" on uninstall, so an
  // ex-paying shop keeps "pro" forever. A plan-based skip would permanently
  // exclude exactly the shops this R3 backstop exists for — it MUST purge.
  it('PURGES a >30d-uninstalled "pro" shop with zero sessions (R3 regression)', async () => {
    mockFindMany.mockResolvedValueOnce([
      { shop: 'ex-paying.myshopify.com', uninstalledAt: new Date(Date.now() - 60 * DAY_MS) },
    ]);
    mockAiFindUnique.mockResolvedValueOnce({ subscriptionPlan: 'pro' });

    const result = await ShopReaperService.getInstance().triggerReap();

    expect(mockRedactShopData).toHaveBeenCalledWith({
      shop_id: 0,
      shop_domain: 'ex-paying.myshopify.com',
    });
    expect(result.purged).toEqual(['ex-paying.myshopify.com']);
    expect(result.skipped).toBe(0);
  });

  it('still purges when AISettings exists with the free plan', async () => {
    mockFindMany.mockResolvedValueOnce([
      { shop: 'free-shop.myshopify.com', uninstalledAt: new Date(Date.now() - 31 * DAY_MS) },
    ]);
    mockAiFindUnique.mockResolvedValueOnce({ subscriptionPlan: 'free' });

    const result = await ShopReaperService.getInstance().triggerReap();

    expect(mockRedactShopData).toHaveBeenCalledWith({
      shop_id: 0,
      shop_domain: 'free-shop.myshopify.com',
    });
    expect(result.purged).toEqual(['free-shop.myshopify.com']);
  });

  it('counts a redactShopData failure as skipped and keeps going', async () => {
    mockFindMany.mockResolvedValueOnce([
      { shop: 'a.myshopify.com', uninstalledAt: new Date(Date.now() - 40 * DAY_MS) },
      { shop: 'b.myshopify.com', uninstalledAt: new Date(Date.now() - 40 * DAY_MS) },
    ]);
    mockRedactShopData.mockRejectedValueOnce(new Error('transient DB error'));

    const result = await ShopReaperService.getInstance().triggerReap();

    expect(result.purged).toEqual(['b.myshopify.com']);
    expect(result.skipped).toBe(1);
    expect(mockQueue.mock.calls.some(([level]) => level === 'error')).toBe(true);
  });
});
