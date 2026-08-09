import { describe, it, expect } from "vitest";
import { runJsonLdAudit, summarizeLiveJsonLd } from "~/services/seo/json-ld-audit.service";
import { MAX_PROBLEM_BUCKET_ITEMS } from "~/services/seo/audit.service";

/**
 * Phase 5 (PLAN_SEO_SUITE_COMPLETION.md §7) — JSON-LD batch audit aggregation,
 * driven by a hand-rolled Prisma stub (same style as seo-audit.service.test.ts).
 * Verifies the product/collection/article scan, the previewMode:true gating
 * (no offerNoAvailability/articleNoDatePublished noise from the DB-cache
 * gaps), and the MAX_PROBLEM_BUCKET_ITEMS cap.
 */

const shopInfo = { domain: "shop.example.com", name: "Acme" };

function makeDb(overrides: {
  products?: any[];
  variants?: any[];
  collections?: any[];
  articles?: any[];
  productCount?: number;
  collectionCount?: number;
  articleCount?: number;
} = {}) {
  const products = overrides.products ?? [];
  const variants = overrides.variants ?? [];
  const collections = overrides.collections ?? [];
  const articles = overrides.articles ?? [];
  return {
    product: {
      count: async () => overrides.productCount ?? products.length,
      findMany: async () => products,
    },
    productVariant: {
      findMany: async () => variants,
    },
    collection: {
      count: async () => overrides.collectionCount ?? collections.length,
      findMany: async () => collections,
    },
    article: {
      count: async () => overrides.articleCount ?? articles.length,
      findMany: async () => articles,
    },
  } as any;
}

