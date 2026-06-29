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
  /** Override count() to simulate a catalog larger than the scanned page (capped). */
  counts?: { products?: number; collections?: number; articles?: number; pages?: number };
}) {
  const products = opts.products ?? [];
  const collections = opts.collections ?? [];
  const articles = opts.articles ?? [];
  const pages = opts.pages ?? [];
  const translatedByLocale = opts.translatedByLocale ?? {};
  const counts = opts.counts ?? {};

  return {
    product: { count: async () => counts.products ?? products.length, findMany: async () => products },
    collection: { count: async () => counts.collections ?? collections.length, findMany: async () => collections },
    article: { count: async () => counts.articles ?? articles.length, findMany: async () => articles },
    page: { count: async () => counts.pages ?? pages.length, findMany: async () => pages },
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

  it("handles multiple secondary locales with divergent translation sets", async () => {
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
      { locale: "es", name: "Spanish", primary: false, published: true },
    ]);
    const db = makeDb({
      products: [
        { id: "gid-P1", title: "P1" },
        { id: "gid-P2", title: "P2" },
      ],
      translatedByLocale: { de: ["gid-P1", "gid-P2"], es: ["gid-P1"] },
    });

    const r = await analyzeHreflang("h4.myshopify.com", { db, admin });
    const byLocale = Object.fromEntries(r.coverage.map((c) => [c.locale, c]));
    expect(byLocale.de.coveragePct).toBe(100);
    expect(byLocale.de.missingTotal).toBe(0);
    expect(byLocale.es.coveragePct).toBe(50);
    expect(byLocale.es.missing).toEqual([{ resourceType: "product", resourceId: "gid-P2", title: "P2" }]);
  });

  it("fully translated locale → 100% and empty missing list", async () => {
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
    ]);
    const db = makeDb({
      collections: [{ id: "gid-C1", title: "C1" }],
      translatedByLocale: { de: ["gid-C1"] },
    });
    const r = await analyzeHreflang("h5.myshopify.com", { db, admin });
    expect(r.coverage[0].coveragePct).toBe(100);
    expect(r.coverage[0].missingTotal).toBe(0);
    expect(r.coverage[0].missing).toEqual([]);
  });

  it("sets capped when a type's catalog exceeds the scanned page, and never shows 100% with missing items", async () => {
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
    ]);
    // 2 products scanned but count says 1000 → capped; 1 of the 2 translated.
    const db = makeDb({
      products: [
        { id: "gid-P1", title: "P1" },
        { id: "gid-P2", title: "P2" },
      ],
      counts: { products: 1000 },
      translatedByLocale: { de: ["gid-P1"] },
    });
    const r = await analyzeHreflang("h6.myshopify.com", { db, admin });
    expect(r.capped).toBe(true);
    expect(r.coverage[0].publishableScanned).toBe(2);
    expect(r.coverage[0].coveragePct).toBe(50);
  });
});
