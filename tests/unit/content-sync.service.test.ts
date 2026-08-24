/**
 * ContentSyncService.syncAllMenus() — that it is no longer a WRITER.
 *
 * It used to be the second one. `Menu.items` had two upserts replacing the
 * whole column: this path read `id/title/url/type` per menu, `refreshMenuCache`
 * reads those plus `resourceId`. Whichever ran last decided what was in the
 * row — and this one runs on the 60s scheduler while the cache writer only
 * runs when someone opens /app/menus, so this one usually won. A tree served
 * from such a row fails `validateMenuTree` with `missingTarget` on every
 * resource-bound item: every field red on a menu nobody touched.
 *
 * So the assertions here are about DELEGATION, not about menu data:
 * `resourceId` survives, one query replaces 1 + N, and the count still comes
 * back. What the cache writer itself refuses to delete is covered next door in
 * menu-translations.server.test.ts and deliberately not duplicated.
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

// db.server is dynamically imported inside syncAllMenus and, one level down,
// inside refreshMenuCache — both resolve to this same module.
const mockMenuUpsert = vi.fn().mockResolvedValue({});
const mockMenuDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
const mockMenuCount = vi.fn().mockResolvedValue(0);
const mockTranslationDeleteMany = vi.fn().mockResolvedValue({ count: 0 });

vi.mock('~/db.server', () => ({
  db: {
    menu: {
      upsert: mockMenuUpsert,
      deleteMany: mockMenuDeleteMany,
      count: mockMenuCount,
      delete: vi.fn().mockResolvedValue({}),
    },
    contentTranslation: { deleteMany: mockTranslationDeleteMany },
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const shop = 'test.myshopify.com';

/**
 * A menu item of the shape the CACHE writer reads. `resourceId` is the field
 * the removed writer did not read, and the reason this file exists.
 */
const menuNode = {
  id: 'gid://shopify/Menu/1',
  title: 'Main Navigation',
  handle: 'main-menu',
  items: [
    {
      id: 'gid://shopify/MenuItem/10',
      title: 'Katalog',
      type: 'COLLECTION',
      url: '/collections/all',
      resourceId: 'gid://shopify/Collection/77',
      items: [],
    },
  ],
};

const secondMenuNode = { ...menuNode, id: 'gid://shopify/Menu/2', handle: 'footer' };

function makeAdmin(nodes: unknown[] | null, error?: string) {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () =>
        error ? { errors: [{ message: error }] } : { data: { menus: { nodes } } },
    }),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ContentSyncService.syncAllMenus()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMenuUpsert.mockResolvedValue({});
    mockMenuDeleteMany.mockResolvedValue({ count: 0 });
    mockMenuCount.mockResolvedValue(0);
    mockTranslationDeleteMany.mockResolvedValue({ count: 0 });
  });

  it('persists resourceId — the field the second writer dropped', async () => {
    const admin = makeAdmin([menuNode]);

    await new ContentSyncService(admin as never, shop).syncAllMenus();

    expect(mockMenuUpsert).toHaveBeenCalledOnce();
    const written = mockMenuUpsert.mock.calls[0][0].update.items;
    expect(written[0].resourceId).toBe('gid://shopify/Collection/77');
    // and the tree is stored whole, not field-by-field, so a future field
    // needs no change here.
    expect(written[0]).toEqual(menuNode.items[0]);
  });

  it('reads the whole shop in ONE query instead of one per menu', async () => {
    const admin = makeAdmin([menuNode, secondMenuNode]);

    await new ContentSyncService(admin as never, shop).syncAllMenus();

    // The removed path cost 1 (list) + N (per menu). Two menus, one call.
    expect(admin.graphql).toHaveBeenCalledTimes(1);
    expect(mockMenuUpsert).toHaveBeenCalledTimes(2);
  });

  it('returns how many menus Shopify returned', async () => {
    const admin = makeAdmin([menuNode, secondMenuNode]);

    const count = await new ContentSyncService(admin as never, shop).syncAllMenus();

    expect(count).toBe(2);
  });

  it('propagates GraphQL errors instead of reporting an empty shop', async () => {
    const admin = makeAdmin(null, 'Menu not accessible');

    await expect(
      new ContentSyncService(admin as never, shop).syncAllMenus(),
    ).rejects.toThrow('Menu not accessible');

    expect(mockMenuUpsert).not.toHaveBeenCalled();
    expect(mockMenuDeleteMany).not.toHaveBeenCalled();
  });
});
