import { describe, it, expect } from "vitest";
import { analyzeStore, MAX_PROBLEM_BUCKET_ITEMS } from "~/services/seo/audit.service";

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
        { type: "product", id: "gid-P2" },
        { type: "page", id: "gid-PG1" },
      ]),
    );
    expect(seoTitleMissingBucket?.items.length).toBe(2);
    const metaDescriptionMissingBucket = audit.problems.find((p) => p.code === "metaDescriptionMissing");
    expect(metaDescriptionMissingBucket?.items).toEqual([{ type: "product", id: "gid-P2" }]);

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
        { type: "product", id: "gid-P1" },
        { type: "product", id: "gid-P2" },
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
