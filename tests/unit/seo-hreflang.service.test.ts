import { describe, it, expect, vi } from "vitest";
import { analyzeHreflang } from "~/services/seo/hreflang.service";
import type { TranslationKey } from "~/services/seo/hreflang-coverage.shared";

/**
 * Phase 4 hreflang coverage logic, with stubbed Prisma + Admin clients. Each
 * test uses a unique shop domain because getCachedShopLocales has a 60s
 * module-level cache keyed by shop.
 *
 * The per-field arithmetic itself is covered by seo-hreflang-coverage.test.ts;
 * what is exercised here is the cache READ — that the scan hands the pure layer
 * the right primary values, the right per-type scan facts and one grouped
 * translation read per locale.
 */

const ALL_KEYS: TranslationKey[] = ["title", "body_html", "meta_title", "meta_description"];

function makeAdmin(locales: Array<{ locale: string; name: string; primary: boolean; published: boolean }>) {
  return {
    graphql: vi.fn(async () => ({
      json: async () => ({ data: { shopLocales: locales } }),
    })),
  } as any;
}

type Row = {
  id: string;
  title: string;
  descriptionHtml?: string | null;
  body?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
};

/** A row whose four primary fields are all filled — every key is demanded. */
function full(id: string, title = id, bodyField: "descriptionHtml" | "body" = "descriptionHtml"): Row {
  return {
    id,
    title,
    [bodyField]: "<p>body</p>",
    seoTitle: "seo",
    seoDescription: "seo description",
  };
}

function makeDb(opts: {
  products?: Row[];
  collections?: Row[];
  articles?: Row[];
  pages?: Row[];
  /** locale → resourceId → the keys translated in that locale. */
  translatedByLocale?: Record<string, Record<string, TranslationKey[]>>;
  /** Override count() to simulate a catalog larger than the scanned page (capped). */
  counts?: { products?: number; collections?: number; articles?: number; pages?: number };
  /** Cached products BEFORE the ACTIVE filter — an all-draft catalogue. */
  anyProducts?: number;
  groupByCalls?: { n: number };
  groupByArgs?: any[];
}) {
  const products = opts.products ?? [];
  const collections = opts.collections ?? [];
  const articles = opts.articles ?? [];
  const pages = opts.pages ?? [];
  const translatedByLocale = opts.translatedByLocale ?? {};
  const counts = opts.counts ?? {};

  /**
   * The scan issues TWO reads per type against the same delegate: the page of
   * rows, and an id-only companion asking which of them carry a body. The stub
   * has to tell them apart or every row would look as if it had one.
   */
  const findMany =
    (rows: Row[], bodyField: "descriptionHtml" | "body") => async (args: any) => {
      const isPresenceRead = args?.select?.id === true && args?.select?.title !== true;
      if (!isPresenceRead) return rows;
      return rows
        .filter((r) => {
          const value = (r as Record<string, unknown>)[bodyField];
          return typeof value === "string" && value !== "";
        })
        .map((r) => ({ id: r.id }));
    };

  return {
    product: {
      // Unfiltered = "has this type ever been synced"; filtered = publishable.
      count: async (args: any) =>
        args?.where?.status === undefined
          ? opts.anyProducts ?? counts.products ?? products.length
          : counts.products ?? products.length,
      findMany: findMany(products, "descriptionHtml"),
    },
    collection: {
      count: async () => counts.collections ?? collections.length,
      findMany: findMany(collections, "descriptionHtml"),
    },
    article: {
      count: async () => counts.articles ?? articles.length,
      findMany: findMany(articles, "body"),
    },
    page: {
      count: async () => counts.pages ?? pages.length,
      findMany: findMany(pages, "body"),
    },
    contentTranslation: {
      groupBy: async (args: any) => {
        if (opts.groupByCalls) opts.groupByCalls.n += 1;
        if (opts.groupByArgs) opts.groupByArgs.push(args);
        // The read must group by BOTH columns, or the field dimension is a lie.
        expect(args.by).toEqual(["resourceId", "key"]);
        const byId = translatedByLocale[args.where.locale] ?? {};
        return Object.entries(byId).flatMap(([resourceId, keys]) =>
          keys.map((key) => ({ resourceId, key })),
        );
      },
    },
  } as any;
}

