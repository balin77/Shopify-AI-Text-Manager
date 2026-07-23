import { describe, it, expect } from "vitest";
import {
  analyzeStore,
  MAX_PROBLEM_BUCKET_ITEMS,
  saveAuditSnapshot,
  getLatestAuditSnapshot,
  getAuditTrend,
  MAX_SNAPSHOTS_PER_SHOP,
  type AuditAggregate,
} from "~/services/seo/audit.service";

/**
 * Bucket + distribution correctness for the store audit (Phase 1 / A2), driven
 * by a hand-rolled Prisma stub. Verifies the alt-coverage groupBy path, the
 * featured-image fallback, plan-type gating, and worst-offender ordering without
 * a real database.
 */

const A = (n: number) => "A".repeat(n);
// Length-preserving but UNIQUE filler — a tag prefix followed by "A" padding,
// so items can share a target length (for score-boundary assertions) without
// accidentally colliding on content (which would trip the new duplicate-SEO
// detection and make bucket assertions non-deterministic).
const U = (n: number, tag: string) => (tag + A(Math.max(0, n - tag.length))).slice(0, n);

function makeDb(capture?: { productArgs: any[] }) {
  const products = [
    // Perfect (no images → image criterion skipped, still 100/70-applicable)
    { id: "gid-P1", title: U(40, "T1-"), descriptionHtml: A(200), seoTitle: U(40, "ST1-"), seoDescription: U(140, "D1-"), featuredImageUrl: null, featuredImageAlt: null },
    // Missing seo-title + meta
    { id: "gid-P2", title: U(40, "T2-"), descriptionHtml: A(200), seoTitle: "", seoDescription: "", featuredImageUrl: null, featuredImageAlt: null },
    // 1-of-2 images carry alt (via groupBy stub below)
    { id: "gid-P3", title: U(40, "T3-"), descriptionHtml: A(200), seoTitle: U(40, "ST3-"), seoDescription: U(140, "D3-"), featuredImageUrl: null, featuredImageAlt: null },
  ];
  const collections = [
    // Description too short
    { id: "gid-C1", title: U(40, "TC1-"), descriptionHtml: A(50), seoTitle: U(40, "STC1-"), seoDescription: U(140, "DC1-"), imageUrl: "http://img", imageAltText: "alt" },
  ];
  const pages = [
    // Missing seo-title
    { id: "gid-PG1", title: U(40, "TPG1-"), body: A(200), seoTitle: "", seoDescription: U(140, "DPG1-") },
  ];

  return {
    product: {
      count: async (args: any) => {
        capture?.productArgs.push(args);
        return products.length;
      },
      findMany: async (args: any) => {
        capture?.productArgs.push(args);
        return products;
      },
    },
    productImage: {
      // First call (no AND) = totals; second call (AND alt filters) = with-alt.
      groupBy: async (args: any) => {
        const withAlt = Array.isArray(args?.where?.AND);
        return withAlt
          ? [{ productId: "gid-P3", _count: { _all: 1 } }]
          : [{ productId: "gid-P3", _count: { _all: 2 } }];
      },
    },
    collection: {
      count: async () => collections.length,
      findMany: async () => collections,
    },
    article: {
      count: async () => 0,
      findMany: async () => [],
    },
    page: {
      count: async () => pages.length,
      findMany: async () => pages,
    },
  } as any;
}

