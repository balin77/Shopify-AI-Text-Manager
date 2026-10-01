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
      product: { count: async () => 3 },
      collection: { count: async () => 0 },
      article: { count: async () => 0 },
    } as any;
  }

  const page = (over: Partial<Record<string, any>> = {}) => ({
    url: "https://shop.example.com/products/a",
    statusCode: 200,
    resourceType: "product",
    jsonLdTypes: "",
    jsonLdAppTypes: "",
    ogTags: "",
    twitterTags: "",
    ogAppTags: "",
    socialKnown: false,
    indexabilityKnown: false,
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

  it("does not call several VideoObjects on one page a duplicate", async () => {
    // A product with three videos carries three VideoObjects for the same
    // reason it carries three videos. The duplicate rule exists for the
    // theme-vs-app collision (two Products), not for markup doing its job —
    // and without the exception our own block would trip our own audit.
    const summary = await summarizeLiveJsonLd(
      crawlDb([
        page({
          url: "https://s/p/1",
          jsonLdTypes: "Product,VideoObject,VideoObject,VideoObject",
          jsonLdAppTypes: "Product,VideoObject,VideoObject,VideoObject",
        }),
      ]),
      "shop.myshopify.com",
    );
    expect(summary!.duplicates).toEqual([]);
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

  it("counts Article and BlogPosting on one page as ONE duplicated claim", async () => {
    // Dawn emits Article for a blog post, this app emits BlogPosting. Both
    // claim to be *the* article of that page, so Google has to pick one —
    // a duplicate that exact @type matching never saw.
    const summary = await summarizeLiveJsonLd(
      crawlDb([
        page({
          url: "https://s/blogs/news/a",
          resourceType: "article",
          jsonLdTypes: "Article,BlogPosting",
          jsonLdAppTypes: "BlogPosting",
        }),
      ]),
      "shop.myshopify.com",
    );
    const dup = summary!.duplicates.find((d) => d.type === "Article")!;
    expect(dup.pages).toBe(1);
    // …and our BlogPosting is recognised as one of the two copies.
    expect(dup.appIsOneCopy).toBe(1);
    // The raw names stay visible in the type list — the merchant sees what the
    // page actually carries.
    expect(summary!.typeCounts.map((t) => t.type).sort()).toEqual(["Article", "BlogPosting"]);
  });

  it("does not fold types that legitimately coexist", async () => {
    const summary = await summarizeLiveJsonLd(
      crawlDb([page({ jsonLdTypes: "Organization,BreadcrumbList,Product" })]),
      "shop.myshopify.com",
    );
    expect(summary!.duplicates).toEqual([]);
  });

  it("reports crawled pages against the catalog size", async () => {
    // The honesty fix: 1 crawled product out of 3 in the catalog must not read
    // like a complete result.
    const summary = await summarizeLiveJsonLd(
      crawlDb([page({ jsonLdTypes: "Product" })]),
      "shop.myshopify.com",
    );
    const products = summary!.coverage.find((c) => c.resourceType === "product")!;
    expect(products.total).toBe(1);
    expect(products.catalogTotal).toBe(3);
  });

  // PLAN_MARKUP_ACTIVATION §1.2 — the per-type stats the activation gate reads.
  it("counts pages and app pages per CANONICAL type", async () => {
    const summary = await summarizeLiveJsonLd(
      crawlDb([
        // Theme-only Product on one page…
        page({ url: "https://s/p/1", jsonLdTypes: "Product" }),
        // …ours alone on the next…
        page({ url: "https://s/p/2", jsonLdTypes: "Product", jsonLdAppTypes: "Product" }),
        // …and both at once on the third, which is the damage state. The theme
        // spelling is ProductGroup, so a raw-name tally would see no collision.
        page({
          url: "https://s/p/3",
          jsonLdTypes: "ProductGroup,Product",
          jsonLdAppTypes: "Product",
        }),
      ]),
      "shop.myshopify.com",
    );
    const product = summary!.typeStats.find((t) => t.type === "Product")!;
    expect(product.pages).toBe(3);
    expect(product.appPages).toBe(2);
    expect(product.duplicatePages).toBe(1);
    expect(product.appIsOneCopy).toBe(1);
    expect(product.repeatable).toBe(false);
  });

  it("marks a repeatable type as such instead of reporting a clean 0", async () => {
    const summary = await summarizeLiveJsonLd(
      crawlDb([page({ jsonLdTypes: "VideoObject,VideoObject", jsonLdAppTypes: "VideoObject" })]),
      "shop.myshopify.com",
    );
    const video = summary!.typeStats.find((t) => t.type === "VideoObject")!;
    expect(video.pages).toBe(1);
    expect(video.appPages).toBe(1);
    // Two VideoObjects on one page are two videos, not a collision — so the
    // duplicate rule stays quiet AND says why.
    expect(video.duplicatePages).toBe(0);
    expect(video.repeatable).toBe(true);
    expect(summary!.duplicates).toEqual([]);
  });

  // The two ways "nobody looked" used to come out as "nothing is served" — and
  // from there, through the activation gate, as "safe to switch on".
  it("reports a crawl with no served page at all as unmeasured", async () => {
    // Password-protected storefront / maintenance / bot shield: every row 4xx.
    // The old rule was `served.length > 0 && served.every(empty)`, so an empty
    // `served` made notMeasured FALSE and every switch went green.
    const summary = await summarizeLiveJsonLd(
      crawlDb([page({ statusCode: 401 }), page({ url: "https://s/p/2", statusCode: 503 })]),
      "shop.myshopify.com",
    );
    expect(summary!.notMeasured).toBe(true);
    expect(summary!.pagesChecked).toBe(0);
  });

  it("ignores a 2xx row whose body this crawl never parsed", async () => {
    // runCrawl persists a row for every URL it touched but fills the markup
    // columns only where it parsed a body — past CRAWL_BFS_MAX_DEPTH, on a
    // cheerio failure, or on a 3xx (still inside the 200-399 served window) it
    // does not. `indexabilityKnown` is set on the same line group, so it is the
    // discriminator. Judging those rows as "no markup" told a merchant their
    // deep-paginated product pages carry none.
    const summary = await summarizeLiveJsonLd(
      crawlDb([
        page({ url: "https://s/p/1", jsonLdTypes: "Product", indexabilityKnown: true }),
        page({ url: "https://s/p/2", jsonLdTypes: "", indexabilityKnown: false }),
      ]),
      "shop.myshopify.com",
    );
    expect(summary!.pagesChecked).toBe(1);
    const product = summary!.typeStats.find((t) => t.type === "Product")!;
    expect(product.pages).toBe(1);
    // …and the coverage table does not report the unparsed page as missing.
    const coverage = summary!.coverage.find((c) => c.resourceType === "product")!;
    expect(coverage.total).toBe(1);
    expect(coverage.withMarkup).toBe(1);
    expect(coverage.missingExamples).toEqual([]);
  });

  it("falls back to every served row when NO row knows", async () => {
    // A snapshot from before indexabilityKnown existed. Dropping everything
    // there would report a shop with real markup as unmeasured.
    const summary = await summarizeLiveJsonLd(
      crawlDb([page({ jsonLdTypes: "Product" })]),
      "shop.myshopify.com",
    );
    expect(summary!.notMeasured).toBe(false);
    expect(summary!.pagesChecked).toBe(1);
  });

  it("buckets the stats by page kind so a page-scoped switch is judged fairly", async () => {
    const summary = await summarizeLiveJsonLd(
      crawlDb([
        page({ url: "https://s/pages/faq", resourceType: "page", jsonLdTypes: "FAQPage" }),
        page({ url: "https://s/p/1", resourceType: "product", jsonLdTypes: "Product" }),
      ]),
      "shop.myshopify.com",
    );
    const faqOnPages = summary!.typeStats.find(
      (t) => t.type === "FAQPage" && t.resourceType === "page",
    )!;
    expect(faqOnPages.pages).toBe(1);
    // Our block emits FAQPage on product pages only — there is no bucket there,
    // which is what keeps the switch from being warned about a page it never
    // touches.
    expect(
      summary!.typeStats.some((t) => t.type === "FAQPage" && t.resourceType === "product"),
    ).toBe(false);
  });

  it("keeps the duplicate rows and the type stats in agreement", async () => {
    const summary = await summarizeLiveJsonLd(
      crawlDb([
        page({
          url: "https://s/blogs/news/a",
          resourceType: "article",
          jsonLdTypes: "Article,BlogPosting",
          jsonLdAppTypes: "BlogPosting",
        }),
      ]),
      "shop.myshopify.com",
    );
    for (const dup of summary!.duplicates) {
      // The duplicate ROWS are shop-wide (one finding, listed once); the stats
      // are per page kind, so the comparison sums them.
      const buckets = summary!.typeStats.filter((t) => t.type === dup.type);
      const sum = (pick: (t: (typeof buckets)[number]) => number) =>
        buckets.reduce((a, t) => a + pick(t), 0);
      expect(sum((t) => t.duplicatePages)).toBe(dup.pages);
      expect(sum((t) => t.appIsOneCopy)).toBe(dup.appIsOneCopy);
    }
  });

  describe("appAllCopiesPages — proof that every copy on a page is ours", () => {
    const statOf = (summary: any, type: string) =>
      summary.typeStats.find((t: any) => t.type === type);

    it("counts a page whose VideoObject copies are all marked as ours", async () => {
      const summary = await summarizeLiveJsonLd(
        crawlDb([
          page({
            jsonLdTypes: "Product,VideoObject,VideoObject",
            jsonLdAppTypes: "VideoObject,VideoObject",
          }),
        ]),
        "shop.myshopify.com",
      );
      expect(statOf(summary, "VideoObject").appAllCopiesPages).toBe(1);
    });

    it("does NOT count a page where one copy is unmarked", async () => {
      const summary = await summarizeLiveJsonLd(
        crawlDb([
          page({
            jsonLdTypes: "VideoObject,VideoObject",
            jsonLdAppTypes: "VideoObject",
          }),
        ]),
        "shop.myshopify.com",
      );
      expect(statOf(summary, "VideoObject").appAllCopiesPages).toBe(0);
    });

    it("refuses a TRUNCATED page as proof, however equal the counts look", async () => {
      // The crawl caps the collected LIST at 50 entries per page, not the
      // count per type. A guard that compared the per-type count against that
      // cap could never fire, and a page whose foreign copies fell off the
      // end would count as proof that all its markup is ours.
      const fifty = Array.from({ length: 50 }, () => "VideoObject").join(",");
      const summary = await summarizeLiveJsonLd(
        crawlDb([page({ jsonLdTypes: fifty, jsonLdAppTypes: fifty })]),
        "shop.myshopify.com",
      );
      expect(statOf(summary, "VideoObject").appAllCopiesPages).toBe(0);
    });
  });

  describe("catalogTotals — the sizes the crawl did NOT measure", () => {
    it("reports a kind the crawl never reached, which is the only case it is for", async () => {
      // The regression this guards: the activation gate asks "does this shop
      // even HAVE article pages" precisely about the kind no article page was
      // crawled for. Deriving that from `coverage` yielded a number exactly
      // when it was not needed — coverage rows exist only for kinds the crawl
      // reached — and nothing in the only case it is needed, which turned a
      // blogless shop's breadcrumb switch into "not measured" for good.
      const summary = await summarizeLiveJsonLd(
        crawlDb([page({ resourceType: "product", jsonLdTypes: "Product" })]),
        "shop.myshopify.com",
      );
      expect(summary!.coverage.some((c) => c.resourceType === "article")).toBe(false);
      expect(summary!.catalogTotals.article).toBe(0);
      expect(summary!.catalogTotals.product).toBe(3);
    });
  });
});
