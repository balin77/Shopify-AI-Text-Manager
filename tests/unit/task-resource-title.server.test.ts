/**
 * "There are many items where you cannot see where the task was fired from."
 *
 * `Task.resourceTitle` is the one column every task surface renders as the
 * subject, and this module is the one answer to "which item was that". The
 * cases below are the failure modes it exists to prevent, in the order they
 * cost the most:
 *
 *  - a lookup that THROWS must never reach the caller: it is about to create
 *    the Task row for a translation, and losing the translation over a display
 *    title would be far worse than the missing label;
 *  - a lookup that is not shop-scoped would label one merchant's task with
 *    another merchant's product;
 *  - a resource that is not a cached ITEM (a theme, a template group, a bare
 *    id) must answer null rather than guess a table;
 *  - and a batch must cost ONE query per KIND, because api.convert-webp.tsx
 *    creates a row per image in a loop.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  taskResourceKind,
  resolveTaskResourceTitle,
  resolveTaskResourceTitles,
  taskTitleOrFallback,
} from "~/services/tasks/resource-title.server";

const SHOP = "demo.myshopify.com";

/**
 * A fake Prisma client over an in-memory row set. Every delegate applies the
 * `shop` filter itself, so a query that forgot to scope simply returns the
 * other shop's row and the test fails — which is the only way to test scoping
 * without a database.
 */