describe("runJsonLdAudit", () => {
  it("scans products/collections/articles and reports totals", async () => {
    const db = makeDb({
      products: [
        {
          id: "gid-P1",
          title: "Complete Product",
          descriptionHtml: "<p>desc</p>",
          handle: "complete-product",
          seoDescription: "SEO desc",
          featuredImageUrl: "https://cdn/p1.jpg",
          images: [],
        },
      ],
      variants: [{ productId: "gid-P1", position: 1, price: { toString: () => "19.99" }, barcode: "012345678905" }],
      collections: [
        { id: "gid-C1", title: "Sale", descriptionHtml: "<p>d</p>", handle: "sale", seoDescription: "Sale desc" },
      ],
      articles: [
        {
          id: "gid-A1",
          title: "Post",
          body: "<p>body</p>",
          summary: null,
          handle: "post",
          blogTitle: "News",
          imageUrl: "https://cdn/a1.jpg",
        },
      ],
    });

    const aggregate = await runJsonLdAudit("shop.myshopify.com", {
      db,
      shopInfo,
      currencyCode: "USD",
    });

    expect(aggregate.totalScanned).toBe(3);
    expect(aggregate.totalAvailable).toBe(3);
    expect(aggregate.capped).toBe(false);
    // A fully-populated product (price+currency+gtin+image+description),
    // collection and article produce zero warnings.
    expect(aggregate.buckets).toEqual([]);
  });

  it("flags missing product image/description and missing GTIN/MPN without price data", async () => {
    const db = makeDb({
      products: [
        {
          id: "gid-P2",
          title: "Bare Product",
          descriptionHtml: null,
          handle: "bare-product",
          seoDescription: null,
          featuredImageUrl: null,
          images: [],
        },
      ],
    });

    const aggregate = await runJsonLdAudit("shop.myshopify.com", {
      db,
      shopInfo,
      currencyCode: "USD",
    });

    const codes = aggregate.buckets.map((b) => b.code).sort();
    expect(codes).toEqual(["productNoDescription", "productNoGtinMpn", "productNoImage"].sort());
    // productNoOffer / offerNoAvailability must NOT appear: previewMode:true
    // suppresses the "no price data in DB cache" false positive (§7.2/§11.4).
    expect(codes).not.toContain("productNoOffer");
    expect(codes).not.toContain("offerNoAvailability");

    const imageBucket = aggregate.buckets.find((b) => b.code === "productNoImage")!;
    expect(imageBucket.severity).toBe("warning");
    expect(imageBucket.count).toBe(1);
    expect(imageBucket.items).toEqual([
      { type: "product", id: "gid-P2", title: "Bare Product", url: "https://shop.example.com/products/bare-product" },
    ]);
  });

  it("flags missing article headline/image, never articleNoDatePublished (no publishedAt in the DB cache)", async () => {
    const db = makeDb({
      articles: [
        {
          id: "gid-A2",
          title: "",
          body: "<p>body</p>",
          summary: null,
          handle: "no-title",
          blogTitle: "News",
          imageUrl: null,
        },
      ],
    });

    const aggregate = await runJsonLdAudit("shop.myshopify.com", {
      db,
      shopInfo,
      currencyCode: "USD",
    });

    const codes = aggregate.buckets.map((b) => b.code).sort();
    expect(codes).toEqual(["articleMissingHeadline", "articleNoImage"].sort());
    expect(codes).not.toContain("articleNoDatePublished");
  });

  it("reports capped:true when a type's DB count exceeds the scanned rows", async () => {
    const db = makeDb({
      products: [
        {
          id: "gid-P1",
          title: "T",
          descriptionHtml: "d",
          handle: "t",
          seoDescription: "d",
          featuredImageUrl: "i",
          images: [],
        },
      ],
      productCount: 5000, // more than the 1 row findMany returned
    });

    const aggregate = await runJsonLdAudit("shop.myshopify.com", { db, shopInfo, currencyCode: "USD" });
    expect(aggregate.capped).toBe(true);
    expect(aggregate.totalAvailable).toBe(5000);
    expect(aggregate.totalScanned).toBe(1);
  });

  it("caps the per-bucket item ref list at MAX_PROBLEM_BUCKET_ITEMS while keeping the true count", async () => {
    const total = MAX_PROBLEM_BUCKET_ITEMS + 5;
    const products = Array.from({ length: total }, (_, i) => ({
      id: `gid-P${i}`,
      title: `Product ${i}`,
      descriptionHtml: "<p>desc</p>",
      handle: `product-${i}`,
      seoDescription: "SEO desc",
      featuredImageUrl: null, // every product is missing its image -> one bucket
      images: [],
    }));
    const db = makeDb({ products });

    const aggregate = await runJsonLdAudit("shop.myshopify.com", { db, shopInfo, currencyCode: "USD" });
    const bucket = aggregate.buckets.find((b) => b.code === "productNoImage");
    expect(bucket?.count).toBe(total); // true total, uncapped
    expect(bucket?.items.length).toBe(MAX_PROBLEM_BUCKET_ITEMS); // ref list capped
  });

  it("calls onProgress at the configured interval and once more at the end", async () => {
    const products = Array.from({ length: 5 }, (_, i) => ({
      id: `gid-P${i}`,
      title: `Product ${i}`,
      descriptionHtml: "d",
      handle: `p${i}`,
      seoDescription: "d",
      featuredImageUrl: "i",
      images: [],
    }));
    const db = makeDb({ products });
    const progressCalls: Array<[number, number]> = [];

    await runJsonLdAudit("shop.myshopify.com", {
      db,
      shopInfo,
      currencyCode: "USD",
      heartbeatEvery: 2,
      onProgress: (processed, total) => {
        progressCalls.push([processed, total]);
      },
    });

    // Heartbeats at processed=2, processed=4, plus the final (5,5) call.
    expect(progressCalls).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });
});

// ── Live coverage from the crawl snapshot ──────────────────────────────────

