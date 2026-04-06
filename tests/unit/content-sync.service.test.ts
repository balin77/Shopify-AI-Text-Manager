/**
 * Unit Tests for ContentSyncService.syncMenu()
 *
 * Focus:
 *   1. menuData null (menu not found in Shopify) → early return, saveMenuToDatabase NOT called
 *   2. menuData present → db.menu.upsert called with correct shape
 *   3. GraphQL error in fetchMenuData → error propagated
 *
 * ✅ No real Shopify API needed (admin.graphql is mocked)
 * ✅ No real database needed (db.server is mocked)
 * ✅ Fast (<50ms per test)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentSyncService } from '~/services/content-sync.service';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('~/utils/logger.server', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('~/utils/translation-save-lock.server', () => ({
  isTranslationRecentlySaved: vi.fn().mockResolvedValue(false),
}));

// db.server is dynamically imported inside saveMenuToDatabase:
//   const { db } = await import("../db.server")
const mockMenuUpsert = vi.fn().mockResolvedValue({});

vi.mock('~/db.server', () => ({
  db: {
    menu: {
      upsert: mockMenuUpsert,
      delete: vi.fn().mockResolvedValue({}),
    },
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const shop = 'test.myshopify.com';

const menuPayload = {
  id: 'gid://shopify/Menu/1',
  title: 'Main Navigation',
  handle: 'main-menu',
  items: [
    { id: 'gid://shopify/MenuItem/1', title: 'Home', url: '/', type: 'FRONTEND', items: [] },
    { id: 'gid://shopify/MenuItem/2', title: 'About', url: '/about', type: 'FRONTEND', items: [] },
  ],
};

/** Build a mock admin that returns the given menu (or null) from fetchMenuData */
function makeAdmin(menu: typeof menuPayload | null, error?: string) {
  if (error) {
    return {
      graphql: vi.fn().mockResolvedValue({
        json: async () => ({ errors: [{ message: error }] }),
      }),
    };
  }
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () => ({
        data: { menu },
        errors: undefined,
      }),
    }),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ContentSyncService.syncMenu()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early without calling db.menu.upsert when menu is not found', async () => {
    const admin = makeAdmin(null);
    const service = new ContentSyncService(admin, shop);

    // Should resolve without throwing
    await expect(service.syncMenu('gid://shopify/Menu/999')).resolves.toBeUndefined();

    // fetchMenuData was called once (graphql call)
    expect(admin.graphql).toHaveBeenCalledTimes(1);
    // saveMenuToDatabase was NOT called
    expect(mockMenuUpsert).not.toHaveBeenCalled();
  });

  it('calls db.menu.upsert with correct data when menu is found', async () => {
    const admin = makeAdmin(menuPayload);
    const service = new ContentSyncService(admin, shop);

    await service.syncMenu(menuPayload.id);

    expect(admin.graphql).toHaveBeenCalledTimes(1);
    expect(mockMenuUpsert).toHaveBeenCalledOnce();
    expect(mockMenuUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          shop_id: { shop, id: menuPayload.id },
        },
        create: expect.objectContaining({
          id: menuPayload.id,
          shop,
          title: menuPayload.title,
          handle: menuPayload.handle,
        }),
        update: expect.objectContaining({
          title: menuPayload.title,
          handle: menuPayload.handle,
        }),
      })
    );
  });

  it('propagates GraphQL errors from fetchMenuData', async () => {
    const admin = makeAdmin(null, 'Menu not accessible');
    const service = new ContentSyncService(admin, shop);

    await expect(service.syncMenu('gid://shopify/Menu/1')).rejects.toThrow(
      'GraphQL error in fetchMenuData: Menu not accessible'
    );

    expect(mockMenuUpsert).not.toHaveBeenCalled();
  });
});