function makeDb(rows: {
  product?: Array<{ id: string; shop: string; title: string }>;
  collection?: Array<{ id: string; shop: string; title: string }>;
  page?: Array<{ id: string; shop: string; title: string }>;
  article?: Array<{ id: string; shop: string; title: string; blogId?: string; blogTitle?: string }>;
  shopPolicy?: Array<{ id: string; shop: string; title: string }>;
  metaobject?: Array<{ id: string; shop: string; displayName: string; handle: string }>;
  menu?: Array<{ id: string; shop: string; title: string }>;
} = {}) {
  const calls: string[] = [];
  const table = <T extends { shop: string }>(name: string, data: T[] | undefined) => ({
    findMany: vi.fn(async (args: any) => {
      calls.push(name);
      const source = data ?? [];
      const byShop = source.filter((row) => row.shop === args.where.shop);
      if (args.where.id?.in) {
        return byShop.filter((row) => args.where.id.in.includes((row as any).id));
      }
      if (args.where.blogId?.in) {
        return byShop.filter((row) => args.where.blogId.in.includes((row as any).blogId));
      }
      return [];
    }),
    // Modelled on Prisma's real GROUP BY: it returns one row per distinct
    // combination of the `by` columns and NOTHING else, which is exactly the
    // property the blog lookup relies on (a `findMany({ distinct })` would
    // hand back every article row and dedupe in the client).
    groupBy: vi.fn(async (args: any) => {
      calls.push(`${name}.groupBy`);
      const source = (data ?? []) as any[];
      const byShop = source.filter((row) => row.shop === args.where.shop);
      const hits = args.where.blogId?.in
        ? byShop.filter((row) => args.where.blogId.in.includes(row.blogId))
        : byShop;
      const seen = new Map<string, any>();
      for (const row of hits) {
        const key = args.by.map((column: string) => String(row[column])).join("\u0000");
        if (seen.has(key)) continue;
        const projected: Record<string, unknown> = {};
        for (const column of args.by) projected[column] = row[column];
        seen.set(key, projected);
      }
      return [...seen.values()];
    }),
  });
  return {
    calls,
    db: {
      product: table("product", rows.product),
      collection: table("collection", rows.collection),
      page: table("page", rows.page),
      article: table("article", rows.article),
      shopPolicy: table("shopPolicy", rows.shopPolicy),
      metaobject: table("metaobject", rows.metaobject),
      menu: table("menu", rows.menu),
    } as any,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("taskResourceKind", () => {
  it("reads the kind out of the GID, whatever the resourceType is spelled like", () => {
    // The four spellings the creation sites really write for one type.
    for (const spelling of ["product", "products", "Product", "seo"]) {
      expect(taskResourceKind(spelling, "gid://shopify/Product/1")).toBe("product");
    }
  });

  it("tells a Blog container from an Article, which the type string cannot", () => {
    // The blogs editor addresses both under one `contentType: "blogs"`.
    expect(taskResourceKind("blogs", "gid://shopify/Blog/7")).toBe("blog");
    expect(taskResourceKind("blogs", "gid://shopify/Article/7")).toBe("article");
  });

  it("answers null for a type that is not a cached item", () => {
    expect(taskResourceKind("templates", "gid://shopify/OnlineStoreTheme/1")).toBeNull();
    expect(taskResourceKind("seo", "gid://shopify/MediaImage/1")).toBeNull();
  });

  it("answers null for anything that is not a GID at all", () => {
    expect(taskResourceKind("product", "8123")).toBeNull();
    expect(taskResourceKind("product", "")).toBeNull();
    expect(taskResourceKind("product", null)).toBeNull();
    expect(taskResourceKind("product", undefined)).toBeNull();
  });
});

describe("resolveTaskResourceTitle — every supported kind", () => {
  const cases: Array<[string, string, any, string]> = [
    ["product", "gid://shopify/Product/1", { product: [{ id: "gid://shopify/Product/1", shop: SHOP, title: "Kumiko Box" }] }, "Kumiko Box"],
    ["collection", "gid://shopify/Collection/2", { collection: [{ id: "gid://shopify/Collection/2", shop: SHOP, title: "Vases" }] }, "Vases"],
    ["page", "gid://shopify/Page/3", { page: [{ id: "gid://shopify/Page/3", shop: SHOP, title: "About us" }] }, "About us"],
    ["article", "gid://shopify/Article/4", { article: [{ id: "gid://shopify/Article/4", shop: SHOP, title: "Kintsugi" }] }, "Kintsugi"],
    ["shopPolicy", "gid://shopify/ShopPolicy/5", { shopPolicy: [{ id: "gid://shopify/ShopPolicy/5", shop: SHOP, title: "Refund policy" }] }, "Refund policy"],
    ["menu", "gid://shopify/Menu/6", { menu: [{ id: "gid://shopify/Menu/6", shop: SHOP, title: "Main menu" }] }, "Main menu"],
  ];

  for (const [kind, gid, rows, expected] of cases) {
    it(`names a ${kind}`, async () => {
      const { db } = makeDb(rows);
      await expect(resolveTaskResourceTitle(db, SHOP, kind, gid)).resolves.toBe(expected);
    });
  }

  it("names a BLOG through one of its articles — there is no Blog table", async () => {
    const { db, calls } = makeDb({
      article: [
        { id: "gid://shopify/Article/10", shop: SHOP, title: "Post A", blogId: "gid://shopify/Blog/9", blogTitle: "News" },
        { id: "gid://shopify/Article/11", shop: SHOP, title: "Post B", blogId: "gid://shopify/Blog/9", blogTitle: "News" },
      ],
    });
    await expect(
      resolveTaskResourceTitle(db, SHOP, "blogs", "gid://shopify/Blog/9"),
    ).resolves.toBe("News");
    // ONE grouped query, and never `findMany`: Prisma dedupes `distinct` in
    // the client, so that variant would pull every post of the blog to learn
    // one title.
    expect(calls).toEqual(["article.groupBy"]);
  });

  it("takes the first usable blogTitle when a half-synced rename left two", async () => {
    const { db } = makeDb({
      article: [
        { id: "gid://shopify/Article/10", shop: SHOP, title: "A", blogId: "gid://shopify/Blog/9", blogTitle: "News" },
        { id: "gid://shopify/Article/11", shop: SHOP, title: "B", blogId: "gid://shopify/Blog/9", blogTitle: "Journal" },
      ],
    });
    await expect(
      resolveTaskResourceTitle(db, SHOP, "blogs", "gid://shopify/Blog/9"),
    ).resolves.toBe("News");
  });

  it("falls back to a metaobject's handle when the definition names no label field", async () => {
    const { db } = makeDb({
      metaobject: [
        { id: "gid://shopify/Metaobject/12", shop: SHOP, displayName: "   ", handle: "midnight-blue" },
      ],
    });
    await expect(
      resolveTaskResourceTitle(db, SHOP, "metaobjects", "gid://shopify/Metaobject/12"),
    ).resolves.toBe("midnight-blue");
  });
});

describe("resolveTaskResourceTitle — the answers that must be null", () => {
  it("returns null on a MISS rather than inventing a subject", async () => {
    const { db } = makeDb({ product: [] });
    await expect(
      resolveTaskResourceTitle(db, SHOP, "product", "gid://shopify/Product/404"),
    ).resolves.toBeNull();
  });

  it("returns null for an UNKNOWN type without querying anything", async () => {
    const { db, calls } = makeDb({ product: [{ id: "x", shop: SHOP, title: "x" }] });
    await expect(
      resolveTaskResourceTitle(db, SHOP, "templates", "gid://shopify/OnlineStoreTheme/1"),
    ).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("is SHOP-SCOPED: another shop's row of the same id is not this shop's title", async () => {
    const { db } = makeDb({
      product: [{ id: "gid://shopify/Product/1", shop: "other.myshopify.com", title: "Not yours" }],
    });
    await expect(
      resolveTaskResourceTitle(db, SHOP, "product", "gid://shopify/Product/1"),
    ).resolves.toBeNull();
  });

  it("treats a whitespace-only title as no title", async () => {
    const { db } = makeDb({ product: [{ id: "gid://shopify/Product/1", shop: SHOP, title: "   " }] });
    await expect(
      resolveTaskResourceTitle(db, SHOP, "product", "gid://shopify/Product/1"),
    ).resolves.toBeNull();
  });

  it("SWALLOWS a database error — the task creation behind it must still happen", async () => {
    const db = {
      product: { findMany: vi.fn().mockRejectedValue(new Error("connection reset")) },
    } as any;
    await expect(
      resolveTaskResourceTitle(db, SHOP, "product", "gid://shopify/Product/1"),
    ).resolves.toBeNull();
  });

  it("does not let ONE failing kind take the other kinds down with it", async () => {
    const db = {
      product: { findMany: vi.fn().mockRejectedValue(new Error("boom")) },
      collection: {
        findMany: vi.fn().mockResolvedValue([{ id: "gid://shopify/Collection/2", title: "Vases" }]),
      },
    } as any;
    const found = await resolveTaskResourceTitles(db, SHOP, [
      { resourceType: "product", resourceId: "gid://shopify/Product/1" },
      { resourceType: "collection", resourceId: "gid://shopify/Collection/2" },
    ]);
    expect(found.get("gid://shopify/Collection/2")).toBe("Vases");
    expect(found.has("gid://shopify/Product/1")).toBe(false);
  });
});

describe("resolveTaskResourceTitles — the N+1 rule", () => {
  it("costs ONE query per kind, not one per id", async () => {
    const { db, calls } = makeDb({
      product: [
        { id: "gid://shopify/Product/1", shop: SHOP, title: "A" },
        { id: "gid://shopify/Product/2", shop: SHOP, title: "B" },
      ],
      page: [{ id: "gid://shopify/Page/3", shop: SHOP, title: "C" }],
    });
    const found = await resolveTaskResourceTitles(db, SHOP, [
      { resourceType: "product", resourceId: "gid://shopify/Product/1" },
      { resourceType: "product", resourceId: "gid://shopify/Product/2" },
      // The same id twice — one row per image is exactly what convert-webp does.
      { resourceType: "product", resourceId: "gid://shopify/Product/1" },
      { resourceType: "pages", resourceId: "gid://shopify/Page/3" },
      { resourceType: "seo", resourceId: null },
    ]);
    expect([...found.entries()].sort()).toEqual([
      ["gid://shopify/Page/3", "C"],
      ["gid://shopify/Product/1", "A"],
      ["gid://shopify/Product/2", "B"],
    ]);
    expect(calls.sort()).toEqual(["page", "product"]);
  });

  it("queries nothing at all when no entry names a cached item", async () => {
    const { db, calls } = makeDb({ product: [] });
    const found = await resolveTaskResourceTitles(db, SHOP, [
      { resourceType: "templates", resourceId: "theme-group-1" },
    ]);
    expect(found.size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("taskTitleOrFallback", () => {
  it("prefers what the caller already holds and asks the database nothing", async () => {
    const { db, calls } = makeDb({ product: [{ id: "gid://shopify/Product/1", shop: SHOP, title: "Cached" }] });
    await expect(
      taskTitleOrFallback(db, SHOP, "product", "gid://shopify/Product/1", "From the form"),
    ).resolves.toBe("From the form");
    expect(calls).toEqual([]);
  });

  it("reads the cache when the caller holds nothing usable", async () => {
    const { db } = makeDb({ product: [{ id: "gid://shopify/Product/1", shop: SHOP, title: "Cached" }] });
    await expect(
      taskTitleOrFallback(db, SHOP, "product", "gid://shopify/Product/1", "   "),
    ).resolves.toBe("Cached");
  });

  it("uses the fallback LAST, and only when one was offered", async () => {
    const { db } = makeDb({ product: [] });
    await expect(
      taskTitleOrFallback(db, SHOP, "product", "gid://shopify/Product/1", null, "gid://shopify/Product/1"),
    ).resolves.toBe("gid://shopify/Product/1");
    await expect(
      taskTitleOrFallback(db, SHOP, "product", "gid://shopify/Product/1", null),
    ).resolves.toBeUndefined();
  });
});
