import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import {
  buildAnchorCandidates,
  matchSourceAgainstTargets,
  insertLinkIntoHtml,
  keywordsByResource,
  targetUrlPath,
  runInternalLinkSuggestions,
  MAX_SUGGESTIONS_PER_SOURCE,
  MAX_PENDING_PER_SHOP,
  type TargetItem,
  type AssignmentLike,
} from "~/services/seo/internal-links.service";

/**
 * Phase 2 (PLAN_SEO_SUITE_COMPLETION.md §4/§9) — internal-linking matcher +
 * cheerio insertion. The matcher/insertion functions are pure (no DB), so
 * most cases run directly against them; the DB-orchestration test at the
 * bottom uses a hand-rolled Prisma stub (same style as
 * seo-freshness.service.test.ts / seo-json-ld-audit.service.test.ts).
 */

function target(overrides: Partial<TargetItem> & { title: string; handle: string; resourceId: string }): TargetItem {
  return {
    resourceType: "Product",
    anchors: buildAnchorCandidates({ title: overrides.title }),
    ...overrides,
  } as TargetItem;
}

describe("buildAnchorCandidates", () => {
  it("orders anchors title > primary > secondary > synonym and de-dupes case-insensitively", () => {
    const anchors = buildAnchorCandidates({
      title: "Green Vase",
      primaryKeyword: "ceramic vase",
      secondaryKeywords: ["vase", "GREEN VASE"], // duplicate of title, different case
      synonyms: ["pottery vase"],
    });
    expect(anchors.map((a) => a.kind)).toEqual(["title", "primary", "secondary", "synonym"]);
    expect(anchors.map((a) => a.text)).toEqual(["Green Vase", "ceramic vase", "vase", "pottery vase"]);
  });

  it("skips empty/blank anchors", () => {
    const anchors = buildAnchorCandidates({ title: "Vase", primaryKeyword: "  ", secondaryKeywords: [""] });
    expect(anchors).toEqual([{ text: "Vase", kind: "title" }]);
  });
});