describe("analyzeStore", () => {
  it("aggregates scores, buckets and distribution across types", async () => {
    const audit = await analyzeStore("shop.myshopify.com", {
      db: makeDb(),
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });

    expect(audit.totalScanned).toBe(5);
    expect(audit.totalAvailable).toBe(5);
    expect(audit.capped).toBe(false);

    // distribution: P1(100) P3(85) C1(80) PG1(79) good; P2(50) medium
    expect(audit.distribution).toEqual({ good: 4, medium: 1, poor: 0 });
    expect(audit.averageScore).toBe(79); // round(394/5)

    const problems = Object.fromEntries(audit.problems.map((p) => [p.code, p.count]));
    expect(problems.seoTitleMissing).toBe(2); // P2 + PG1
    expect(problems.metaDescriptionMissing).toBe(1); // P2
    expect(problems.imagesMissingAlt).toBe(1); // P3
    expect(problems.descriptionTooShort).toBe(1); // C1
    // most common first
    expect(audit.problems[0].code).toBe("seoTitleMissing");

    // Bucket item refs (Fix-with-AI): the affected ids/types are carried
    // alongside the count so the bulk-fix handler knows what to regenerate.
    const seoTitleMissingBucket = audit.problems.find((p) => p.code === "seoTitleMissing");
    expect(seoTitleMissingBucket?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "product", id: "gid-P2" }),
        expect.objectContaining({ type: "page", id: "gid-PG1" }),
      ]),
    );
    expect(seoTitleMissingBucket?.items.length).toBe(2);
    const metaDescriptionMissingBucket = audit.problems.find((p) => p.code === "metaDescriptionMissing");
    expect(metaDescriptionMissingBucket?.items).toEqual([
      expect.objectContaining({ type: "product", id: "gid-P2" }),
    ]);

    // worst offender is the lowest score with issues (P2 @ 50)
    expect(audit.worstOffenders[0].id).toBe("gid-P2");
    expect(audit.worstOffenders.every((r) => r.issueCount > 0)).toBe(true);
    // the perfect product is not listed
    expect(audit.worstOffenders.find((r) => r.id === "gid-P1")).toBeUndefined();

    // byType excludes the empty article type
    const types = audit.byType.map((s) => s.type).sort();
    expect(types).toEqual(["collection", "page", "product"]);
  });

  it("skips types the plan does not grant (free → no articles/pages)", async () => {
    const audit = await analyzeStore("shop.myshopify.com", {
      db: makeDb(),
      seoTitleEffectiveLimit: 60,
      plan: "free", // products + collections only
    });
    const types = audit.byType.map((s) => s.type).sort();
    expect(types).toEqual(["collection", "product"]);
    expect(audit.totalScanned).toBe(4); // 3 products + 1 collection
  });

  it("only queries ACTIVE products (finding #6 — DRAFT/ARCHIVED aren't storefront-visible)", async () => {
    const capture = { productArgs: [] as any[] };
    await analyzeStore("shop.myshopify.com", {
      db: makeDb(capture),
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });
    expect(capture.productArgs.length).toBeGreaterThan(0);
    for (const args of capture.productArgs) {
      expect(args.where.status).toBe("ACTIVE");
    }
  });
});