/** Every listed id fully translated. */
function allOf(ids: string[]): Record<string, TranslationKey[]> {
  return Object.fromEntries(ids.map((id) => [id, ALL_KEYS]));
}

describe("analyzeHreflang", () => {
  it("computes per-locale coverage and lists missing items with their fields", async () => {
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
      { locale: "fr", name: "French", primary: false, published: false }, // unpublished → ignored
    ]);
    const db = makeDb({
      products: [full("gid-P1", "P1"), full("gid-P2", "P2")],
      collections: [full("gid-C1", "C1")],
      translatedByLocale: { de: allOf(["gid-P1", "gid-C1"]) },
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
    expect(de.missing).toEqual([
      { resourceType: "product", resourceId: "gid-P2", title: "P2", missingKeys: ALL_KEYS },
    ]);
  });

  it("issues exactly ONE grouped translation read per locale (no per-type fan-out)", async () => {
    const groupByCalls = { n: 0 };
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
      { locale: "es", name: "Spanish", primary: false, published: true },
      { locale: "fr", name: "French", primary: false, published: true },
    ]);
    const db = makeDb({
      products: [full("gid-P1")],
      collections: [full("gid-C1")],
      articles: [full("gid-A1", "A1", "body")],
      pages: [full("gid-PG1", "PG1", "body")],
      groupByCalls,
    });

    await analyzeHreflang("h7.myshopify.com", { db, admin });
    expect(groupByCalls.n).toBe(3); // three secondary locales, four types
  });

  it("only demands a key whose PRIMARY value exists", async () => {
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
    ]);
    const db = makeDb({
      // No SEO fields and no description in the primary locale: the title is the
      // only thing that can be translated, and it is.
      pages: [{ id: "gid-PG1", title: "PG1", body: "", seoTitle: null, seoDescription: null }],
      translatedByLocale: { de: { "gid-PG1": ["title"] } },
    });

    const r = await analyzeHreflang("h8.myshopify.com", { db, admin });
    expect(r.coverage[0].missingTotal).toBe(0);
    expect(r.coverage[0].coveragePct).toBe(100);
    const gaps = Object.fromEntries(r.coverage[0].fieldGaps.map((g) => [g.key, g]));
    expect(gaps.meta_description).toEqual({ key: "meta_description", required: 0, missing: 0 });
  });

  it("a partially translated resource is NOT complete and names the missing fields", async () => {
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
    ]);
    const db = makeDb({
      products: [full("gid-P1", "P1")],
      translatedByLocale: { de: { "gid-P1": ["title"] } },
    });

    const r = await analyzeHreflang("h9.myshopify.com", { db, admin });
    expect(r.coverage[0].coveragePct).toBe(0);
    expect(r.coverage[0].missing[0].missingKeys).toEqual([
      "body_html",
      "meta_title",
      "meta_description",
    ]);
  });

  it("a type with nothing cached reads as unknown, never as complete", async () => {
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
    ]);
    const db = makeDb({
      products: [full("gid-P1")],
      translatedByLocale: { de: allOf(["gid-P1"]) },
    });

    const r = await analyzeHreflang("h10.myshopify.com", { db, admin });
    const byType = Object.fromEntries(r.coverage[0].byType.map((t) => [t.resourceType, t]));
    expect(byType.product.coveragePct).toBe(100);
    expect(byType.article).toMatchObject({ known: false, scanned: 0, coveragePct: 0 });
  });

  it("an all-DRAFT catalogue is KNOWN with nothing publishable, not unscanned", async () => {
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
    ]);
    // 12 cached products, none of them ACTIVE. "Sync this type" would never
    // change that, so the type must not read as unscanned.
    const db = makeDb({
      pages: [full("gid-PG1", "PG1", "body")],
      anyProducts: 12,
      counts: { products: 0 },
      translatedByLocale: { de: allOf(["gid-PG1"]) },
    });

    const r = await analyzeHreflang("h11.myshopify.com", { db, admin });
    const byType = Object.fromEntries(r.coverage[0].byType.map((t) => [t.resourceType, t]));
    expect(byType.product).toMatchObject({ known: true, scanned: 0, cachedTotal: 0 });
    expect(byType.article.known).toBe(false); // nothing cached at all
  });

  it("counts the GLOBAL layer only — a market override is not the locale's URL", async () => {
    const groupByArgs: any[] = [];
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
    ]);
    const db = makeDb({ products: [full("gid-P1")], groupByArgs });

    await analyzeHreflang("h12.myshopify.com", { db, admin });
    expect(groupByArgs[0].where.marketId).toBe("");
  });

  it("does not credit a key whose translation row is empty", async () => {
    const groupByArgs: any[] = [];
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
    ]);
    const db = makeDb({ products: [full("gid-P1")], groupByArgs });

    await analyzeHreflang("h13.myshopify.com", { db, admin });
    expect(groupByArgs[0].where.NOT).toEqual({ value: "" });
  });

  it("flags localesUnavailable when there is no published secondary locale", async () => {
    const admin = makeAdmin([{ locale: "en", name: "English", primary: true, published: true }]);
    const db = makeDb({ products: [full("gid-P1")] });

    const r = await analyzeHreflang("h2.myshopify.com", { db, admin });
    expect(r.localesUnavailable).toBe(true);
    expect(r.coverage).toEqual([]);
    // Early return: no catalog scan needed.
    expect(r.totalPublishable).toBe(0);
  });

  it("reports no x-default when the shop has no primary locale", async () => {
    const admin = makeAdmin([{ locale: "de", name: "German", primary: false, published: true }]);
    const db = makeDb({ products: [full("gid-P1")], translatedByLocale: { de: {} } });

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
      products: [full("gid-P1", "P1"), full("gid-P2", "P2")],
      translatedByLocale: { de: allOf(["gid-P1", "gid-P2"]), es: allOf(["gid-P1"]) },
    });

    const r = await analyzeHreflang("h4.myshopify.com", { db, admin });
    const byLocale = Object.fromEntries(r.coverage.map((c) => [c.locale, c]));
    expect(byLocale.de.coveragePct).toBe(100);
    expect(byLocale.de.missingTotal).toBe(0);
    expect(byLocale.es.coveragePct).toBe(50);
    expect(byLocale.es.missing).toEqual([
      { resourceType: "product", resourceId: "gid-P2", title: "P2", missingKeys: ALL_KEYS },
    ]);
  });

  it("fully translated locale → 100% and empty missing list", async () => {
    const admin = makeAdmin([
      { locale: "en", name: "English", primary: true, published: true },
      { locale: "de", name: "German", primary: false, published: true },
    ]);
    const db = makeDb({
      collections: [full("gid-C1", "C1")],
      translatedByLocale: { de: allOf(["gid-C1"]) },
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
      products: [full("gid-P1", "P1"), full("gid-P2", "P2")],
      counts: { products: 1000 },
      translatedByLocale: { de: allOf(["gid-P1"]) },
    });
    const r = await analyzeHreflang("h6.myshopify.com", { db, admin });
    expect(r.capped).toBe(true);
    expect(r.coverage[0].publishableScanned).toBe(2);
    expect(r.coverage[0].coveragePct).toBe(50);
    const product = r.coverage[0].byType.find((t) => t.resourceType === "product")!;
    expect(product).toMatchObject({ cachedTotal: 1000, scanned: 2, capped: true, known: true });
  });
});
