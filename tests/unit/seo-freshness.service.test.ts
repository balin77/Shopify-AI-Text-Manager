import { describe, it, expect } from "vitest";
import {
  analyzeFreshness,
  excludeDismissed,
  freshnessDismissKey,
  FRESHNESS_MAX_POSITION,
  FRESHNESS_MIN_IMPRESSIONS,
  FRESHNESS_STALE_DAYS,
  type FreshnessCandidate,
} from "~/services/seo/freshness.service";

/**
 * Phase 3 (PLAN_SEO_SUITE_COMPLETION.md §5) — Content-Freshness rule edge
 * cases, driven by a hand-rolled Prisma stub (same style as
 * seo-json-ld-audit.service.test.ts). The stub's seoGscPageStat.findMany
 * applies the SAME position/impressions boundary the service's `where`
 * clause encodes (>= / <=, both inclusive) so the boundary tests actually
 * exercise that semantics rather than trusting a real Postgres query.
 */

const SHOP = "shop.myshopify.com";
const NOW = new Date("2026-07-23T00:00:00Z");

interface PageStatRow {
  shop: string;
  page: string;
  resourceType: string | null;
  resourceId: string | null;
  position: number;
  clicks: number;
  impressions: number;
  ctr: number;
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function makeDb(opts: {
  pageStats?: PageStatRow[];
  products?: Array<{ id: string; title: string; handle: string; shopifyUpdatedAt: Date }>;
  collections?: Array<{ id: string; title: string; handle: string; shopifyUpdatedAt: Date }>;
  articles?: Array<{ id: string; title: string; handle: string; shopifyUpdatedAt: Date }>;
  pages?: Array<{ id: string; title: string; handle: string; shopifyUpdatedAt: Date }>;
}) {
  const pageStats = opts.pageStats ?? [];
  const byType = (type: string, rows: any[] | undefined) => ({
    findMany: async ({ where }: any) => {
      const ids: string[] = where?.id?.in ?? [];
      return (rows ?? []).filter((r) => ids.includes(r.id));
    },
  });
  return {
    seoGscPageStat: {
      findMany: async () =>
        // Mirrors the service's `where`: position <= max, impressions >= min,
        // resourceType/resourceId not null.
        pageStats.filter(
          (r) =>
            r.resourceType !== null &&
            r.resourceId !== null &&
            r.position <= FRESHNESS_MAX_POSITION &&
            r.impressions >= FRESHNESS_MIN_IMPRESSIONS,
        ),
    },
    product: byType("Product", opts.products),
    collection: byType("Collection", opts.collections),
    article: byType("Article", opts.articles),
    page: byType("Page", opts.pages),
  } as any;
}

describe("analyzeFreshness", () => {
  it("returns nothing when there is no GSC page-stat row at all (missing GSC row)", async () => {
    const db = makeDb({
      pageStats: [],
      products: [{ id: "gid-P1", title: "Old Product", handle: "old", shopifyUpdatedAt: daysAgo(400) }],
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates).toEqual([]);
  });

  it("excludes a freshly-synced item (shopifyUpdatedAt within the stale window)", async () => {
    const db = makeDb({
      pageStats: [
        {
          shop: SHOP,
          page: "https://shop.example.com/products/fresh",
          resourceType: "Product",
          resourceId: "gid-P1",
          position: 5,
          clicks: 10,
          impressions: 500,
          ctr: 0.02,
        },
      ],
      products: [{ id: "gid-P1", title: "Fresh Product", handle: "fresh", shopifyUpdatedAt: daysAgo(10) }],
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates).toEqual([]);
  });

  it("includes an item updated exactly at the FRESHNESS_STALE_DAYS boundary", async () => {
    const db = makeDb({
      pageStats: [
        {
          shop: SHOP,
          page: "https://shop.example.com/products/boundary",
          resourceType: "Product",
          resourceId: "gid-P1",
          position: 10,
          clicks: 5,
          impressions: 500,
          ctr: 0.01,
        },
      ],
      products: [
        { id: "gid-P1", title: "Boundary Product", handle: "boundary", shopifyUpdatedAt: daysAgo(FRESHNESS_STALE_DAYS + 1) },
      ],
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].resourceId).toBe("gid-P1");
  });

  it("includes a row with impressions exactly at the FRESHNESS_MIN_IMPRESSIONS threshold", async () => {
    const db = makeDb({
      pageStats: [
        {
          shop: SHOP,
          page: "https://shop.example.com/products/at-threshold",
          resourceType: "Product",
          resourceId: "gid-P1",
          position: 8,
          clicks: 2,
          impressions: FRESHNESS_MIN_IMPRESSIONS,
          ctr: 0.02,
        },
      ],
      products: [{ id: "gid-P1", title: "At Threshold", handle: "at-threshold", shopifyUpdatedAt: daysAgo(200) }],
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates).toHaveLength(1);
  });

  it("excludes a row with impressions one below the FRESHNESS_MIN_IMPRESSIONS threshold", async () => {
    const db = makeDb({
      pageStats: [
        {
          shop: SHOP,
          page: "https://shop.example.com/products/below-threshold",
          resourceType: "Product",
          resourceId: "gid-P1",
          position: 8,
          clicks: 2,
          impressions: FRESHNESS_MIN_IMPRESSIONS - 1,
          ctr: 0.02,
        },
      ],
      products: [{ id: "gid-P1", title: "Below Threshold", handle: "below-threshold", shopifyUpdatedAt: daysAgo(200) }],
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates).toEqual([]);
  });

  it("includes a row with position exactly at the FRESHNESS_MAX_POSITION threshold", async () => {
    const db = makeDb({
      pageStats: [
        {
          shop: SHOP,
          page: "https://shop.example.com/products/pos-threshold",
          resourceType: "Product",
          resourceId: "gid-P1",
          position: FRESHNESS_MAX_POSITION,
          clicks: 2,
          impressions: 300,
          ctr: 0.02,
        },
      ],
      products: [{ id: "gid-P1", title: "Position Threshold", handle: "pos-threshold", shopifyUpdatedAt: daysAgo(200) }],
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates).toHaveLength(1);
  });

  it("excludes a row with position one beyond the FRESHNESS_MAX_POSITION threshold", async () => {
    const db = makeDb({
      pageStats: [
        {
          shop: SHOP,
          page: "https://shop.example.com/products/pos-over",
          resourceType: "Product",
          resourceId: "gid-P1",
          position: FRESHNESS_MAX_POSITION + 1,
          clicks: 2,
          impressions: 300,
          ctr: 0.02,
        },
      ],
      products: [{ id: "gid-P1", title: "Position Over", handle: "pos-over", shopifyUpdatedAt: daysAgo(200) }],
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates).toEqual([]);
  });

  it("flags the CTR-bonus signal (double priority) for a row in the Quick-wins position/impressions band", async () => {
    const db = makeDb({
      pageStats: [
        {
          shop: SHOP,
          page: "https://shop.example.com/products/bonus",
          resourceType: "Product",
          resourceId: "gid-P1",
          // Inside findCtrOpportunities' band: position 4-20, impressions >= 200.
          position: 10,
          clicks: 4,
          impressions: 400,
          ctr: 0.01,
        },
      ],
      products: [{ id: "gid-P1", title: "Bonus Product", handle: "bonus", shopifyUpdatedAt: daysAgo(200) }],
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].priority).toBe(2);
  });

  it("does NOT flag the CTR-bonus signal for a row outside the Quick-wins band (position 1-3)", async () => {
    const db = makeDb({
      pageStats: [
        {
          shop: SHOP,
          page: "https://shop.example.com/products/no-bonus",
          resourceType: "Product",
          resourceId: "gid-P1",
          position: 2, // ranks great — outside findCtrOpportunities' 4-20 band
          clicks: 50,
          impressions: 400,
          ctr: 0.12,
        },
      ],
      products: [{ id: "gid-P1", title: "No Bonus Product", handle: "no-bonus", shopifyUpdatedAt: daysAgo(200) }],
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].priority).toBe(1);
  });

  it("sorts bonus (priority 2) candidates before normal (priority 1) ones", async () => {
    const db = makeDb({
      pageStats: [
        {
          shop: SHOP,
          page: "https://shop.example.com/products/normal",
          resourceType: "Product",
          resourceId: "gid-P1",
          position: 1,
          clicks: 90,
          impressions: 300,
          ctr: 0.3,
        },
        {
          shop: SHOP,
          page: "https://shop.example.com/products/bonus",
          resourceType: "Product",
          resourceId: "gid-P2",
          position: 15,
          clicks: 4,
          impressions: 300,
          ctr: 0.01,
        },
      ],
      products: [
        { id: "gid-P1", title: "Normal", handle: "normal", shopifyUpdatedAt: daysAgo(200) },
        { id: "gid-P2", title: "Bonus", handle: "bonus", shopifyUpdatedAt: daysAgo(200) },
      ],
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates.map((c) => c.resourceId)).toEqual(["gid-P2", "gid-P1"]);
  });

  it("skips a resolved page-stat row whose resource no longer exists in the content cache", async () => {
    const db = makeDb({
      pageStats: [
        {
          shop: SHOP,
          page: "https://shop.example.com/products/deleted",
          resourceType: "Product",
          resourceId: "gid-deleted",
          position: 8,
          clicks: 4,
          impressions: 300,
          ctr: 0.01,
        },
      ],
      products: [], // gid-deleted no longer in the cache
    });
    const result = await analyzeFreshness(SHOP, { db, now: NOW });
    expect(result.candidates).toEqual([]);
  });
});

describe("excludeDismissed / freshnessDismissKey", () => {
  function makeCandidate(overrides: Partial<FreshnessCandidate> = {}): FreshnessCandidate {
    return {
      resourceType: "Product",
      resourceId: "gid-P1",
      title: "Product",
      handle: "product",
      page: "https://shop.example.com/products/product",
      position: 8,
      ctr: 0.02,
      impressions: 300,
      clicks: 6,
      shopifyUpdatedAt: daysAgo(200),
      daysSinceUpdate: 200,
      priority: 1,
      ...overrides,
    };
  }

  it("filters out a dismissed candidate by its composite key", () => {
    const candidates = [makeCandidate()];
    const key = freshnessDismissKey("Product", "gid-P1");
    expect(excludeDismissed(candidates, [key])).toEqual([]);
  });

  it("keeps candidates whose key isn't in the dismissed list", () => {
    const candidates = [makeCandidate()];
    expect(excludeDismissed(candidates, ["Product:gid-other"])).toHaveLength(1);
  });

  it("is a no-op for an empty dismissed list", () => {
    const candidates = [makeCandidate()];
    expect(excludeDismissed(candidates, [])).toBe(candidates);
  });
});
