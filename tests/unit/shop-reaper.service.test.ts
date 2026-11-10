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
  describe('REINSTALL_EVIDENCE guard (PLAN_ADMIN_SHOP_OVERVIEW 2.7)', () => {
    const uninstalled = () => new Date(Date.now() - 90 * DAY_MS);
    const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS);

    it('selects the evidence columns it needs', async () => {
      await ShopReaperService.getInstance().triggerReap();
      expect(mockFindMany.mock.calls[0][0].select).toMatchObject({
        reinstallEvidenceAt: true, lastWebhookAt: true, lastApiOkAt: true,
      });
    });

    it.each([
      ['stored reinstall evidence', { reinstallEvidenceAt: daysAgo(5) }],
      ['a signed webhook', { lastWebhookAt: daysAgo(5) }],
      ['an API success', { lastApiOkAt: daysAgo(5) }],
    ])('does not purge a session-less shop with recent %s', async (_n, extra) => {
      mockFindMany.mockResolvedValueOnce([{ shop: 'alive.myshopify.com', uninstalledAt: uninstalled(), ...extra }]);
      const result = await ShopReaperService.getInstance().triggerReap();
      expect(mockRedactShopData).not.toHaveBeenCalled();
      expect(result).toEqual({ purged: [], skipped: 1 });
    });

    it('logs the skip once per shop, not on every run', async () => {
      const row = { shop: 'once.myshopify.com', uninstalledAt: uninstalled(), reinstallEvidenceAt: daysAgo(5) };
      const warns = () => mockQueue.mock.calls.filter((c) => c[0] === 'warn' && String(c[1]).includes('once.myshopify.com'));
      mockFindMany.mockResolvedValueOnce([row]);
      await ShopReaperService.getInstance().triggerReap();
      mockFindMany.mockResolvedValueOnce([row]);
      await ShopReaperService.getInstance().triggerReap();
      expect(warns()).toHaveLength(1);
    });

    it('reaps a session-less shop whose evidence is older than 30 days (long silent again)', async () => {
      mockFindMany.mockResolvedValueOnce([
        { shop: 'quiet.myshopify.com', uninstalledAt: uninstalled(), reinstallEvidenceAt: daysAgo(45), lastWebhookAt: daysAgo(40) },
      ]);
      const result = await ShopReaperService.getInstance().triggerReap();
      expect(result.purged).toEqual(['quiet.myshopify.com']);
    });

    it('still purges when the evidence is OLDER than the uninstall mark or inside the grace', async () => {
      const un = uninstalled();
      mockFindMany.mockResolvedValueOnce([
        {
          shop: 'gone.myshopify.com',
          uninstalledAt: un,
          reinstallEvidenceAt: new Date(un.getTime() - DAY_MS),
          lastWebhookAt: new Date(un.getTime() + 60_000),
          lastApiOkAt: null,
        },
      ]);
      const result = await ShopReaperService.getInstance().triggerReap();
      expect(result.purged).toEqual(['gone.myshopify.com']);
    });
  });
});
