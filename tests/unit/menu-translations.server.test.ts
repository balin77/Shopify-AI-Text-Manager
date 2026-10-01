/**
 * refreshMenuCache — the DESTRUCTIVE half of menu translations.
 *
 * Reading a menu wrong shows a stale label. Deleting wrong throws away
 * translations a merchant typed by hand, and nothing can bring them back:
 * ContentTranslation carries no foreign key, its lifecycle is app code by
 * design, and a menu item cannot be enumerated once its menu is gone. So
 * these tests are almost entirely about what this function REFUSES to delete
 * — including the case that shipped broken once: an empty live set turns
 * "notIn []" into "match everything".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { refreshMenuCache } from "~/services/menu-translations.server";

function makeGateway(nodes: unknown[] | null, errors?: Array<{ message: string }>) {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () => (errors ? { errors } : { data: { menus: { nodes } } }),
    }),
  } as never;
}

const menuUpsert = vi.fn();
const menuDeleteMany = vi.fn();
const menuCount = vi.fn();
const translationDeleteMany = vi.fn();

const db = {
  menu: { upsert: menuUpsert, deleteMany: menuDeleteMany, count: menuCount },
  contentTranslation: { deleteMany: translationDeleteMany },
} as never;

const menuWithItems = {
  id: "gid://shopify/Menu/1",
  title: "Hauptmenü",
  handle: "main-menu",
  items: [
    {
      id: "gid://shopify/MenuItem/10",
      title: "Produkte",
      items: [{ id: "gid://shopify/MenuItem/20", title: "Stifthalter" }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  menuDeleteMany.mockResolvedValue({ count: 0 });
  translationDeleteMany.mockResolvedValue({ count: 0 });
  menuCount.mockResolvedValue(0);
});

describe("refreshMenuCache", () => {
  it("upserts every menu's tree", async () => {
    await refreshMenuCache(makeGateway([menuWithItems]), db, "s.myshopify.com");
    expect(menuUpsert).toHaveBeenCalledTimes(1);
    expect(menuUpsert.mock.calls[0][0].where).toEqual({
      shop_id: { shop: "s.myshopify.com", id: "gid://shopify/Menu/1" },
    });
  });

  it("deletes translations of items that are gone, scoped to menu-item rows", async () => {
    await refreshMenuCache(makeGateway([menuWithItems]), db, "s.myshopify.com");
    expect(translationDeleteMany).toHaveBeenCalledWith({
      where: {
        shop: "s.myshopify.com",
        resourceType: "Link",
        // Derived from the MenuItem GIDs, every level.
        resourceId: { notIn: ["gid://shopify/Link/10", "gid://shopify/Link/20"] },
        // The snapshot cutoff has its own test below; here it only has to be
        // present, so this assertion stays about the SCOPE of the delete.
        updatedAt: { lt: expect.any(Date) },
      },
    });
  });

  it("deletes NOTHING when the menus carry no items — an empty notIn matches every row", async () => {
    const emptyMenu = { id: "gid://shopify/Menu/1", title: "Leer", handle: "leer", items: [] };
    await refreshMenuCache(makeGateway([emptyMenu]), db, "s.myshopify.com");
    expect(translationDeleteMany).not.toHaveBeenCalled();
  });

  it("throws, and deletes nothing, when Shopify returns zero menus over a non-empty cache", async () => {
    // Throwing is half the assertion. The callers are a page loader and three
    // sync phases: the loader catches and serves the cache either way, but a
    // return value of 0 would let initial-sync mark its menu phase successful
    // and /api/sync-content report "0 menus" with no failure — a broken read
    // shown to the merchant as an empty shop.
    menuCount.mockResolvedValue(3);
    await expect(
      refreshMenuCache(makeGateway([]), db, "s.myshopify.com"),
    ).rejects.toThrow(/aborting to prevent data loss/);
    expect(menuDeleteMany).not.toHaveBeenCalled();
    expect(translationDeleteMany).not.toHaveBeenCalled();
  });

  it("returns 0 without throwing when the shop genuinely has no menus", async () => {
    // The counterpart to the case above: an empty read over an EMPTY cache is
    // just an empty shop, and must not be reported as a failure.
    menuCount.mockResolvedValue(0);
    await expect(refreshMenuCache(makeGateway([]), db, "s.myshopify.com")).resolves.toBe(0);
    expect(menuDeleteMany).not.toHaveBeenCalled();
  });

  it("skips both deletes when the menu list may be truncated", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      id: `gid://shopify/Menu/${i}`,
      title: `M${i}`,
      handle: `m${i}`,
      items: [],
    }));
    await refreshMenuCache(makeGateway(many), db, "s.myshopify.com");
    expect(menuUpsert).toHaveBeenCalledTimes(250);
    expect(menuDeleteMany).not.toHaveBeenCalled();
    expect(translationDeleteMany).not.toHaveBeenCalled();
  });

  it("removes menus Shopify no longer returns", async () => {
    await refreshMenuCache(makeGateway([menuWithItems]), db, "s.myshopify.com");
    expect(menuDeleteMany).toHaveBeenCalledWith({
      where: { shop: "s.myshopify.com", id: { notIn: ["gid://shopify/Menu/1"] } },
    });
  });

  it("spares translations written after the live snapshot was taken", async () => {
    // The orphan cleanup may only judge rows that existed when it read the
    // live tree. Between that read and this delete, a merchant can create a
    // menu item and translate it — and a translation of an item the snapshot
    // never saw is not an orphan of it. On the 60s scheduler this window comes
    // around often enough to matter.
    const before = new Date();
    await refreshMenuCache(makeGateway([menuWithItems]), db, "s.myshopify.com");

    const where = translationDeleteMany.mock.calls[0][0].where;
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
    expect(where.updatedAt.lt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("throws on a GraphQL error instead of treating it as an empty shop", async () => {
    await expect(
      refreshMenuCache(makeGateway(null, [{ message: "Throttled" }]), db, "s.myshopify.com"),
    ).rejects.toThrow("Throttled");
    expect(menuDeleteMany).not.toHaveBeenCalled();
    expect(translationDeleteMany).not.toHaveBeenCalled();
  });
});