describe("matchSourceAgainstTargets", () => {
  it("matches on the target's title inside a plain text node", () => {
    const t = target({ resourceId: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" });
    const html = "<p>Check out our Green Ceramic Vase collection today.</p>";
    const matches = matchSourceAgainstTargets(html, [t]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ toResourceId: "gid-P1", matchKind: "title", anchorText: "Green Ceramic Vase" });
  });

  it("falls back to the primary keyword when the title isn't mentioned (keyword match)", () => {
    const t = target({
      resourceId: "gid-P1",
      handle: "green-vase",
      title: "Green Ceramic Vase",
      anchors: buildAnchorCandidates({ title: "Green Ceramic Vase", primaryKeyword: "ceramic vase" }),
    });
    const html = "<p>Our ceramic vase collection is handmade in small batches.</p>";
    const matches = matchSourceAgainstTargets(html, [t]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchKind).toBe("primary");
    expect(matches[0].anchorText).toBe("ceramic vase");
  });

  it("falls back to a synonym when neither title nor keywords are mentioned (synonym match)", () => {
    const t = target({
      resourceId: "gid-P1",
      handle: "green-vase",
      title: "Green Ceramic Vase",
      anchors: buildAnchorCandidates({
        title: "Green Ceramic Vase",
        primaryKeyword: "ceramic vase",
        synonyms: ["pottery vessel"],
      }),
    });
    const html = "<p>This pottery vessel looks lovely on a shelf.</p>";
    const matches = matchSourceAgainstTargets(html, [t]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchKind).toBe("synonym");
    expect(matches[0].anchorText).toBe("pottery vessel");
  });

  it("skips a target the source already links to", () => {
    const t = target({ resourceId: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" });
    const html =
      '<p>See our <a href="/products/green-vase">Green Ceramic Vase</a> — also mentioned again here: Green Ceramic Vase.</p>';
    const matches = matchSourceAgainstTargets(html, [t]);
    expect(matches).toEqual([]);
  });

  it("never matches inside an existing <a> or a heading", () => {
    const t = target({ resourceId: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" });
    const html =
      '<h2>Green Ceramic Vase</h2><p>An <a href="/other">unrelated link mentioning Green Ceramic Vase</a> here.</p>';
    const matches = matchSourceAgainstTargets(html, [t]);
    expect(matches).toEqual([]);
  });

  it("caps at MAX_SUGGESTIONS_PER_SOURCE, keeping the highest-confidence matches", () => {
    const targets = ["A", "B", "C", "D"].map((letter, i) =>
      target({ resourceId: `gid-${letter}`, handle: `item-${i}`, title: `Widget ${letter}` }),
    );
    const html = "<p>Widget A, Widget B, Widget C and Widget D all mentioned in one paragraph.</p>";
    const matches = matchSourceAgainstTargets(html, targets);
    expect(matches.length).toBe(MAX_SUGGESTIONS_PER_SOURCE);
    // sorted by confidence, descending
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(matches[i].confidence);
    }
  });

  it("skips target === source (caller responsibility) — matcher itself has no opinion, but an empty target list is a no-op", () => {
    expect(matchSourceAgainstTargets("<p>Green Ceramic Vase</p>", [])).toEqual([]);
  });

  it("returns no matches for empty/whitespace-only HTML", () => {
    const t = target({ resourceId: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" });
    expect(matchSourceAgainstTargets("", [t])).toEqual([]);
    expect(matchSourceAgainstTargets("   ", [t])).toEqual([]);
  });
});

describe("keywordsByResource (locale isolation, §4.1)", () => {
  it("only includes primary-locale (locale '') Product/Collection assignments", () => {
    const assignments: AssignmentLike[] = [
      { resourceType: "Product", resourceId: "gid-P1", keyword: "ceramic vase", role: "primary", locale: "" },
      // Foreign-locale assignment for the SAME item — must be excluded.
      { resourceType: "Product", resourceId: "gid-P1", keyword: "vase en céramique", role: "primary", locale: "fr" },
      // Article assignments aren't targets at all — must be excluded regardless of locale.
      { resourceType: "Article", resourceId: "gid-A1", keyword: "irrelevant", role: "primary", locale: "" },
    ];
    const map = keywordsByResource(assignments);
    expect(map.get("Product:gid-P1")).toEqual({ primary: "ceramic vase", secondaries: [] });
    expect(map.has("Article:gid-A1")).toBe(false);
    // The French assignment must not have overwritten or appended anything.
    expect(map.size).toBe(1);
  });
});

describe("insertLinkIntoHtml", () => {
  it("wraps only the matched substring, leaving surrounding nested markup intact", () => {
    const html =
      "<div><p>Intro <strong>bold <em>emphasis</em></strong> text mentions Product X here.</p><ul><li>Product X</li></ul></div>";
    const result = insertLinkIntoHtml(html, "Product X", "/products/product-x");
    expect(result.inserted).toBe(true);

    const $ = cheerio.load(result.html);
    // Exactly one link was inserted (the first occurrence, inside the <p>).
    expect($("a").length).toBe(1);
    expect($("a").attr("href")).toBe("/products/product-x");
    expect($("a").text()).toBe("Product X");
    // It landed inside the <p>, not the <li> (first eligible occurrence).
    expect($("p a").length).toBe(1);
    expect($("li a").length).toBe(0);
    // Surrounding markup is untouched.
    expect($("strong em").text()).toBe("emphasis");
    expect($("li").text()).toBe("Product X");
    expect($("p").text()).toBe("Intro bold emphasis text mentions Product X here.");
  });

  it("does not insert inside an existing <a>, choosing the next eligible occurrence instead", () => {
    const html = '<p><a href="/other">Product X</a> and also Product X again here.</p>';
    const result = insertLinkIntoHtml(html, "Product X", "/products/product-x");
    expect(result.inserted).toBe(true);
    const $ = cheerio.load(result.html);
    expect($("a").length).toBe(2);
    expect($('a[href="/other"]').text()).toBe("Product X");
    expect($('a[href="/products/product-x"]').length).toBe(1);
    // The original link's target must be untouched.
    expect($('a[href="/other"]').parent().is("p")).toBe(true);
  });

  it("does not insert inside a heading", () => {
    const html = "<h2>Product X</h2><p>Product X is our bestseller.</p>";
    const result = insertLinkIntoHtml(html, "Product X", "/products/product-x");
    expect(result.inserted).toBe(true);
    const $ = cheerio.load(result.html);
    expect($("h2 a").length).toBe(0);
    expect($("p a").length).toBe(1);
  });

  it("returns inserted:false and unchanged html when the anchor text is no longer present (stale suggestion)", () => {
    const html = "<p>Nothing relevant here.</p>";
    const result = insertLinkIntoHtml(html, "Product X", "/products/product-x");
    expect(result.inserted).toBe(false);
    expect(result.html).toBe(html);
  });
});

describe("targetUrlPath", () => {
  it("builds the storefront path per resource type", () => {
    expect(targetUrlPath({ resourceType: "Product", handle: "foo" })).toBe("/products/foo");
    expect(targetUrlPath({ resourceType: "Collection", handle: "bar" })).toBe("/collections/bar");
  });
});

// ── DB orchestration (hand-rolled Prisma stub) ──────────────────────────────

function makeDb(opts: {
  products?: Array<{ id: string; handle: string; title: string; status?: string; descriptionHtml?: string }>;
  collections?: Array<{ id: string; handle: string; title: string }>;
  articles?: Array<{ id: string; body?: string }>;
  pages?: Array<{ id: string; body?: string }>;
  assignments?: Array<{ id: string; resourceType: string; resourceId: string; role: string; keyword: { id: string; keyword: string; locale: string; priority: number; intent: string | null; updatedAt: Date } }>;
  existingSuggestions?: Array<{
    id: string;
    fromResourceType: string;
    fromResourceId: string;
    toResourceType: string;
    toResourceId: string;
    locale: string;
    status: string;
    dismissedUntil: Date | null;
  }>;
}) {
  const products = opts.products ?? [];
  const collections = opts.collections ?? [];
  const articles = opts.articles ?? [];
  const pages = opts.pages ?? [];
  const assignments = opts.assignments ?? [];
  const suggestions = [...(opts.existingSuggestions ?? [])];
  let idCounter = 0;

  return {
    _suggestions: suggestions,
    product: {
      // The service makes TWO different product.findMany calls: one for
      // TARGETS (where.status: "ACTIVE" — draft/archived excluded, §4.1) and
      // one for SOURCES (no status filter — sources aren't status-gated).
      // The stub must honor that distinction for the draft/archived test to
      // actually exercise the real filter instead of trivially passing.
      findMany: async ({ where }: any) => {
        const rows = products.map((p) => ({ status: "ACTIVE", descriptionHtml: "", ...p }));
        return where?.status ? rows.filter((r) => r.status === where.status) : rows;
      },
    },
    collection: {
      findMany: async () => collections,
    },
    article: {
      findMany: async () => articles.map((a) => ({ body: "", ...a })),
    },
    page: {
      findMany: async () => pages.map((p) => ({ body: "", ...p })),
    },
    seoKeywordAssignment: {
      findMany: async () => assignments,
    },
    seoInternalLinkSuggestion: {
      findMany: async () => suggestions,
      create: async ({ data }: any) => {
        const row = { id: `new-${idCounter++}`, ...data };
        suggestions.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = suggestions.find(
          (s) =>
            s.fromResourceType === where.shop_fromResourceType_fromResourceId_toResourceType_toResourceId_locale.fromResourceType &&
            s.fromResourceId === where.shop_fromResourceType_fromResourceId_toResourceType_toResourceId_locale.fromResourceId &&
            s.toResourceType === where.shop_fromResourceType_fromResourceId_toResourceType_toResourceId_locale.toResourceType &&
            s.toResourceId === where.shop_fromResourceType_fromResourceId_toResourceType_toResourceId_locale.toResourceId,
        );
        if (row) Object.assign(row, data);
        return row;
      },
    },
  } as any;
}

const SHOP = "shop.myshopify.com";

describe("runInternalLinkSuggestions (DB orchestration)", () => {
  it("creates a suggestion end-to-end from an article body mentioning a product title", async () => {
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      articles: [{ id: "gid-A1", body: "<p>We love our Green Ceramic Vase in the studio.</p>" }],
    });
    const summary = await runInternalLinkSuggestions(SHOP, { db });
    expect(summary.created).toBe(1);
    expect(db._suggestions).toHaveLength(1);
    expect(db._suggestions[0]).toMatchObject({
      fromResourceType: "Article",
      fromResourceId: "gid-A1",
      toResourceType: "Product",
      toResourceId: "gid-P1",
      locale: "",
      status: "pending",
    });
  });

  it("excludes draft/archived products as targets", async () => {
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase", status: "DRAFT" }],
      articles: [{ id: "gid-A1", body: "<p>We love our Green Ceramic Vase in the studio.</p>" }],
    });
    const summary = await runInternalLinkSuggestions(SHOP, { db });
    expect(summary.created).toBe(0);
  });

  it("never reactivates a dismissed row whose dismissedUntil is in the future", async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      articles: [{ id: "gid-A1", body: "<p>We love our Green Ceramic Vase in the studio.</p>" }],
      existingSuggestions: [
        {
          id: "s1",
          fromResourceType: "Article",
          fromResourceId: "gid-A1",
          toResourceType: "Product",
          toResourceId: "gid-P1",
          locale: "",
          status: "dismissed",
          dismissedUntil: future,
        },
      ],
    });
    const summary = await runInternalLinkSuggestions(SHOP, { db });
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(0);
    expect(db._suggestions[0].status).toBe("dismissed");
  });

  it("never reactivates a permanently-rejected row (dismissedUntil: null)", async () => {
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      articles: [{ id: "gid-A1", body: "<p>We love our Green Ceramic Vase in the studio.</p>" }],
      existingSuggestions: [
        {
          id: "s1",
          fromResourceType: "Article",
          fromResourceId: "gid-A1",
          toResourceType: "Product",
          toResourceId: "gid-P1",
          locale: "",
          status: "dismissed",
          dismissedUntil: null,
        },
      ],
    });
    const summary = await runInternalLinkSuggestions(SHOP, { db });
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(0);
    expect(db._suggestions[0].status).toBe("dismissed");
  });

  it("reactivates a dismissed row whose dismissedUntil has lapsed", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      articles: [{ id: "gid-A1", body: "<p>We love our Green Ceramic Vase in the studio.</p>" }],
      existingSuggestions: [
        {
          id: "s1",
          fromResourceType: "Article",
          fromResourceId: "gid-A1",
          toResourceType: "Product",
          toResourceId: "gid-P1",
          locale: "",
          status: "dismissed",
          dismissedUntil: past,
        },
      ],
    });
    const summary = await runInternalLinkSuggestions(SHOP, { db });
    expect(summary.updated).toBe(1);
    expect(db._suggestions[0].status).toBe("pending");
  });

  it("stops creating new suggestions once MAX_PENDING_PER_SHOP is reached", async () => {
    const existingPending = Array.from({ length: MAX_PENDING_PER_SHOP }, (_, i) => ({
      id: `existing-${i}`,
      fromResourceType: "Page",
      fromResourceId: `gid-existing-${i}`,
      toResourceType: "Product",
      toResourceId: "gid-other",
      locale: "",
      status: "pending",
      dismissedUntil: null,
    }));
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      articles: [{ id: "gid-A1", body: "<p>We love our Green Ceramic Vase in the studio.</p>" }],
      existingSuggestions: existingPending,
    });
    const summary = await runInternalLinkSuggestions(SHOP, { db });
    expect(summary.created).toBe(0);
    expect(summary.cappedByPendingLimit).toBe(true);
  });

  it("locale isolation end-to-end: a foreign-locale keyword never becomes an anchor", async () => {
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      assignments: [
        {
          id: "a1",
          resourceType: "Product",
          resourceId: "gid-P1",
          role: "primary",
          keyword: { id: "k1", keyword: "vase en céramique", locale: "fr", priority: 1, intent: null, updatedAt: new Date() },
        },
      ],
      // The source mentions the FRENCH keyword only, never the (English) title.
      articles: [{ id: "gid-A1", body: "<p>Notre vase en céramique est fabriqué à la main.</p>" }],
    });
    const summary = await runInternalLinkSuggestions(SHOP, { db });
    expect(summary.created).toBe(0);
  });
});