describe("summarizeLiveJsonLd", () => {
  /** Crawl-snapshot stub: only the two delegates the summary reads. */
  function crawlDb(pages: any[] | null, status = "completed") {
    return {
      seoCrawlSnapshot: {
        findFirst: async () =>
          pages === null
            ? null
            : { id: "snap-1", startedAt: new Date("2026-08-01T10:00:00Z"), finishedAt: new Date("2026-08-01T10:20:00Z"), status },
      },
      seoCrawlPage: { findMany: async () => pages ?? [] },
    } as any;
  }

  const page = (over: Partial<Record<string, any>> = {}) => ({
    url: "https://shop.example.com/products/a",
    statusCode: 200,
    resourceType: "product",
    jsonLdTypes: "",
    jsonLdAppTypes: "",
    ...over,
  });

  it("returns null when the shop has never completed a crawl", async () => {
    expect(await summarizeLiveJsonLd(crawlDb(null), "shop.myshopify.com")).toBeNull();
  });

  it("counts a product page as covered by Product or ProductGroup", async () => {
    const summary = await summarizeLiveJsonLd(
      crawlDb([
        page({ url: "https://s/p/1", jsonLdTypes: "Organization,Product" }),
        // Shopify's own structured_data filter emits ProductGroup for products
        // with variants — counting only "Product" would report it as missing.
        page({ url: "https://s/p/2", jsonLdTypes: "ProductGroup" }),
        page({ url: "https://s/p/3", jsonLdTypes: "Organization,BreadcrumbList" }),
      ]),
      "shop.myshopify.com",
    );
    const products = summary!.coverage.find((c) => c.resourceType === "product")!;
    expect(products.total).toBe(3);
    expect(products.withMarkup).toBe(2);
    expect(products.missingExamples).toEqual(["https://s/p/3"]);
  });

  it("ignores pages that never served content", async () => {
    // A 404 without Product markup is not a structured-data problem.
    const summary = await summarizeLiveJsonLd(
      crawlDb([
        page({ url: "https://s/p/1", jsonLdTypes: "Product" }),
        page({ url: "https://s/p/gone", statusCode: 404 }),
      ]),
      "shop.myshopify.com",
    );
    expect(summary!.pagesChecked).toBe(1);
    expect(summary!.coverage.find((c) => c.resourceType === "product")!.total).toBe(1);
  });

  it("reports a type served twice on one page as a duplicate", async () => {
    const summary = await summarizeLiveJsonLd(
      crawlDb([
        page({ url: "https://s/p/1", jsonLdTypes: "Product,Organization,Product" }),
        page({ url: "https://s/p/2", jsonLdTypes: "Product" }),
      ]),
      "shop.myshopify.com",
    );
    expect(summary!.duplicates).toEqual([
      { type: "Product", pages: 1, examples: ["https://s/p/1"], appIsOneCopy: 0 },
    ]);
    // Duplicates must not inflate the per-type page count.
    expect(summary!.typeCounts.find((t) => t.type === "Product")!.pages).toBe(2);
  });

  it("flags a pre-column snapshot as not measured instead of 'no markup'", async () => {
    const summary = await summarizeLiveJsonLd(
      crawlDb([page({ jsonLdTypes: "" }), page({ url: "https://s/p/2", jsonLdTypes: "" })]),
      "shop.myshopify.com",
    );
    expect(summary!.notMeasured).toBe(true);
  });

  it("does not flag notMeasured once any page reports a type", async () => {
    const summary = await summarizeLiveJsonLd(
      crawlDb([page({ jsonLdTypes: "" }), page({ url: "https://s/p/2", jsonLdTypes: "Product" })]),
      "shop.myshopify.com",
    );
    expect(summary!.notMeasured).toBe(false);
  });

  it("carries the crawl status through so a capped run can be labelled", async () => {
    const summary = await summarizeLiveJsonLd(crawlDb([page()], "capped"), "shop.myshopify.com");
    expect(summary!.crawlStatus).toBe("capped");
  });

  it("attributes a duplicate to this app when one copy carries our marker", async () => {
    const summary = await summarizeLiveJsonLd(
      crawlDb([
        // Theme + our block on the same page.
        page({ url: "https://s/p/1", jsonLdTypes: "Product,Product", jsonLdAppTypes: "Product" }),
        // Theme + some OTHER app: turning our toggle off would not help here,
        // so it must not be counted as ours.
        page({ url: "https://s/p/2", jsonLdTypes: "Product,Product" }),
      ]),
      "shop.myshopify.com",
    );
    const dup = summary!.duplicates.find((d) => d.type === "Product")!;
    expect(dup.pages).toBe(2);
    expect(dup.appIsOneCopy).toBe(1);
    expect(summary!.appEmbedDetected).toBe(true);
  });

  it("reports the app embed as unknown rather than off when nothing is marked", async () => {
    // A snapshot crawled before the marked block shipped is indistinguishable
    // from a shop with the embed disabled — saying "off" would be a guess.
    const summary = await summarizeLiveJsonLd(
      crawlDb([page({ jsonLdTypes: "Product" })]),
      "shop.myshopify.com",
    );
    expect(summary!.appEmbedDetected).toBeNull();
  });
});
