import { describe, it, expect } from "vitest";
import { resolveGscPagePath, resolvePathsToResources } from "~/services/seo/url-resolver.server";

/**
 * Phase 1 extraction (PLAN_SEO_SUITE_COMPLETION.md §1/§3.1): `resolveGscPagePath`
 * moved here verbatim from google-search-console.server.ts (still covered by
 * tests/unit/google-search-console.server.test.ts via the re-export) and the
 * batched handle→id lookup, generalized from app.seo.search-console.tsx's
 * `resolveQuickWinResources` into `resolvePathsToResources` so the crawler can
 * reuse it too.
 */

function makeDb(overrides: {
  products?: { id: string; handle: string }[];
  collections?: { id: string; handle: string }[];
  pages?: { id: string; handle: string }[];
  articles?: { id: string; handle: string }[];
  /** ContentTranslation rows with key "handle" — a resource's TRANSLATED handle. */
  handleTranslations?: { resourceId: string; resourceType: string; value: string }[];
} = {}) {
  const products = overrides.products ?? [];
  const collections = overrides.collections ?? [];
  const pages = overrides.pages ?? [];
  const articles = overrides.articles ?? [];
  const handleTranslations = overrides.handleTranslations ?? [];
  return {
    contentTranslation: {
      findMany: async ({ where }: any) =>
        handleTranslations.filter((t) => where.value.in.includes(t.value)),
    },
    product: {
      findMany: async ({ where }: any) => products.filter((p) => where.handle.in.includes(p.handle)),
    },
    collection: {
      findMany: async ({ where }: any) => collections.filter((c) => where.handle.in.includes(c.handle)),
    },
    page: {
      findMany: async ({ where }: any) => pages.filter((p) => where.handle.in.includes(p.handle)),
    },
    article: {
      findMany: async ({ where }: any) => articles.filter((a) => where.handle.in.includes(a.handle)),
    },
  } as any;
}

describe("resolvePathsToResources", () => {
  it("resolves a batch of URLs to their DB ids in one findMany per type", async () => {
    const db = makeDb({
      products: [{ id: "gid://shopify/Product/1", handle: "blue-shoe" }],
      collections: [{ id: "gid://shopify/Collection/2", handle: "summer" }],
    });
    const out = await resolvePathsToResources(db, "shop.myshopify.com", [
      "https://shop.example.com/products/blue-shoe",
      "https://shop.example.com/collections/summer",
      "https://shop.example.com/collections/unknown-handle",
      "https://shop.example.com/",
    ]);

    expect(out.get("https://shop.example.com/products/blue-shoe")).toEqual({
      resourceType: "Product",
      handle: "blue-shoe",
      locale: null,
      id: "gid://shopify/Product/1",
    });
    expect(out.get("https://shop.example.com/collections/summer")?.id).toBe("gid://shopify/Collection/2");
    // Matches the pattern but no DB row -> id null, NOT a missing map entry.
    expect(out.get("https://shop.example.com/collections/unknown-handle")).toEqual({
      resourceType: "Collection",
      handle: "unknown-handle",
      locale: null,
      id: null,
    });
    // Doesn't match any known content path at all -> null.
    expect(out.get("https://shop.example.com/")).toBeNull();
  });

  it("carries the locale prefix through to the resolved ref", async () => {
    const db = makeDb({ articles: [{ id: "gid://shopify/Article/9", handle: "launch" }] });
    const out = await resolvePathsToResources(db, "shop.myshopify.com", [
      "https://shop.example.com/de/blogs/news/launch",
    ]);
    expect(out.get("https://shop.example.com/de/blogs/news/launch")).toEqual({
      resourceType: "Article",
      handle: "launch",
      locale: "de",
      id: "gid://shopify/Article/9",
    });
  });

  it("degrades to all-null ids on a DB failure rather than throwing", async () => {
    const db = {
      product: { findMany: async () => { throw new Error("db down"); } },
      collection: { findMany: async () => [] },
      page: { findMany: async () => [] },
      article: { findMany: async () => [] },
      contentTranslation: { findMany: async () => [] },
    } as any;
    const out = await resolvePathsToResources(db, "shop.myshopify.com", [
      "https://shop.example.com/products/blue-shoe",
    ]);
    expect(out.get("https://shop.example.com/products/blue-shoe")?.id).toBeNull();
  });

  it("resolves a TRANSLATED handle — Shopify serves /es/products/<spanish-handle>", async () => {
    // The cache tables only carry the primary handle, so without the fallback
    // most of a translated catalogue has no "open in editor" link.
    const db = makeDb({
      products: [{ id: "gid://shopify/Product/1", handle: "kumikobox-schmuckkaestchen" }],
      handleTranslations: [
        {
          resourceId: "gid://shopify/Product/1",
          resourceType: "Product",
          value: "caja-kumiko-joyero-japones",
        },
      ],
    });
    const url = "https://shop.example.com/es/products/caja-kumiko-joyero-japones";
    const out = await resolvePathsToResources(db, "shop.myshopify.com", [url]);
    expect(out.get(url)).toMatchObject({
      resourceType: "Product",
      id: "gid://shopify/Product/1",
      locale: "es",
    });
  });

  it("does not consult the translation table when the primary handle already matched", async () => {
    let translationQueried = false;
    const db = makeDb({ products: [{ id: "gid-1", handle: "blue-shoe" }] });
    db.contentTranslation.findMany = async () => {
      translationQueried = true;
      return [];
    };
    await resolvePathsToResources(db, "shop.myshopify.com", [
      "https://shop.example.com/products/blue-shoe",
    ]);
    expect(translationQueried).toBe(false);
  });

  it("keeps a translated handle of one type from resolving another type", async () => {
    const db = makeDb({
      handleTranslations: [
        { resourceId: "gid-page-9", resourceType: "Page", value: "sobre-nosotros" },
      ],
    });
    const url = "https://shop.example.com/es/products/sobre-nosotros";
    const out = await resolvePathsToResources(db, "shop.myshopify.com", [url]);
    expect(out.get(url)?.id).toBeNull();
  });

  it("returns an empty map for an empty input", async () => {
    const out = await resolvePathsToResources(makeDb(), "shop.myshopify.com", []);
    expect(out.size).toBe(0);
  });
});

describe("resolveGscPagePath (re-exported, sanity)", () => {
  it("still resolves a product path", () => {
    expect(resolveGscPagePath("https://shop.example.com/products/foo")).toEqual({
      resourceType: "Product",
      handle: "foo",
      locale: null,
    });
  });
});
