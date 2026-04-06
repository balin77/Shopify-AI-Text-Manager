/**
 * Unit Tests for BackgroundSyncService.syncAll()
 *
 * Focus: The Promise.all() + per-type .catch() error isolation pattern.
 * A single failing content-type must return 0 and not throw — the overall
 * syncAll() should still resolve with stats from the other types.
 *
 * ✅ No real Shopify needed (admin + gateway are mocked)
 * ✅ No real database needed (Prisma not used in syncAll itself)
 * ✅ Fast (private methods are spied on directly)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundSyncService } from '~/services/background-sync.service';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('~/utils/logger.server', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ShopifyApiGateway is constructed inside BackgroundSyncService — mock it to
// avoid network/rate-limit logic being exercised in these unit tests.
// Must use a real class (not an arrow function) so `new ShopifyApiGateway()` works.
vi.mock('~/services/shopify-api-gateway.service', () => {
  class ShopifyApiGateway {
    graphql = vi.fn();
    getQueueStatus = vi.fn().mockReturnValue({ queueLength: 0, isProcessing: false, requestCount: 0 });
    clearQueue = vi.fn();
  }
  return { ShopifyApiGateway };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockAdmin = { graphql: vi.fn() };
const shop = 'test.myshopify.com';

function makeService(): BackgroundSyncService {
  return new BackgroundSyncService(mockAdmin, shop);
}

type SyncResult = number | Error;

// Helper to spy on all four private sync methods at once
function spyAllMethods(
  service: BackgroundSyncService,
  {
    pages = 0,
    policies = 0,
    themes = 0,
    metaobjects = 0,
  }: { pages?: SyncResult; policies?: SyncResult; themes?: SyncResult; metaobjects?: SyncResult } = {},
) {
  function mockMethod(name: string, value: SyncResult) {
    return value instanceof Error
      ? vi.spyOn(service as never, name as never).mockRejectedValue(value)
      : vi.spyOn(service as never, name as never).mockResolvedValue(value);
  }

  return {
    spyPages: mockMethod('syncAllPages', pages),
    spyPolicies: mockMethod('syncAllPolicies', policies),
    spyThemes: mockMethod('syncAllThemes', themes),
    spyMetaobjects: mockMethod('syncAllMetaobjects', metaobjects),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BackgroundSyncService.syncAll()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aggregates counts correctly when all content types succeed', async () => {
    const service = makeService();
    spyAllMethods(service, { pages: 10, policies: 2, themes: 5, metaobjects: 3 });

    const stats = await service.syncAll();

    expect(stats.pages).toBe(10);
    expect(stats.policies).toBe(2);
    expect(stats.themes).toBe(5);
    expect(stats.metaobjects).toBe(3);
    expect(stats.total).toBe(20);
  });

  it('returns 0 for a failing type and still resolves with the rest', async () => {
    const service = makeService();
    spyAllMethods(service, {
      pages: new Error('DB connection failed'),
      policies: 4,
      themes: 7,
      metaobjects: 1,
    });

    const stats = await service.syncAll();

    expect(stats.pages).toBe(0);        // failed → isolated to 0
    expect(stats.policies).toBe(4);
    expect(stats.themes).toBe(7);
    expect(stats.metaobjects).toBe(1);
    expect(stats.total).toBe(12);
  });

  it('does NOT throw when multiple content types fail simultaneously', async () => {
    const service = makeService();
    spyAllMethods(service, {
      pages: new Error('pages error'),
      policies: new Error('policies error'),
      themes: 6,
      metaobjects: new Error('metaobjects error'),
    });

    await expect(service.syncAll()).resolves.toMatchObject({
      pages: 0,
      policies: 0,
      themes: 6,
      metaobjects: 0,
      total: 6,
    });
  });

  it('includes a non-negative duration in the returned stats', async () => {
    const service = makeService();
    spyAllMethods(service, { pages: 0, policies: 0, themes: 0, metaobjects: 0 });

    const stats = await service.syncAll();

    expect(typeof stats.duration).toBe('number');
    expect(stats.duration).toBeGreaterThanOrEqual(0);
  });
});
