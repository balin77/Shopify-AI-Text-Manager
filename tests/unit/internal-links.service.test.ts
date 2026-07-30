import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import {
  buildAnchorCandidates,
  matchSourceAgainstTargets,
  insertLinkIntoHtml,
  keywordsByResource,
  targetUrlPath,
  runInternalLinkSuggestions,
  rejectedAnchorsByTarget,
  groupSuggestionsBySource,
  MAX_SUGGESTIONS_PER_SOURCE,
  MAX_PENDING_PER_SHOP,
  SYNONYM_BATCH_SIZE,
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

  it("does not treat a handle-prefix collision as already-linked (regression: /products/vase-large matching /products/vase)", () => {
    const t = target({ resourceId: "gid-P1", handle: "vase", title: "Vase" });
    // The only link on the page is to a DIFFERENT product whose handle
    // happens to start with the same string ("vase-large" vs "vase") — the
    // source is NOT actually linked to the "vase" target and should match.
    const html = '<p>See our <a href="/products/vase-large">Big Vase</a>. Also check out our Vase collection.</p>';
    const matches = matchSourceAgainstTargets(html, [t]);
    expect(matches).toHaveLength(1);
    expect(matches[0].toResourceId).toBe("gid-P1");
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

  it("does not hoist/drop a leading <style> block into a discarded <head> (regression: document-mode cheerio.load + $('body').html())", () => {
    const html = `<style>.x{color:red}</style><p>Our ceramic vase is handmade.</p>`;
    const result = insertLinkIntoHtml(html, "ceramic vase", "/products/ceramic-vase");
    expect(result.inserted).toBe(true);
    expect(result.html).toContain("<style>.x{color:red}</style>");
    expect(result.html).toContain('<a href="/products/ceramic-vase">ceramic vase</a>');
  });

  it("does not drop a leading <meta> tag either", () => {
    const html = `<meta charset="utf-8"><p>Our ceramic vase is handmade.</p>`;
    const result = insertLinkIntoHtml(html, "ceramic vase", "/products/ceramic-vase");
    expect(result.inserted).toBe(true);
    expect(result.html).toContain('<meta charset="utf-8">');
    expect(result.html).toContain('<a href="/products/ceramic-vase">ceramic vase</a>');
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
    anchorText?: string;
  }>;
  /** Rows that exist in the "DB" but are NOT returned by the bulk
   *  `findMany` — simulates a row beyond the unbounded 5000-row
   *  `existingRows` window (§ fix 8: `internal-links.service.ts:~485-497`).
   *  `create` throws P2002 against these; `findUnique` can still see them. */
  hiddenSuggestions?: Array<{
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
  const hidden = [...(opts.hiddenSuggestions ?? [])];
  let idCounter = 0;

  const sameKey = (a: any, b: any) =>
    a.fromResourceType === b.fromResourceType &&
    a.fromResourceId === b.fromResourceId &&
    a.toResourceType === b.toResourceType &&
    a.toResourceId === b.toResourceId &&
    a.locale === b.locale;

  return {
    _suggestions: suggestions,
    _hidden: hidden,
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
        const conflict = hidden.find((h) => sameKey(h, data)) ?? suggestions.find((s) => sameKey(s, data));
        if (conflict) {
          const err: any = new Error("Unique constraint failed on the fields: (shop,fromResourceType,fromResourceId,toResourceType,toResourceId,locale)");
          err.code = "P2002";
          throw err;
        }
        const row = { id: `new-${idCounter++}`, ...data };
        suggestions.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => {
        const key = where.shop_fromResourceType_fromResourceId_toResourceType_toResourceId_locale;
        return hidden.find((h) => sameKey(h, key)) ?? suggestions.find((s) => sameKey(s, key)) ?? null;
      },
      update: async ({ where, data }: any) => {
        const key = where.shop_fromResourceType_fromResourceId_toResourceType_toResourceId_locale;
        let row = suggestions.find((s) => sameKey(s, key));
        if (!row) {
          // Mirrors a real DB row: updating a previously-"hidden" row
          // promotes it into the visible set.
          const hiddenIdx = hidden.findIndex((h) => sameKey(h, key));
          if (hiddenIdx >= 0) {
            row = hidden[hiddenIdx];
            hidden.splice(hiddenIdx, 1);
            suggestions.push(row);
          }
        }
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

  it("falls back to an update instead of crashing when create hits a unique-constraint violation for a row beyond the 5000-row load window (§ fix 8)", async () => {
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      articles: [{ id: "gid-A1", body: "<p>We love our Green Ceramic Vase in the studio.</p>" }],
      // Not returned by the bulk findMany (simulating >5000 rows), but a
      // real row in the "DB" — create() must P2002 against it.
      hiddenSuggestions: [
        {
          id: "hidden-1",
          fromResourceType: "Article",
          fromResourceId: "gid-A1",
          toResourceType: "Product",
          toResourceId: "gid-P1",
          locale: "",
          status: "pending",
          dismissedUntil: null,
        },
      ],
    });
    const summary = await runInternalLinkSuggestions(SHOP, { db });
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(1);
    expect(db._suggestions).toHaveLength(1);
    expect(db._suggestions[0].status).toBe("pending");
  });

  it("still respects the dismissed-future guard for a hidden row discovered via the P2002 fallback (§ fix 8)", async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      articles: [{ id: "gid-A1", body: "<p>We love our Green Ceramic Vase in the studio.</p>" }],
      hiddenSuggestions: [
        {
          id: "hidden-1",
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
    // The hidden row must not have been resurrected/promoted to "pending".
    expect(db._suggestions).toHaveLength(0);
    expect(db._hidden[0].status).toBe("dismissed");
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

// ── Synonym batching + rejection feedback ───────────────────────────────────

describe("rejectedAnchorsByTarget", () => {
  const NOW = new Date("2026-07-01T00:00:00Z");

  it("collects permanently-rejected anchors per target, case-insensitively de-duped", () => {
    const map = rejectedAnchorsByTarget(
      [
        { toResourceType: "Product", toResourceId: "P1", anchorText: "Vasi", status: "dismissed", dismissedUntil: null },
        { toResourceType: "Product", toResourceId: "P1", anchorText: "vasi", status: "dismissed", dismissedUntil: null },
        { toResourceType: "Product", toResourceId: "P1", anchorText: "Blumenvase", status: "dismissed", dismissedUntil: null },
        { toResourceType: "Collection", toResourceId: "C1", anchorText: "Töpfe", status: "dismissed", dismissedUntil: null },
      ],
      NOW,
    );
    expect(map.get("Product:P1")).toEqual(["Vasi", "Blumenvase"]);
    expect(map.get("Collection:C1")).toEqual(["Töpfe"]);
  });

  it("ignores pending/accepted rows and lapsed dismissals (a lapsed row is revived, so it must not suppress anything)", () => {
    const map = rejectedAnchorsByTarget(
      [
        { toResourceType: "Product", toResourceId: "P1", anchorText: "pending", status: "pending", dismissedUntil: null },
        { toResourceType: "Product", toResourceId: "P1", anchorText: "accepted", status: "accepted", dismissedUntil: null },
        { toResourceType: "Product", toResourceId: "P1", anchorText: "lapsed", status: "dismissed", dismissedUntil: new Date("2026-06-01T00:00:00Z") },
        { toResourceType: "Product", toResourceId: "P1", anchorText: "future", status: "dismissed", dismissedUntil: new Date("2026-08-01T00:00:00Z") },
      ],
      NOW,
    );
    expect(map.get("Product:P1")).toEqual(["future"]);
  });
});

describe("groupSuggestionsBySource (bulk accept ordering)", () => {
  const row = (id: string, fromResourceType: string, fromResourceId: string) => ({
    id,
    fromResourceType,
    fromResourceId,
  });

  it("puts suggestions that share a source item into one group, in list order", () => {
    // Two links into the same product must be applied sequentially — the second
    // insertion runs against the HTML the first one saved.
    const groups = groupSuggestionsBySource([
      row("a", "Product", "P1"),
      row("b", "Article", "A1"),
      row("c", "Product", "P1"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].map((r) => r.id)).toEqual(["a", "c"]);
    expect(groups[1].map((r) => r.id)).toEqual(["b"]);
  });

  it("keeps same-id items of different types apart and preserves group order", () => {
    const groups = groupSuggestionsBySource([
      row("a", "Product", "X"),
      row("b", "Collection", "X"),
      row("c", "Page", "X"),
    ]);

    expect(groups.map((g) => g.map((r) => r.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("returns no groups for an empty batch", () => {
    expect(groupSuggestionsBySource([])).toEqual([]);
  });
});

describe("runInternalLinkSuggestions — synonym stage (batched)", () => {
  it(`sends one request per ${SYNONYM_BATCH_SIZE} targets instead of one per target`, async () => {
    const products = Array.from({ length: SYNONYM_BATCH_SIZE + 3 }, (_i, i) => ({
      id: `gid-P${i}`,
      handle: `handle-${i}`,
      title: `Product Title ${i}`,
    }));
    const db = makeDb({ products, articles: [{ id: "gid-A1", body: "<p>Nothing matches here.</p>" }] });

    const calls: string[][] = [];
    const summary = await runInternalLinkSuggestions(SHOP, {
      db,
      synonymProvider: async (terms) => {
        calls.push(terms);
        return terms.map(() => []);
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(SYNONYM_BATCH_SIZE);
    expect(calls[1]).toHaveLength(3);
    // Positional contract: term i of a chunk is that chunk's target i.
    expect(calls[0][0]).toBe("Product Title 0");
    expect(calls[1][2]).toBe(`Product Title ${SYNONYM_BATCH_SIZE + 2}`);
    expect(summary.synonymRequests).toBe(2);
  });

  it("passes the target's rejected anchors along and drops them if the model returns them anyway", async () => {
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      // Rejected for THIS target (from a different source) — must not be
      // proposed again as a synonym anchor.
      existingSuggestions: [
        {
          id: "s1",
          fromResourceType: "Page",
          fromResourceId: "gid-X",
          toResourceType: "Product",
          toResourceId: "gid-P1",
          locale: "",
          status: "dismissed",
          dismissedUntil: null,
          anchorText: "Vasi",
        },
      ],
      articles: [{ id: "gid-A1", body: "<p>Unsere Vasi stehen im Regal.</p>" }],
    });

    const avoidSeen: string[][][] = [];
    const summary = await runInternalLinkSuggestions(SHOP, {
      db,
      synonymProvider: async (terms, _locale, avoid) => {
        avoidSeen.push(avoid);
        return terms.map(() => ["Vasi"]); // model ignores the instruction
      },
    });

    expect(avoidSeen[0]).toEqual([["Vasi"]]);
    // The only mention in the source is the rejected wording → no suggestion.
    expect(summary.created).toBe(0);
    expect(summary.targetsWithSynonyms).toBe(0);
  });

  it("still uses the synonyms that were not rejected", async () => {
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      existingSuggestions: [
        {
          id: "s1",
          fromResourceType: "Page",
          fromResourceId: "gid-X",
          toResourceType: "Product",
          toResourceId: "gid-P1",
          locale: "",
          status: "dismissed",
          dismissedUntil: null,
          anchorText: "Vasi",
        },
      ],
      articles: [{ id: "gid-A1", body: "<p>Diese Blumenvase ist handgemacht.</p>" }],
    });

    const summary = await runInternalLinkSuggestions(SHOP, {
      db,
      synonymProvider: async (terms) => terms.map(() => ["Vasi", "Blumenvase"]),
    });

    expect(summary.targetsWithSynonyms).toBe(1);
    expect(summary.created).toBe(1);
    expect(db._suggestions.find((s: any) => s.fromResourceId === "gid-A1")?.anchorText).toBe("Blumenvase");
  });

  it("survives a throwing synonym batch and a mis-aligned response (matching continues on title/keyword anchors)", async () => {
    const makeShop = () =>
      makeDb({
        products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
        articles: [{ id: "gid-A1", body: "<p>The Green Ceramic Vase is lovely.</p>" }],
      });

    const thrown = await runInternalLinkSuggestions(SHOP, {
      db: makeShop(),
      synonymProvider: async () => {
        throw new Error("provider down");
      },
    });
    expect(thrown.created).toBe(1); // title anchor still matched
    expect(thrown.targetsWithSynonyms).toBe(0);

    const misaligned = await runInternalLinkSuggestions(SHOP, {
      db: makeShop(),
      synonymProvider: async () => [["a"], ["b"]], // 2 lists for 1 term
    });
    expect(misaligned.created).toBe(1);
    expect(misaligned.targetsWithSynonyms).toBe(0);
  });

  it("makes no AI request at all when no synonym provider is wired (no AI key)", async () => {
    const db = makeDb({
      products: [{ id: "gid-P1", handle: "green-vase", title: "Green Ceramic Vase" }],
      articles: [{ id: "gid-A1", body: "<p>The Green Ceramic Vase is lovely.</p>" }],
    });
    const summary = await runInternalLinkSuggestions(SHOP, { db });
    expect(summary.synonymRequests).toBe(0);
    expect(summary.created).toBe(1);
  });
});