describe("analyzeStore — duplicate SEO title/description detection", () => {
  function makeDupDb() {
    const products = [
      // P1 and P2 share the same seoTitle → both affected.
      { id: "gid-P1", title: U(40, "T1-"), descriptionHtml: A(200), seoTitle: "Shared SEO Title", seoDescription: U(140, "D1-"), featuredImageUrl: null, featuredImageAlt: null },
      { id: "gid-P2", title: U(40, "T2-"), descriptionHtml: A(200), seoTitle: "  Shared SEO Title  ", seoDescription: U(140, "D2-"), featuredImageUrl: null, featuredImageAlt: null },
      // P3 has a unique seoTitle → not affected.
      { id: "gid-P3", title: U(40, "T3-"), descriptionHtml: A(200), seoTitle: "Unique Title Three", seoDescription: U(140, "D3-"), featuredImageUrl: null, featuredImageAlt: null },
      // P4 and P5 both leave seoTitle empty and have DIFFERENT titles → no
      // false positive: two independently-empty seoTitles must not collide
      // with each other, and neither counts as a duplicate of P1/P2 by
      // accidentally falling back to an empty string.
      { id: "gid-P4", title: U(40, "T4-"), descriptionHtml: A(200), seoTitle: "", seoDescription: "", featuredImageUrl: null, featuredImageAlt: null },
      { id: "gid-P5", title: U(40, "T5-"), descriptionHtml: A(200), seoTitle: "", seoDescription: "", featuredImageUrl: null, featuredImageAlt: null },
    ];
    return {
      product: { count: async () => products.length, findMany: async () => products },
      productImage: { groupBy: async () => [] },
      collection: { count: async () => 0, findMany: async () => [] },
      article: { count: async () => 0, findMany: async () => [] },
      page: { count: async () => 0, findMany: async () => [] },
    } as any;
  }

  it("flags items sharing a normalized (trim+lowercase) non-empty SEO title", async () => {
    const audit = await analyzeStore("shop.myshopify.com", {
      db: makeDupDb(),
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });
    const problems = Object.fromEntries(audit.problems.map((p) => [p.code, p.count]));
    expect(problems.duplicateSeoTitle).toBe(2); // P1 + P2 only
  });

  it("does not treat two independently-empty SEO titles as duplicates of each other", async () => {
    const audit = await analyzeStore("shop.myshopify.com", {
      db: makeDupDb(),
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });
    // P4/P5 both fall back to their (unique) titles, and empty
    // seoDescriptions never enter the group at all — neither should ever
    // inflate duplicateSeoTitle/duplicateSeoDescription.
    expect(Object.fromEntries(audit.problems.map((p) => [p.code, p.count])).duplicateSeoTitle).toBe(2);
    expect(audit.problems.find((p) => p.code === "duplicateSeoDescription")).toBeUndefined();
  });

  it("carries typed item refs for the duplicate-SEO buckets too", async () => {
    const audit = await analyzeStore("shop.myshopify.com", {
      db: makeDupDb(),
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });
    const duplicateSeoTitleBucket = audit.problems.find((p) => p.code === "duplicateSeoTitle");
    expect(duplicateSeoTitleBucket?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "product", id: "gid-P1" }),
        expect.objectContaining({ type: "product", id: "gid-P2" }),
      ]),
    );
    expect(duplicateSeoTitleBucket?.items.length).toBe(2);
  });
});

describe("analyzeStore — problem bucket item cap", () => {
  it("caps the per-bucket item ref list at MAX_PROBLEM_BUCKET_ITEMS while keeping the true count", async () => {
    const total = MAX_PROBLEM_BUCKET_ITEMS + 5;
    const products = Array.from({ length: total }, (_, i) => ({
      id: `gid-P${i}`,
      title: U(40, `T${i}-`),
      descriptionHtml: A(200),
      seoTitle: "", // every product is missing its seoTitle -> all land in one bucket
      seoDescription: U(140, `D${i}-`),
      featuredImageUrl: null,
      featuredImageAlt: null,
    }));
    const db = {
      product: { count: async () => products.length, findMany: async () => products },
      productImage: { groupBy: async () => [] },
      collection: { count: async () => 0, findMany: async () => [] },
      article: { count: async () => 0, findMany: async () => [] },
      page: { count: async () => 0, findMany: async () => [] },
    } as any;

    const audit = await analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });

    const bucket = audit.problems.find((p) => p.code === "seoTitleMissing");
    expect(bucket?.count).toBe(total); // true total, uncapped
    expect(bucket?.items.length).toBe(MAX_PROBLEM_BUCKET_ITEMS); // ref list capped
  });
});

// ─── Snapshot persistence (SEO Audit Dashboard caching, Anhang B) ──────────

const SAMPLE_AUDIT: AuditAggregate = {
  totalScanned: 3,
  totalAvailable: 3,
  averageScore: 77,
  distribution: { good: 2, medium: 1, poor: 0 },
  byType: [{ type: "product", count: 3, avgScore: 77, good: 2, medium: 1, poor: 0 }],
  problems: [{ code: "seoTitleMissing", count: 1, items: [{ type: "product", id: "gid-1", title: "T" }] }],
  worstOffenders: [{ id: "gid-1", type: "product", title: "T", score: 50, issueCount: 2, problems: ["seoTitleMissing"] }],
  capped: false,
};

