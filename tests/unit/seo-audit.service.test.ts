import { describe, it, expect } from "vitest";
import { analyzeStore } from "~/services/seo/audit.service";

/**
 * Bucket + distribution correctness for the store audit (Phase 1 / A2), driven
 * by a hand-rolled Prisma stub. Verifies the alt-coverage groupBy path, the
 * featured-image fallback, plan-type gating, and worst-offender ordering without
 * a real database.
 */

const A = (n: number) => "A".repeat(n);

function makeDb() {
  const products = [
    // Perfect (no images → image criterion skipped, still 100/70-applicable)
    { id: "gid-P1", title: A(40), descriptionHtml: A(200), seoTitle: A(40), seoDescription: A(140), featuredImageUrl: null, featuredImageAlt: null },
    // Missing seo-title + meta
    { id: "gid-P2", title: A(40), descriptionHtml: A(200), seoTitle: "", seoDescription: "", featuredImageUrl: null, featuredImageAlt: null },
    // 1-of-2 images carry alt (via groupBy stub below)
    { id: "gid-P3", title: A(40), descriptionHtml: A(200), seoTitle: A(40), seoDescription: A(140), featuredImageUrl: null, featuredImageAlt: null },
  ];
  const collections = [
    // Description too short
    { id: "gid-C1", title: A(40), descriptionHtml: A(50), seoTitle: A(40), seoDescription: A(140), imageUrl: "http://img", imageAltText: "alt" },
  ];
  const pages = [
    // Missing seo-title
    { id: "gid-PG1", title: A(40), body: A(200), seoTitle: "", seoDescription: A(140) },
  ];

  return {
    product: {
      count: async () => products.length,
      findMany: async () => products,
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
});
