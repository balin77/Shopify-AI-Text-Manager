import { describe, it, expect } from "vitest";
import {
  analyzeStore,
  MAX_PROBLEM_BUCKET_ITEMS,
  saveAuditSnapshot,
  getLatestAuditSnapshot,
  getAuditTrend,
  MAX_SNAPSHOTS_PER_SHOP,
  AUDITABLE_PRODUCT_STATUSES,
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
        // `loadExpectedNoindexReasons` asks for UNLISTED products (Shopify
        // serves those noindex itself). Not part of the audit's own scan, so it
        // is neither captured nor answered with the ACTIVE fixtures — doing so
        // would mark every fixture product as an expected exclusion.
        if (args?.where?.status === "UNLISTED") return [];
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

  // Was "only queries ACTIVE products (finding #6)". UNLISTED products are
  // publicly reachable by direct link (verified against a live shop), so their
  // copy is worth auditing; DRAFT/ARCHIVED are not reachable at all and stay
  // excluded. Asserted as an exact set so that adding a status to
  // AUDITABLE_PRODUCT_STATUSES is a deliberate act with a failing test behind
  // it, not a silent widening of what gets audited.
  it("queries exactly ACTIVE + UNLISTED products — never DRAFT or ARCHIVED", async () => {
    const capture = { productArgs: [] as any[] };
    await analyzeStore("shop.myshopify.com", {
      db: makeDb(capture),
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });
    expect(capture.productArgs.length).toBeGreaterThan(0);
    for (const args of capture.productArgs) {
      expect([...args.where.status.in].sort()).toEqual(["ACTIVE", "UNLISTED"]);
    }
  });

  it("keeps the count and the findMany on the SAME status filter", async () => {
    // A mismatch here would report totalAvailable from one population and score
    // another, which shows up as a permanently "capped" audit.
    const capture = { productArgs: [] as any[] };
    await analyzeStore("shop.myshopify.com", {
      db: makeDb(capture),
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });
    // Compare the parsed status sets, not JSON.stringify of the whole where —
    // stringify depends on key insertion order, so a harmless reordering of the
    // literal would fail this with a baffling message.
    const statusSets = capture.productArgs.map((a) => [...a.where.status.in].sort().join(","));
    expect(new Set(statusSets).size).toBe(1);
    expect(capture.productArgs.every((a) => a.where.shop === "shop.myshopify.com")).toBe(true);
  });

  it("exports AUDITABLE_PRODUCT_STATUSES as the single source for that filter", () => {
    expect([...AUDITABLE_PRODUCT_STATUSES].sort()).toEqual(["ACTIVE", "UNLISTED"]);
  });
});

/**
 * Unlisted products are audited but must not FORM duplicate groups.
 *
 * The staging-copy workflow (duplicate an ACTIVE product, keep the copy
 * unlisted until launch) makes a shared SEO title the NORMAL case, not a
 * defect. Grouping them tagged the healthy ACTIVE original with
 * duplicateSeoTitle and fed it to Fix-with-AI — AI credits spent rewriting a
 * page whose only "duplicate" is invisible to Google (unlisted pages are
 * served noindex,nofollow and are absent from sitemap.xml).
 */