/** Hand-rolled seoScoreSnapshot delegate stub, recording create/findMany/findFirst/deleteMany calls. */
function makeSnapshotDb(rows: { id: string; shop: string; createdAt: Date; averageScore: number; totalScanned: number; totalAvailable: number; capped: boolean; payload: string }[] = []) {
  const calls: { method: string; args: any }[] = [];
  const db = {
    seoScoreSnapshot: {
      create: async ({ data }: any) => {
        calls.push({ method: "create", args: data });
        const row = { id: `snap-${rows.length + 1}`, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      findFirst: async ({ where, orderBy }: any) => {
        calls.push({ method: "findFirst", args: { where, orderBy } });
        const matching = rows.filter((r) => r.shop === where.shop);
        matching.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matching[0] ?? null;
      },
      findMany: async ({ where, orderBy, select, take }: any) => {
        calls.push({ method: "findMany", args: { where, orderBy, select, take } });
        let matching = rows.filter((r) => r.shop === where.shop);
        matching.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (take) matching = matching.slice(0, take);
        if (select) {
          return matching.map((r) => {
            const picked: any = {};
            for (const key of Object.keys(select)) picked[key] = (r as any)[key];
            return picked;
          });
        }
        return matching;
      },
      deleteMany: async ({ where }: any) => {
        calls.push({ method: "deleteMany", args: where });
        const before = rows.length;
        const keepIds = new Set<string>(where.id?.notIn ?? []);
        const remaining = rows.filter((r) => !(r.shop === where.shop && !keepIds.has(r.id)));
        rows.length = 0;
        rows.push(...remaining);
        return { count: before - remaining.length };
      },
    },
  } as any;
  return { db, rows, calls };
}

describe("saveAuditSnapshot", () => {
  it("persists averageScore/totalScanned/totalAvailable/capped alongside the JSON payload", async () => {
    const { db, rows } = makeSnapshotDb();
    await saveAuditSnapshot(db, "shop.myshopify.com", SAMPLE_AUDIT);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shop: "shop.myshopify.com",
      averageScore: 77,
      totalScanned: 3,
      totalAvailable: 3,
      capped: false,
    });
    expect(JSON.parse(rows[0].payload)).toEqual(SAMPLE_AUDIT);
  });

  it("prunes down to the newest MAX_SNAPSHOTS_PER_SHOP rows per shop", async () => {
    const now = Date.now();
    const existing = Array.from({ length: MAX_SNAPSHOTS_PER_SHOP }, (_, i) => ({
      id: `old-${i}`,
      shop: "shop.myshopify.com",
      createdAt: new Date(now - (MAX_SNAPSHOTS_PER_SHOP - i) * 1000),
      averageScore: 50,
      totalScanned: 1,
      totalAvailable: 1,
      capped: false,
      payload: "{}",
    }));
    const { db, rows } = makeSnapshotDb(existing);

    await saveAuditSnapshot(db, "shop.myshopify.com", SAMPLE_AUDIT);

    expect(rows).toHaveLength(MAX_SNAPSHOTS_PER_SHOP);
    // The oldest pre-existing row must be the one pruned away.
    expect(rows.find((r) => r.id === "old-0")).toBeUndefined();
  });

  it("does not touch another shop's snapshots when pruning", async () => {
    const now = Date.now();
    const existing = Array.from({ length: MAX_SNAPSHOTS_PER_SHOP }, (_, i) => ({
      id: `mine-${i}`,
      shop: "shop-a.myshopify.com",
      createdAt: new Date(now - (MAX_SNAPSHOTS_PER_SHOP - i) * 1000),
      averageScore: 50,
      totalScanned: 1,
      totalAvailable: 1,
      capped: false,
      payload: "{}",
    }));
    existing.push({
      id: "other-shop-row",
      shop: "shop-b.myshopify.com",
      createdAt: new Date(now - 999999),
      averageScore: 10,
      totalScanned: 1,
      totalAvailable: 1,
      capped: false,
      payload: "{}",
    });
    const { db, rows } = makeSnapshotDb(existing);

    await saveAuditSnapshot(db, "shop-a.myshopify.com", SAMPLE_AUDIT);

    expect(rows.find((r) => r.id === "other-shop-row")).toBeDefined();
  });
});

