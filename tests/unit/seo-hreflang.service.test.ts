import { describe, it, expect, vi } from "vitest";
import { analyzeHreflang } from "~/services/seo/hreflang.service";

/**
 * Phase 4 hreflang coverage logic, with stubbed Prisma + Admin clients. Each
 * test uses a unique shop domain because getCachedShopLocales has a 60s
 * module-level cache keyed by shop.
 */

function makeAdmin(locales: Array<{ locale: string; name: string; primary: boolean; published: boolean }>) {
  return {
    graphql: vi.fn(async () => ({
      json: async () => ({ data: { shopLocales: locales } }),
    })),
  } as any;
}

function makeDb(opts: {
  products?: Array<{ id: string; title: string }>;
  collections?: Array<{ id: string; title: string }>;
  articles?: Array<{ id: string; title: string }>;
  pages?: Array<{ id: string; title: string }>;
  translatedByLocale?: Record<string, string[]>;
}) {
  const products = opts.products ?? [];
  const collections = opts.collections ?? [];
  const articles = opts.articles ?? [];
  const pages = opts.pages ?? [];
  const translatedByLocale = opts.translatedByLocale ?? {};

  return {
    product: { count: async () => products.length, findMany: async () => products },
    collection: { count: async () => collections.length, findMany: async () => collections },
    article: { count: async () => articles.length, findMany: async () => articles },
    page: { count: async () => pages.length, findMany: async () => pages },
    contentTranslation: {
      groupBy: async (args: any) => {
        const ids = translatedByLocale[args.where.locale] ?? [];
        return ids.map((resourceId) => ({ resourceId }));
      },
    },
  } as any;
}

describe("analyzeHreflang", () => {
  it("computes per-locale coverage and lists missing items", async () => {
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
      { locale: "fr", name: "French", primary: false, published: false }, // unpublished → ignored
    ]);
    const db = makeDb({
      products: [
        { id: "gid-P1", title: "P1" },
        { id: "gid-P2", title: "P2" },
      ],
      collections: [{ id: "gid-C1", title: "C1" }],
      translatedByLocale: { de: ["gid-P1", "gid-C1"] },
    });

    const r = await analyzeHreflang("h1.myshopify.com", { db, admin });

    expect(r.primaryLocale).toBe("en");
    expect(r.hasXDefault).toBe(true);
    expect(r.localesUnavailable).toBe(false);
    expect(r.secondaryLocales).toEqual([{ locale: "de", name: "German" }]);
    expect(r.totalPublishable).toBe(3);

    expect(r.coverage).toHaveLength(1);
    const de = r.coverage[0];
    expect(de.locale).toBe("de");
    expect(de.translated).toBe(2);
    expect(de.publishableScanned).toBe(3);
    expect(de.coveragePct).toBe(67); // round(2/3*100)
    expect(de.missingTotal).toBe(1);
    expect(de.missing).toEqual([{ resourceType: "product", resourceId: "gid-P2", title: "P2" }]);
  });

  it("flags localesUnavailable when there is no published secondary locale", async () => {
    const admin = makeAdmin([{ locale: "en", name: "English", primary: true, published: true }]);
    const db = makeDb({ products: [{ id: "gid-P1", title: "P1" }] });

    const r = await analyzeHreflang("h2.myshopify.com", { db, admin });
    expect(r.localesUnavailable).toBe(true);
    expect(r.coverage).toEqual([]);
    // Early return: no catalog scan needed.
    expect(r.totalPublishable).toBe(0);
  });

  it("reports no x-default when the shop has no primary locale", async () => {
    const admin = makeAdmin([{ locale: "de", name: "German", primary: false, published: true }]);
    const db = makeDb({ products: [{ id: "gid-P1", title: "P1" }], translatedByLocale: { de: [] } });

    const r = await analyzeHreflang("h3.myshopify.com", { db, admin });
    expect(r.primaryLocale).toBeNull();
    expect(r.hasXDefault).toBe(false);
    expect(r.coverage[0].coveragePct).toBe(0);
    expect(r.coverage[0].missingTotal).toBe(1);
  });
});