describe("analyzeStore — unlisted products and duplicate groups", () => {
  const base = { descriptionHtml: A(200), seoDescription: U(140, "D-"), featuredImageUrl: null, featuredImageAlt: null };
  const makeDb2 = (products: any[]) =>
    ({
      product: { count: async () => products.length, findMany: async () => products },
      productImage: { groupBy: async () => [] },
      collection: { count: async () => 0, findMany: async () => [] },
      article: { count: async () => 0, findMany: async () => [] },
      page: { count: async () => 0, findMany: async () => [] },
    }) as any;

  const run = async (products: any[]) =>
    analyzeStore("shop.myshopify.com", { db: makeDb2(products), seoTitleEffectiveLimit: 60, plan: "pro" });

  const dupCount = (audit: any) =>
    Object.fromEntries(audit.problems.map((p: any) => [p.code, p.count])).duplicateSeoTitle;

  it("does NOT flag an ACTIVE product whose title an UNLISTED staging copy shares", async () => {
    const audit = await run([
      { id: "gid-A", title: U(40, "TA-"), seoTitle: "Shared SEO Title", status: "ACTIVE", ...base },
      { id: "gid-U", title: U(40, "TU-"), seoTitle: "Shared SEO Title", status: "UNLISTED", ...base },
    ]);
    expect(dupCount(audit)).toBeUndefined();
  });

  it("still flags two ACTIVE products sharing a title — the real finding is intact", async () => {
    const audit = await run([
      { id: "gid-A1", title: U(40, "TA1-"), seoTitle: "Shared SEO Title", status: "ACTIVE", ...base },
      { id: "gid-A2", title: U(40, "TA2-"), seoTitle: "Shared SEO Title", status: "ACTIVE", ...base },
    ]);
    expect(dupCount(audit)).toBe(2);
  });

  it("does not flag two UNLISTED products sharing a title either — neither is in any SERP", async () => {
    const audit = await run([
      { id: "gid-U1", title: U(40, "TU1-"), seoTitle: "Shared SEO Title", status: "UNLISTED", ...base },
      { id: "gid-U2", title: U(40, "TU2-"), seoTitle: "Shared SEO Title", status: "UNLISTED", ...base },
    ]);
    expect(dupCount(audit)).toBeUndefined();
  });

  it("still SCORES the unlisted product — excluded from grouping, not from the audit", async () => {
    const audit = await run([
      { id: "gid-A", title: U(40, "TA-"), seoTitle: "Shared SEO Title", status: "ACTIVE", ...base },
      { id: "gid-U", title: U(40, "TU-"), seoTitle: "", status: "UNLISTED", ...base },
    ]);
    expect(audit.totalScanned).toBe(2);
    // The unlisted row still produces its own findings.
    const bucket = audit.problems.find((p: any) => p.code === "seoTitleMissing");
    expect(bucket?.items.map((i: any) => i.id)).toContain("gid-U");
  });

  it("treats a lowercase status the same — the guard normalizes case", async () => {
    const audit = await run([
      { id: "gid-A", title: U(40, "TA-"), seoTitle: "Shared SEO Title", status: "ACTIVE", ...base },
      { id: "gid-U", title: U(40, "TU-"), seoTitle: "Shared SEO Title", status: "unlisted", ...base },
    ]);
    expect(dupCount(audit)).toBeUndefined();
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
function makeSnapshotDb(
  rows: { id: string; shop: string; createdAt: Date; averageScore: number; totalScanned: number; totalAvailable: number; capped: boolean; payload: string }[] = [],
  plan: string = "max",
) {
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
        // Two prune shapes now: the row-cap prune (id.notIn = the newest N)
        // and the plan-retention prune (createdAt.lt, newest row excluded via
        // id.not). A row must match EVERY predicate present to be deleted.
        const keepIds = new Set<string>(where.id?.notIn ?? []);
        const remaining = rows.filter((r) => {
          if (r.shop !== where.shop) return true;
          if (where.id?.notIn && keepIds.has(r.id)) return true;
          if (where.id?.not && r.id === where.id.not) return true;
          if (where.createdAt?.lt && !(r.createdAt < where.createdAt.lt)) return true;
          return false;
        });
        rows.length = 0;
        rows.push(...remaining);
        return { count: before - remaining.length };
      },
    },
    // saveAuditSnapshot reads the plan to apply the retention window
    // (§Plan-Matrix). Max = 365 days, so the pre-existing row-cap assertions
    // stay about the row cap.
    aISettings: {
      findUnique: async () => ({ subscriptionPlan: plan }),
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
      // PLAN_SEO_CRAWL_EXPANSION §7.1 — the on-page buckets read these two.
      // They are separately guarded in the service, so a stub without them
      // still yields the delivery-health buckets; declared here so the on-page
      // ones are actually exercised.
      seoSitemapExclusion: { findMany: async () => [] },
      seoCrawlExternalLink: { count: async () => 0 },
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

  // PLAN_SEO_CRAWL_EXPANSION §7.1 — the on-page buckets.
  it("adds nonIndexable/missingH1 buckets and ranks nonIndexable above a much larger bucket", async () => {
    const onPage = (over: Record<string, unknown>) => ({
      title: "T",
      metaDesc: "d",
      canonical: null,
      metaRobots: "",
      xRobotsTag: "",
      indexabilityKnown: true,
      h1Count: 1,
      h1First: "H",
      wordCount: 400,
      imgCount: 0,
      imgMissingAlt: 0,
      statusCode: 200,
      redirectHops: 0,
      locale: "",
      inboundCount: 2,
      ...over,
    });
    const pages = [
      onPage({
        url: "https://shop.com/products/hidden",
        metaRobots: "noindex",
        resourceType: "product",
        resourceId: "gid-P2",
      }),
      // Shopify's own noindex path — expected, so it must NOT be counted.
      onPage({ url: "https://shop.com/search", metaRobots: "noindex", resourceType: "unknown", resourceId: null }),
      onPage({
        url: "https://shop.com/pages/pg1",
        h1Count: 0,
        h1First: null,
        resourceType: "page",
        resourceId: "gid-PG1",
      }),
    ];
    const db = makeDbWithCrawl("completed", pages, []);

    const audit = await analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
      shopName: "Shop",
    });

    const nonIndexable = audit.problems.find((p) => p.code === "nonIndexable");
    expect(nonIndexable?.action).toBe("deepLink");
    // The /search page is expected and excluded; only the product counts.
    expect(nonIndexable?.count).toBe(1);
    expect(nonIndexable?.items[0]).toMatchObject({ type: "product", id: "gid-P2" });

    const missingH1 = audit.problems.find((p) => p.code === "missingH1");
    expect(missingH1?.action).toBe("deepLink");
    expect(missingH1?.count).toBe(1);

    // One accidental noindex outranks any number of cosmetic findings.
    expect(audit.problems[0].code).toBe("nonIndexable");
    expect(audit.problems.some((p) => p.count > 1)).toBe(true);
  });

  it("blames the FAILING page in the serverErrors bucket, not the page linking to it", async () => {
    // A 4xx is the linking page's fault (bad href); a 5xx is the target's own
    // failure. Reusing the brokenLinks logic here would flag a perfectly
    // healthy page as the problem.
    const pages = [
      {
        url: "https://shop.com/products/healthy",
        title: "Healthy",
        statusCode: 200,
        resourceType: "product",
        resourceId: "gid-OK",
        locale: "",
        inboundCount: 3,
      },
      {
        url: "https://shop.com/collections/slow",
        title: null,
        statusCode: 500,
        resourceType: "collection",
        resourceId: "gid-SLOW",
        locale: "",
        inboundCount: 1,
      },
      {
        // Unresolvable (no DB resource) — must still be counted, just not
        // offered as a deep-linkable item.
        url: "https://shop.com/collections/all",
        title: null,
        statusCode: 500,
        resourceType: "unknown",
        resourceId: null,
        locale: "",
        inboundCount: 1,
      },
    ];
    const db = makeDbWithCrawl("completed", pages, []);

    const audit = await analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
      shopName: "Shop",
    });

    const serverErrors = audit.problems.find((p) => p.code === "serverErrors");
    expect(serverErrors?.action).toBe("deepLink");
    expect(serverErrors?.count).toBe(2);
    expect(serverErrors?.items).toHaveLength(1);
    expect(serverErrors?.items[0]).toMatchObject({ type: "collection", id: "gid-SLOW" });
    // The healthy page that links to the failing one is never listed.
    expect(serverErrors?.items.some((i) => i.id === "gid-OK")).toBe(false);
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

  /** Foreign-locale scan against the same fixture shop, with whatever
   *  ContentTranslation rows the test supplies. */
  async function analyzeInLocale(rows: { resourceId: string; key: string; value: string }[]) {
    const db = {
      ...makeDb(),
      contentTranslation: { findMany: async () => rows },
      productImageAltTranslation: { groupBy: async () => [] },
    } as any;
    return analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
      locale: "fr",
    });
  }

  it("reports an item with NO translations at all as missing every translatable field", async () => {
    // The regression: an item with zero ContentTranslation rows had no overlay
    // entry, so the scorer silently fell back to the primary values and the
    // item looked perfectly translated — nothing was reported for exactly the
    // items that were least translated.
    const audit = await analyzeInLocale([]);
    const bucket = audit.problems.find((p) => p.code === "translationMissing");
    expect(bucket).toBeDefined();
    expect(bucket!.count).toBe(audit.totalScanned);

    const p1 = bucket!.items.find((i) => i.id === "gid-P1");
    expect(p1?.missingTranslations).toEqual(["title", "description", "seoTitle", "metaDescription"]);
  });

  it("does not ask for a translation of a field the primary locale leaves empty", async () => {
    // gid-P2 has no seoTitle/seoDescription at all — there is nothing to
    // translate, and the primary-side seoTitleMissing finding already says so.
    const audit = await analyzeInLocale([]);
    const bucket = audit.problems.find((p) => p.code === "translationMissing");
    const p2 = bucket!.items.find((i) => i.id === "gid-P2");
    expect(p2?.missingTranslations).toEqual(["title", "description"]);
  });

  it("scores the primary value where Shopify falls back, not an empty string", async () => {
    // A partially translated item used to be scored with "" for its missing
    // fields, so it collected seoTitleMissing/metaDescription findings for copy
    // the storefront actually serves (Shopify falls back to the primary).
    const audit = await analyzeInLocale([
      { resourceId: "gid-P1", key: "title", value: U(40, "FR-T1-") },
    ]);
    const p1Row = audit.worstOffenders.find((r) => r.id === "gid-P1");
    // gid-P1 is the fixture's perfect item: falling back keeps it perfect.
    expect(p1Row).toBeUndefined();
    const missing = audit.problems
      .find((p) => p.code === "translationMissing")!
      .items.find((i) => i.id === "gid-P1")?.missingTranslations;
    expect(missing).toEqual(["description", "seoTitle", "metaDescription"]);
  });

  it("drops an item from the bucket once every field is translated", async () => {
    const audit = await analyzeInLocale([
      { resourceId: "gid-P1", key: "title", value: U(40, "FR-T1-") },
      { resourceId: "gid-P1", key: "body_html", value: A(200) },
      { resourceId: "gid-P1", key: "meta_title", value: U(40, "FR-ST1-") },
      { resourceId: "gid-P1", key: "meta_description", value: U(140, "FR-D1-") },
    ]);
    const bucket = audit.problems.find((p) => p.code === "translationMissing");
    expect(bucket!.items.some((i) => i.id === "gid-P1")).toBe(false);
  });

  it("treats an empty stored translation as no translation", async () => {
    // A blank row is not a translation — the storefront serves the primary,
    // exactly as with no row at all.
    const audit = await analyzeInLocale([{ resourceId: "gid-P1", key: "meta_title", value: "   " }]);
    const missing = audit.problems
      .find((p) => p.code === "translationMissing")!
      .items.find((i) => i.id === "gid-P1")?.missingTranslations;
    expect(missing).toContain("seoTitle");
  });

  it("reports no missing translations on a primary-locale scan", async () => {
    const audit = await analyzeStore("shop.myshopify.com", {
      db: makeDb() as any,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
    });
    expect(audit.problems.some((p) => p.code === "translationMissing")).toBe(false);
    expect(audit.worstOffenders.every((r) => r.missingTranslations === undefined)).toBe(true);
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


/**
 * Featured-image alt coverage per locale (Collection/Article).
 *
 * These types used to be scored with the PRIMARY alt text in every locale, on
 * the belief that no per-locale store existed. It does — `ContentTranslation`
 * with `key: "image_alt_text"` on the PARENT, the third translation shape both
 * editors write — so a foreign audit asks whether the alt is TRANSLATED, the
 * same question it already asks for product gallery images.
 */
describe("analyzeStore — featured-image alt coverage per locale", () => {
  const COLLECTION_ID = "gid-C9";
  const ARTICLE_ID = "gid-A9";

  /** One collection + one article, both with a filled PRIMARY alt text. */
  function makeFeaturedImageDb(
    altRows: { resourceId: string; resourceType: "Collection" | "Article"; value: string }[],
  ) {
    const collections = [
      {
        id: COLLECTION_ID,
        title: U(40, "TC9-"),
        descriptionHtml: A(200),
        seoTitle: U(40, "STC9-"),
        seoDescription: U(140, "DC9-"),
        imageUrl: "http://img/c",
        imageAltText: "Primaerer Alt-Text",
      },
    ];
    const articles = [
      {
        id: ARTICLE_ID,
        title: U(40, "TA9-"),
        body: A(200),
        seoTitle: U(40, "STA9-"),
        seoDescription: U(140, "DA9-"),
        imageUrl: "http://img/a",
        imageAltText: "Primaerer Alt-Text",
      },
    ];
    return {
      product: { count: async () => 0, findMany: async () => [] },
      productImage: { groupBy: async () => [] },
      productImageAltTranslation: { groupBy: async () => [] },
      collection: { count: async () => collections.length, findMany: async () => collections },
      article: { count: async () => articles.length, findMany: async () => articles },
      page: { count: async () => 0, findMany: async () => [] },
      contentTranslation: {
        // Two callers, distinguished the way the real query is: the overlay
        // loader asks for the four content keys, the alt loader for
        // `image_alt_text` scoped to one resourceType.
        findMany: async (args: any) => {
          if (args?.where?.key !== "image_alt_text") return [];
          return altRows
            .filter((r) => r.resourceType === args.where.resourceType)
            .map((r) => ({ resourceId: r.resourceId, value: r.value }));
        },
      },
    } as any;
  }

  const analyze = (db: any, locale?: string) =>
    analyzeStore("shop.myshopify.com", {
      db,
      seoTitleEffectiveLimit: 60,
      plan: "pro",
      ...(locale === undefined ? {} : { locale }),
    });

  const missingAltIds = (audit: AuditAggregate) =>
    audit.problems.find((p) => p.code === "imagesMissingAlt")?.items.map((i) => i.id) ?? [];

  it("reports an untranslated featured-image alt in a foreign locale", async () => {
    const audit = await analyze(makeFeaturedImageDb([]), "fr");
    expect(missingAltIds(audit)).toEqual(
      expect.arrayContaining([COLLECTION_ID, ARTICLE_ID]),
    );
  });

  it("does not report it once the alt text is translated for that locale", async () => {
    const db = makeFeaturedImageDb([
      { resourceId: COLLECTION_ID, resourceType: "Collection", value: "Texte alternatif" },
      { resourceId: ARTICLE_ID, resourceType: "Article", value: "Texte alternatif" },
    ]);
    expect(missingAltIds(await analyze(db, "fr"))).toEqual([]);
  });

  it("treats an empty stored alt translation as no translation", async () => {
    const db = makeFeaturedImageDb([
      { resourceId: COLLECTION_ID, resourceType: "Collection", value: "   " },
      { resourceId: ARTICLE_ID, resourceType: "Article", value: "" },
    ]);
    expect(missingAltIds(await analyze(db, "fr"))).toEqual(
      expect.arrayContaining([COLLECTION_ID, ARTICLE_ID]),
    );
  });

  it("does not let a collection's translation cover an article (or vice versa)", async () => {
    const db = makeFeaturedImageDb([
      { resourceId: COLLECTION_ID, resourceType: "Collection", value: "Texte alternatif" },
    ]);
    expect(missingAltIds(await analyze(db, "fr"))).toEqual([ARTICLE_ID]);
  });

  it("still scores the PRIMARY alt text on a primary-locale scan", async () => {
    // No per-locale lookup happens at all here — the primary alt is filled, so
    // neither type reports a missing alt.
    expect(missingAltIds(await analyze(makeFeaturedImageDb([])))).toEqual([]);
  });
});