describe("getLatestAuditSnapshot", () => {
  it("returns null when no snapshot exists yet", async () => {
    const { db } = makeSnapshotDb();
    expect(await getLatestAuditSnapshot(db, "shop.myshopify.com")).toBeNull();
  });

  it("returns the latest snapshot parsed back into an AuditAggregate", async () => {
    const { db } = makeSnapshotDb();
    await saveAuditSnapshot(db, "shop.myshopify.com", SAMPLE_AUDIT);

    const snapshot = await getLatestAuditSnapshot(db, "shop.myshopify.com");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.audit).toEqual(SAMPLE_AUDIT);
    expect(snapshot!.createdAt).toBeInstanceOf(Date);
  });

  it("returns null (not a throw) when the stored payload is corrupt JSON", async () => {
    const { db } = makeSnapshotDb([
      {
        id: "corrupt-1",
        shop: "shop.myshopify.com",
        createdAt: new Date(),
        averageScore: 1,
        totalScanned: 1,
        totalAvailable: 1,
        capped: false,
        payload: "{not valid json",
      },
    ]);
    expect(await getLatestAuditSnapshot(db, "shop.myshopify.com")).toBeNull();
  });
});

describe("getAuditTrend", () => {
  it("returns lightweight points oldest -> newest, select-minimized (no payload)", async () => {
    const now = Date.now();
    const existing = [
      { id: "s1", shop: "shop.myshopify.com", createdAt: new Date(now - 2000), averageScore: 60, totalScanned: 5, totalAvailable: 5, capped: false, payload: "{}" },
      { id: "s2", shop: "shop.myshopify.com", createdAt: new Date(now - 1000), averageScore: 70, totalScanned: 5, totalAvailable: 5, capped: false, payload: "{}" },
      { id: "s3", shop: "shop.myshopify.com", createdAt: new Date(now), averageScore: 80, totalScanned: 6, totalAvailable: 6, capped: false, payload: "{}" },
    ];
    const { db } = makeSnapshotDb(existing);

    const trend = await getAuditTrend(db, "shop.myshopify.com");
    expect(trend.map((p) => p.averageScore)).toEqual([60, 70, 80]);
    expect(trend[0]).not.toHaveProperty("payload");
    expect(trend[0]).toHaveProperty("createdAt");
    expect(trend[0]).toHaveProperty("totalScanned");
  });

  it("respects the limit argument", async () => {
    const now = Date.now();
    const existing = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      shop: "shop.myshopify.com",
      createdAt: new Date(now - (10 - i) * 1000),
      averageScore: i,
      totalScanned: 1,
      totalAvailable: 1,
      capped: false,
      payload: "{}",
    }));
    const { db } = makeSnapshotDb(existing);

    const trend = await getAuditTrend(db, "shop.myshopify.com", "", 3);
    expect(trend.map((p) => p.averageScore)).toEqual([7, 8, 9]);
  });
});

// ─── Phase 1 (PLAN_SEO_SUITE_COMPLETION.md §3.6): crawl-derived dashboard
// buckets — brokenLinks / orphanPages / headDrift, action:"deepLink" ─────────

