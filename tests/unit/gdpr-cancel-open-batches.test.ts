/**
 * Open provider batches are cancelled BEFORE the shop's rows are deleted
 * (PLAN_BULK_TRANSLATE_BATCHING 6.7): on shop/redact and on uninstall. The
 * cancel is best effort and never blocks the erasure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  order: [] as string[],
  cancel: vi.fn(async (_shop: string): Promise<unknown> => ({ rows: 0, cancelled: 0, failed: 0, released: 0 })),
}));

vi.mock('~/services/bulk-editor/translate-batch-cancel.server', () => ({
  cancelOpenBatches: (shop: string) => {
    h.order.push(`cancel:${shop}`);
    return h.cancel(shop);
  },
}));

vi.mock('~/db.server', () => {
  const tx = new Proxy(
    {},
    {
      get(_t, model: string | symbol) {
        if (typeof model !== 'string') return undefined;
        return {
          deleteMany: async () => {
            h.order.push(`delete:${model}`);
            return { count: 0 };
          },
        };
      },
    },
  );
  return {
    db: {
      session: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      shopInstallState: { upsert: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 0 })) },
      aISettings: { updateMany: vi.fn(async () => ({ count: 0 })) },
      $transaction: async (cb: (t: unknown) => Promise<void>) => {
        h.order.push('transaction');
        return cb(tx);
      },
    },
  };
});
vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('~/utils/encryption.server', () => ({ decryptPII: vi.fn((v: string | null) => v) }));
vi.mock('~/services/sync-scheduler.service', () => ({
  syncScheduler: { isShopActive: () => false, stopSyncForShop: vi.fn() },
}));
vi.mock('~/utils/offline-admin.server', () => ({
  invalidateOfflineAdmin: vi.fn(),
  forgetOfflineTokenMigration: vi.fn(async () => undefined),
}));
vi.mock('~/utils/shop-connection-state.server', () => ({
  clearConnectionBlock: vi.fn(async () => undefined),
  invalidateConnectionCache: vi.fn(),
}));

import { redactShopData } from '~/services/gdpr.service';
import { markShopUninstalled } from '~/services/shop-uninstall.server';

const SHOP = 'gone.myshopify.com';

beforeEach(() => {
  h.order.length = 0;
  h.cancel.mockReset();
  h.cancel.mockResolvedValue({ rows: 1, cancelled: 1, failed: 0, released: 1 });
});

describe('redactShopData', () => {
  it('cancels the shop\'s open batches BEFORE the transaction that deletes Task and AISettings', async () => {
    await redactShopData({ shop_id: 1, shop_domain: SHOP });
    expect(h.order[0]).toBe(`cancel:${SHOP}`);
    expect(h.order.indexOf('transaction')).toBeGreaterThan(0);
    expect(h.order.indexOf(`cancel:${SHOP}`)).toBeLessThan(h.order.indexOf('transaction'));
    expect(h.order.indexOf(`cancel:${SHOP}`)).toBeLessThan(h.order.indexOf('delete:task'));
    expect(h.order.indexOf(`cancel:${SHOP}`)).toBeLessThan(h.order.indexOf('delete:aISettings'));
    // the batch state itself is deleted with the shop
    expect(h.order).toContain('delete:bulkTranslateBatch');
  });

  it('a cancel that THROWS does not block the erasure', async () => {
    h.cancel.mockRejectedValue(new Error('provider unreachable'));
    await expect(redactShopData({ shop_id: 1, shop_domain: SHOP })).resolves.toBeUndefined();
    expect(h.order).toContain('transaction');
    expect(h.order).toContain('delete:task');
  });

  it('a cancel that reports failures does not block the erasure either', async () => {
    h.cancel.mockResolvedValue({ rows: 2, cancelled: 0, failed: 2, released: 0, error: 'db down' });
    await redactShopData({ shop_id: 1, shop_domain: SHOP });
    expect(h.order).toContain('delete:task');
  });
});

describe('markShopUninstalled', () => {
  it('cancels the open batches of the shop, and a failing cancel does not fail the uninstall', async () => {
    expect(await markShopUninstalled(SHOP, { source: 'webhook' })).toBe(true);
    expect(h.order).toContain(`cancel:${SHOP}`);

    h.order.length = 0;
    h.cancel.mockRejectedValue(new Error('boom'));
    expect(await markShopUninstalled(SHOP, { source: 'webhook' })).toBe(true);
  });
});
