import { describe, it, expect, vi } from "vitest";

/**
 * The per-resource cache purge must take the stale-translation gate's PRIMARY
 * baseline with it. `PrimaryDigestBaseline` is polymorphic and FK-less exactly
 * like `ContentTranslation`, so nothing else would ever remove the row of a
 * deleted resource — there is no database safety net.
 */

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/services/menu-translations.server", () => ({ MENU_LINK_RESOURCE_TYPE: "Link" }));

import { purgeContentFromCache } from "~/services/content-delete.server";

const SHOP = "a.myshopify.com";

/** A transaction client that records every deleteMany by delegate. */
function recorder(articles: string[] = []) {
  const calls: Array<{ model: string; where: any }> = [];
  const tx = new Proxy(
    {},
    {
      get: (_target, model: string) => ({
        deleteMany: async (args: { where: any }) => {
          calls.push({ model, where: args.where });
          return { count: 1 };
        },
        findMany: async () => articles.map((id) => ({ id })),
        findFirst: async () => null,
      }),
    },
  );
  const db = { $transaction: async (cb: (t: unknown) => Promise<void>) => cb(tx) } as never;
  return { db, calls };
}

describe("purgeContentFromCache — the primary digest baseline", () => {
  it("deletes the resource's baseline in the same transaction as its translations", async () => {
    const { db, calls } = recorder();
    await purgeContentFromCache(db, SHOP, "page", "gid://shopify/Page/1");

    expect(calls.find((c) => c.model === "primaryDigestBaseline")?.where).toEqual({
      shop: SHOP,
      resourceId: "gid://shopify/Page/1",
    });
    expect(calls.find((c) => c.model === "contentTranslation")?.where).toEqual({
      shop: SHOP,
      resourceId: "gid://shopify/Page/1",
    });
  });

  it("takes a deleted blog's ARTICLES' baselines too — Shopify deletes those with it", async () => {
    const { db, calls } = recorder(["gid://shopify/Article/7", "gid://shopify/Article/8"]);
    await purgeContentFromCache(db, SHOP, "blog", "gid://shopify/Blog/1");

    const baselineDeletes = calls.filter((c) => c.model === "primaryDigestBaseline").map((c) => c.where);
    expect(baselineDeletes).toContainEqual({ shop: SHOP, resourceId: "gid://shopify/Blog/1" });
    expect(baselineDeletes).toContainEqual({
      shop: SHOP,
      resourceId: { in: ["gid://shopify/Article/7", "gid://shopify/Article/8"] },
    });
  });
});
