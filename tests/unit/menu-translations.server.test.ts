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
      },
    });
  });

  it("deletes NOTHING when the menus carry no items — an empty notIn matches every row", async () => {
    const emptyMenu = { id: "gid://shopify/Menu/1", title: "Leer", handle: "leer", items: [] };
    await refreshMenuCache(makeGateway([emptyMenu]), db, "s.myshopify.com");
    expect(translationDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes nothing at all when Shopify returns zero menus over a non-empty cache", async () => {
    menuCount.mockResolvedValue(3);
    await refreshMenuCache(makeGateway([]), db, "s.myshopify.com");
    expect(menuDeleteMany).not.toHaveBeenCalled();
    expect(translationDeleteMany).not.toHaveBeenCalled();
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

  it("throws on a GraphQL error instead of treating it as an empty shop", async () => {
    await expect(
      refreshMenuCache(makeGateway(null, [{ message: "Throttled" }]), db, "s.myshopify.com"),
    ).rejects.toThrow("Throttled");
    expect(menuDeleteMany).not.toHaveBeenCalled();
    expect(translationDeleteMany).not.toHaveBeenCalled();
  });
});