describe("analyzeStore — crawl-derived dashboard buckets (§3.6)", () => {
  function makeDbWithCrawl(snapshotStatus: string | null, pages: any[] = [], brokenLinks: any[] = []) {
    return {
      ...makeDb(),
      seoCrawlSnapshot: {
        findFirst: async () => (snapshotStatus ? { id: "snap-1", status: snapshotStatus } : null),
      },
      seoCrawlPage: { findMany: async () => pages },
      seoCrawlBrokenLink: { findMany: async () => brokenLinks },
    } as any;
  }

  it("adds brokenLinks/orphanPages/headDrift buckets, all action:'deepLink'", async () => {
    const pages = [
      {
        url: "https://shop.com/products/p2",
        title: "T2 crawled title",
        statusCode: 200,
        resourceType: "product",
        resourceId: "gid-P2",
        locale: "",
        inboundCount: 0,
      },
      {
        url: "https://shop.com/pages/pg1",
        title: "Something Totally Different",
        statusCode: 200,
        resourceType: "page",
        resourceId: "gid-PG1",
        locale: "",
        inboundCount: 3,
      },
    ];
    const brokenLinks = [
      { fromUrl: "https://shop.com/products/p2", toUrl: "https://shop.com/products/missing", statusCode: 404 },
    ];
    const db = makeDbWithCrawl("completed", pages, brokenLinks);

    const audit = await analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
      shopName: "Shop",
    });

    const broken = audit.problems.find((p) => p.code === "brokenLinks");
    expect(broken?.action).toBe("deepLink");
    expect(broken?.count).toBe(1);
    expect(broken?.items[0]).toMatchObject({ type: "product", id: "gid-P2" });

    const orphans = audit.problems.find((p) => p.code === "orphanPages");
    expect(orphans?.action).toBe("deepLink");
    expect(orphans?.count).toBe(1);
    expect(orphans?.items[0]).toMatchObject({ type: "product", id: "gid-P2" });

    // gid-PG1's DB title (U(40,"TPG1-")) differs from the crawled title.
    const headDrift = audit.problems.find((p) => p.code === "headDrift");
    expect(headDrift?.action).toBe("deepLink");
    expect(headDrift?.count).toBeGreaterThanOrEqual(1);
    expect(headDrift?.items.some((i) => i.id === "gid-PG1")).toBe(true);
  });

  it("does not count a broken (404) resolved page as headDrift, even though its (null) crawled title differs from the DB title (§ fix 5)", async () => {
    const pages = [
      {
        url: "https://shop.com/pages/pg1",
        title: null, // never parsed — the page 404'd, so the body was never read
        statusCode: 404,
        resourceType: "page",
        resourceId: "gid-PG1",
        locale: "",
        inboundCount: 3,
      },
    ];
    const db = makeDbWithCrawl("completed", pages, []);

    const audit = await analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
      shopName: "Shop",
    });

    const headDrift = audit.problems.find((p) => p.code === "headDrift");
    expect(headDrift).toBeUndefined();
  });

  it("suppresses the orphanPages bucket when the crawl was capped (§3.1 — unreliable orphan data)", async () => {
    const pages = [
      {
        url: "https://shop.com/products/p2",
        title: "T2",
        resourceType: "product",
        resourceId: "gid-P2",
        locale: "",
        inboundCount: 0,
      },
    ];
    const db = makeDbWithCrawl("capped", pages, []);
    const audit = await analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
      shopName: "Shop",
    });
    expect(audit.problems.find((p) => p.code === "orphanPages")).toBeUndefined();
  });

  it("adds no crawl buckets when no snapshot exists yet (free plan / never crawled)", async () => {
    const db = makeDbWithCrawl(null);
    const audit = await analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });
    expect(audit.problems.some((p) => p.action === "deepLink")).toBe(false);
  });

  it("existing DB-cache buckets keep action:'fixWithAi'", async () => {
    const db = makeDbWithCrawl(null);
    const audit = await analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });
    const seoTitleMissingBucket = audit.problems.find((p) => p.code === "seoTitleMissing");
    expect(seoTitleMissingBucket?.action).toBe("fixWithAi");
  });

  it("does not query crawl tables for a foreign-locale scan (crawl data is primary-only)", async () => {
    let called = false;
    const db = {
      ...makeDb(),
      // Foreign-locale scoring reads ContentTranslation overlays + per-locale
      // product alt coverage — irrelevant to this test, just needs to not throw.
      contentTranslation: { findMany: async () => [] },
      productImageAltTranslation: { groupBy: async () => [] },
      seoCrawlSnapshot: {
        findFirst: async () => {
          called = true;
          return null;
        },
      },
    } as any;
    await analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
      locale: "fr",
    });
    expect(called).toBe(false);
  });

  it("a crawl-table read failure degrades gracefully (no crawl buckets, scan still succeeds)", async () => {
    const db = {
      ...makeDb(),
      seoCrawlSnapshot: {
        findFirst: async () => {
          throw new Error("db down");
        },
      },
    } as any;
    const audit = await analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });
    expect(audit.totalScanned).toBeGreaterThan(0);
    expect(audit.problems.some((p) => p.action === "deepLink")).toBe(false);
  });
});

