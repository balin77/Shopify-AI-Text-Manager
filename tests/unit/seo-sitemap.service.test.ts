import { describe, it, expect } from "vitest";
import {
  findThinContentPages,
  findArchivedProducts,
  findEmptyCollections,
  computeExclusionSuggestions,
  upsertExclusionSuggestions,
  fetchSitemapInfo,
  crossmatchBrokenSitemapLinks,
  isLikelyPolicyPage,
  searchExclusionCandidates,
  ensureManualExclusion,
  applyExclusion,
  revertExclusion,
  THIN_CONTENT_MIN_WORDS,
  EMPTY_COLLECTION_MAX_WORDCOUNT,
  SEO_HIDDEN_NAMESPACE,
  SEO_HIDDEN_KEY,
  SEO_HIDDEN_METAFIELD_TYPE,
  type ThinPageRow,
  type ArchivedProductRow,
  type CollectionRow,
} from "~/services/seo/sitemap.service";

/**
 * Phase 4 (PLAN_SEO_SUITE_COMPLETION.md §6, §9): exclusion-suggestion rules
 * (pure), sitemap XML parsing (index + sub-sitemaps, injectable fetch),
 * broken-links crossmatch (pure), and the echo-verified apply/revert flow
 * against a mocked Shopify admin client (same mock-gateway style as
 * bulk-editor.apply.test.ts).
 */

// ── Exclusion-suggestion rules ──────────────────────────────────────────────

describe("findThinContentPages", () => {
  function page(overrides: Partial<ThinPageRow> = {}): ThinPageRow {
    return { id: "gid-page-1", title: "Page", handle: "page", body: "", ...overrides };
  }

  it("flags a page with fewer words than the threshold", () => {
    const body = "<p>" + Array(10).fill("word").join(" ") + "</p>";
    const result = findThinContentPages([page({ body })]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ resourceType: "page", resourceId: "gid-page-1", reason: "thinContent" });
  });

  it("does not flag a page at/above the threshold", () => {
    const body = "<p>" + Array(THIN_CONTENT_MIN_WORDS).fill("word").join(" ") + "</p>";
    expect(findThinContentPages([page({ body })])).toEqual([]);
  });

  it("flags a page one word below the threshold (boundary)", () => {
    const body = "<p>" + Array(THIN_CONTENT_MIN_WORDS - 1).fill("word").join(" ") + "</p>";
    expect(findThinContentPages([page({ body })])).toHaveLength(1);
  });

  it("treats null/empty body as zero words (flagged)", () => {
    expect(findThinContentPages([page({ body: null })])).toHaveLength(1);
    expect(findThinContentPages([page({ body: "" })])).toHaveLength(1);
  });

  it("strips HTML tags before counting words (tags don't inflate the count)", () => {
    // 5 real words, heavily tagged — must NOT count as >= THIN_CONTENT_MIN_WORDS.
    const body = "<div><p>one</p><p>two</p><p>three</p><p>four</p><p>five</p></div>";
    expect(findThinContentPages([page({ body })])).toHaveLength(1);
  });
});

describe("findArchivedProducts", () => {
  function product(overrides: Partial<ArchivedProductRow> = {}): ArchivedProductRow {
    return { id: "gid-p1", title: "Product", handle: "product", status: "ARCHIVED", ...overrides };
  }

  it("flags an archived product", () => {
    const result = findArchivedProducts([product()]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ resourceType: "product", reason: "archivedProduct" });
  });

  it("does not flag an active product", () => {
    expect(findArchivedProducts([product({ status: "ACTIVE" })])).toEqual([]);
  });

  it("does not flag a draft product", () => {
    expect(findArchivedProducts([product({ status: "DRAFT" })])).toEqual([]);
  });

  it("re-filters even if the caller passed an unfiltered list", () => {
    const result = findArchivedProducts([
      product({ id: "a", status: "ACTIVE" }),
      product({ id: "b", status: "ARCHIVED" }),
    ]);
    expect(result.map((r) => r.resourceId)).toEqual(["b"]);
  });
});

describe("findEmptyCollections", () => {
  function collection(overrides: Partial<CollectionRow> = {}): CollectionRow {
    return { id: "gid-c1", title: "Collection", handle: "collection", ...overrides };
  }

  it("flags a collection whose crawled page has a near-zero word count", () => {
    const map = new Map([["gid-c1", 5]]);
    const result = findEmptyCollections([collection()], map);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ resourceType: "collection", reason: "emptyCollection" });
  });

  it("does not flag a collection above the threshold", () => {
    const map = new Map([["gid-c1", EMPTY_COLLECTION_MAX_WORDCOUNT + 1]]);
    expect(findEmptyCollections([collection()], map)).toEqual([]);
  });

  it("flags a collection exactly at the threshold (inclusive boundary)", () => {
    const map = new Map([["gid-c1", EMPTY_COLLECTION_MAX_WORDCOUNT]]);
    expect(findEmptyCollections([collection()], map)).toHaveLength(1);
  });

  it("does not flag a collection with no crawl data at all", () => {
    expect(findEmptyCollections([collection()], new Map())).toEqual([]);
  });
});

// ── computeExclusionSuggestions / upsertExclusionSuggestions (DB-stub) ──────

function makeSuggestionDb(opts: {
  pages?: ThinPageRow[];
  archivedProducts?: ArchivedProductRow[];
  collections?: CollectionRow[];
  latestSnapshotId?: string | null;
  collectionCrawlPages?: { resourceId: string; wordCount: number }[];
  existingExclusions?: { resourceType: string; resourceId: string }[];
}) {
  const created: any[] = [];
  const db = {
    page: { findMany: async () => opts.pages ?? [] },
    product: { findMany: async () => opts.archivedProducts ?? [] },
    collection: { findMany: async () => opts.collections ?? [] },
    seoCrawlSnapshot: { findFirst: async () => (opts.latestSnapshotId ? { id: opts.latestSnapshotId } : null) },
    seoCrawlPage: {
      findMany: async () => opts.collectionCrawlPages?.map((p) => ({ resourceId: p.resourceId, wordCount: p.wordCount })) ?? [],
    },
    seoSitemapExclusion: {
      findMany: async () => opts.existingExclusions ?? [],
      create: async ({ data }: any) => {
        created.push(data);
        return data;
      },
    },
  } as any;
  return { db, created };
}

describe("isLikelyPolicyPage", () => {
  it("flags legal/service pages by handle in de/en/es", () => {
    expect(isLikelyPolicyPage("page", "impressum", "Impressum")).toBe(true);
    expect(isLikelyPolicyPage("page", "datenschutzerklaerung", "Datenschutz")).toBe(true);
    expect(isLikelyPolicyPage("page", "privacy-policy", "Privacy Policy")).toBe(true);
    expect(isLikelyPolicyPage("page", "aviso-legal", "Aviso legal")).toBe(true);
  });

  it("matches on the title when the handle is opaque", () => {
    expect(isLikelyPolicyPage("page", "p-4711", "Widerrufsbelehrung")).toBe(true);
  });

  it("does not flag ordinary pages", () => {
    expect(isLikelyPolicyPage("page", "sommer-lookbook", "Sommer Lookbook")).toBe(false);
    expect(isLikelyPolicyPage("page", "team", "Unser Team")).toBe(false);
  });

  it("only applies to pages — a short product or collection carries no such expectation", () => {
    expect(isLikelyPolicyPage("product", "shipping-box", "Shipping Box")).toBe(false);
    expect(isLikelyPolicyPage("collection", "returns", "Returns")).toBe(false);
  });
});

describe("computeExclusionSuggestions", () => {
  it("yields no emptyCollection candidates without a crawl snapshot", async () => {
    const { db } = makeSuggestionDb({
      collections: [{ id: "gid-c1", title: "C", handle: "c" }],
      latestSnapshotId: null,
    });
    const result = await computeExclusionSuggestions("shop.myshopify.com", { db });
    expect(result.filter((r) => r.reason === "emptyCollection")).toEqual([]);
  });

  it("combines all three rule sets", async () => {
    const { db } = makeSuggestionDb({
      pages: [{ id: "gid-p1", title: "Thin", handle: "thin", body: "short" }],
      archivedProducts: [{ id: "gid-prod1", title: "Old", handle: "old", status: "ARCHIVED" }],
      collections: [{ id: "gid-c1", title: "Empty", handle: "empty" }],
      latestSnapshotId: "snap-1",
      collectionCrawlPages: [{ resourceId: "gid-c1", wordCount: 3 }],
    });
    const result = await computeExclusionSuggestions("shop.myshopify.com", { db });
    expect(result.map((r) => r.reason).sort()).toEqual(["archivedProduct", "emptyCollection", "thinContent"]);
  });
});

describe("upsertExclusionSuggestions", () => {
  it("creates rows for new candidates", async () => {
    const { db, created } = makeSuggestionDb({ existingExclusions: [] });
    const summary = await upsertExclusionSuggestions(db, "shop.myshopify.com", [
      { resourceType: "page", resourceId: "gid-p1", reason: "thinContent", title: "T", handle: "t" },
    ]);
    expect(summary).toEqual({ created: 1, skipped: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ resourceType: "page", resourceId: "gid-p1", status: "suggested" });
  });

  it("is idempotent — a candidate that already has ANY row (suggested/applied/reverted) is skipped, never re-created", async () => {
    const { db, created } = makeSuggestionDb({
      existingExclusions: [{ resourceType: "product", resourceId: "gid-prod1" }],
    });
    const summary = await upsertExclusionSuggestions(db, "shop.myshopify.com", [
      { resourceType: "product", resourceId: "gid-prod1", reason: "archivedProduct", title: "P", handle: "p" },
    ]);
    expect(summary).toEqual({ created: 0, skipped: 1 });
    expect(created).toEqual([]);
  });

  it("does not double-create when the same candidate appears twice in one sweep", async () => {
    const { db, created } = makeSuggestionDb({ existingExclusions: [] });
    const candidate = { resourceType: "page" as const, resourceId: "gid-p1", reason: "thinContent" as const, title: "T", handle: "t" };
    const summary = await upsertExclusionSuggestions(db, "shop.myshopify.com", [candidate, candidate]);
    expect(summary).toEqual({ created: 1, skipped: 1 });
    expect(created).toHaveLength(1);
  });

  it("no-ops on an empty candidate list", async () => {
    const { db, created } = makeSuggestionDb({});
    const summary = await upsertExclusionSuggestions(db, "shop.myshopify.com", []);
    expect(summary).toEqual({ created: 0, skipped: 0 });
    expect(created).toEqual([]);
  });
});

// ── Manual exclusion (picker search + row creation) ────────────────────────

function makeManualDb(opts: {
  products?: { id: string; title: string; handle: string }[];
  articles?: { id: string; title: string; handle: string }[];
  exclusions?: { resourceType: string; resourceId: string; status: string }[];
}) {
  const created: any[] = [];
  const db: any = {
    product: {
      findMany: async () => opts.products ?? [],
      findFirst: async ({ where }: any) => (opts.products ?? []).find((p) => p.id === where.id) ?? null,
    },
    article: {
      findMany: async () => opts.articles ?? [],
      findFirst: async ({ where }: any) => (opts.articles ?? []).find((a) => a.id === where.id) ?? null,
    },
    collection: { findMany: async () => [], findFirst: async () => null },
    page: { findMany: async () => [], findFirst: async () => null },
    seoSitemapExclusion: {
      findMany: async () => opts.exclusions ?? [],
      findFirst: async ({ where }: any) =>
        (opts.exclusions ?? []).find(
          (e) => e.resourceType === where.resourceType && e.resourceId === where.resourceId,
        ) ?? null,
      create: async ({ data }: any) => {
        created.push(data);
        return { id: "new-row", status: data.status };
      },
    },
  };
  return { db, created };
}

describe("searchExclusionCandidates", () => {
  it("marks hits that already have an exclusion row", async () => {
    const { db } = makeManualDb({
      products: [
        { id: "gid-1", title: "A", handle: "a" },
        { id: "gid-2", title: "B", handle: "b" },
      ],
      exclusions: [{ resourceType: "product", resourceId: "gid-2", status: "applied" }],
    });
    const hits = await searchExclusionCandidates(db, "shop.myshopify.com", "product", "");
    expect(hits.map((h) => h.existingStatus)).toEqual([null, "applied"]);
  });

  it("carries the policy-page caution flag so the client never imports the service", async () => {
    const { db } = makeManualDb({
      products: [{ id: "gid-1", title: "Widget", handle: "widget" }],
    });
    const hits = await searchExclusionCandidates(db, "shop.myshopify.com", "product", "");
    expect(hits[0].caution).toBe(false);
  });

  it("supports articles", async () => {
    const { db } = makeManualDb({ articles: [{ id: "gid-a1", title: "Post", handle: "post" }] });
    const hits = await searchExclusionCandidates(db, "shop.myshopify.com", "article", "post");
    expect(hits).toHaveLength(1);
    expect(hits[0].resourceType).toBe("article");
  });
});

describe("ensureManualExclusion", () => {
  it("creates a row with reason 'manual' for a cached resource", async () => {
    const { db, created } = makeManualDb({ products: [{ id: "gid-1", title: "A", handle: "a" }] });
    const row = await ensureManualExclusion(db, "shop.myshopify.com", "product", "gid-1");
    expect(row).toMatchObject({ id: "new-row" });
    expect(created[0]).toMatchObject({ resourceType: "product", resourceId: "gid-1", reason: "manual" });
  });

  it("reuses an existing row instead of violating the unique key — including a reverted one", async () => {
    const { db, created } = makeManualDb({
      products: [{ id: "gid-1", title: "A", handle: "a" }],
      exclusions: [{ resourceType: "product", resourceId: "gid-1", status: "reverted" }],
    });
    const row = await ensureManualExclusion(db, "shop.myshopify.com", "product", "gid-1");
    expect(row).toMatchObject({ status: "reverted" });
    expect(created).toEqual([]);
  });

  it("returns null for an id that isn't in this shop's cache — a forged POST never reaches Shopify", async () => {
    const { db, created } = makeManualDb({ products: [{ id: "gid-1", title: "A", handle: "a" }] });
    const row = await ensureManualExclusion(db, "shop.myshopify.com", "product", "gid-someone-elses");
    expect(row).toBeNull();
    expect(created).toEqual([]);
  });
});

// ── Sitemap XML parsing (injectable fetch, no msw needed) ──────────────────

function fakeFetch(
  responses: Record<string, { status: number; body: string; finalUrl?: string }>,
): typeof fetch {
  return (async (url: string) => {
    const r = responses[url];
    if (!r) return { ok: false, status: 404, url, text: async () => "" } as unknown as Response;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      // `Response.url` is the post-redirect URL — how the password gate is detected.
      url: r.finalUrl ?? url,
      text: async () => r.body,
    } as unknown as Response;
  }) as typeof fetch;
}

const URLSET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shop.example.com/products/a</loc></url>
  <url><loc>https://shop.example.com/products/b</loc></url>
</urlset>`;

describe("fetchSitemapInfo", () => {
  it("parses a plain urlset sitemap (no index)", async () => {
    const fetchImpl = fakeFetch({ "https://shop.example.com/sitemap.xml": { status: 200, body: URLSET_XML } });
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(2);
    expect(result.urls).toEqual(["https://shop.example.com/products/a", "https://shop.example.com/products/b"]);
  });

  it("follows a sitemap index into its sub-sitemaps and sums entries", async () => {
    const indexXml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://shop.example.com/sitemap_products_1.xml</loc></sitemap>
  <sitemap><loc>https://shop.example.com/sitemap_collections_1.xml</loc></sitemap>
</sitemapindex>`;
    const productsXml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shop.example.com/products/a</loc></url>
  <url><loc>https://shop.example.com/products/b</loc></url>
  <url><loc>https://shop.example.com/products/c</loc></url>
</urlset>`;
    const collectionsXml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://shop.example.com/collections/x</loc></url>
</urlset>`;
    const fetchImpl = fakeFetch({
      "https://shop.example.com/sitemap.xml": { status: 200, body: indexXml },
      "https://shop.example.com/sitemap_products_1.xml": { status: 200, body: productsXml },
      "https://shop.example.com/sitemap_collections_1.xml": { status: 200, body: collectionsXml },
    });
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(4);
    expect(result.urls).toHaveLength(4);
  });

  it("counts entries even when one sub-sitemap fetch fails (best-effort)", async () => {
    const indexXml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://shop.example.com/sitemap_a.xml</loc></sitemap>
  <sitemap><loc>https://shop.example.com/sitemap_b.xml</loc></sitemap>
</sitemapindex>`;
    const okXml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://shop.example.com/products/a</loc></url></urlset>`;
    const fetchImpl = fakeFetch({
      "https://shop.example.com/sitemap.xml": { status: 200, body: indexXml },
      "https://shop.example.com/sitemap_a.xml": { status: 200, body: okXml },
      // sitemap_b.xml deliberately missing from the response map -> 404
    });
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(1);
  });

  it("returns ok:false when the root sitemap.xml fetch fails", async () => {
    const fetchImpl = fakeFetch({});
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.ok).toBe(false);
    expect(result.entryCount).toBe(0);
    expect(result.urls).toEqual([]);
  });

  it("reports no failureReason on success", async () => {
    const fetchImpl = fakeFetch({ "https://shop.example.com/sitemap.xml": { status: 200, body: URLSET_XML } });
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.failureReason).toBeUndefined();
  });

  it("classifies a password-gate redirect — even though it answers 200", async () => {
    const fetchImpl = fakeFetch({
      "https://shop.example.com/sitemap.xml": {
        status: 200,
        body: "<html><body>Opening soon</body></html>",
        finalUrl: "https://shop.example.com/password",
      },
    });
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("password");
  });

  it("classifies a non-2xx and keeps the status for the UI", async () => {
    const fetchImpl = fakeFetch({ "https://shop.example.com/sitemap.xml": { status: 503, body: "" } });
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.failureReason).toBe("http");
    expect(result.httpStatus).toBe(503);
  });

  it("classifies a connection failure as network", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.failureReason).toBe("network");
  });

  it("classifies a 200 HTML page as notSitemap instead of reporting 0 entries", async () => {
    const fetchImpl = fakeFetch({
      "https://shop.example.com/sitemap.xml": { status: 200, body: "<html><body><h1>404</h1></body></html>" },
    });
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.ok).toBe(false);
    expect(result.failureReason).toBe("notSitemap");
  });

  it("sends a User-Agent — a UA-less request is a plausible bot-protection trigger", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return { ok: true, status: 200, url: _url, text: async () => URLSET_XML } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect((seen[0].headers as Record<string, string>)["User-Agent"]).toContain("ContentPilotSEO");
  });

  it("treats an empty response body as a fetch failure (ok:false)", async () => {
    const fetchImpl = fakeFetch({ "https://shop.example.com/sitemap.xml": { status: 200, body: "" } });
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.ok).toBe(false);
    expect(result.entryCount).toBe(0);
  });

  it("fetches sub-sitemaps concurrently, not sequentially (§ fix 10)", async () => {
    const indexXml = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://shop.example.com/sitemap_a.xml</loc></sitemap>
  <sitemap><loc>https://shop.example.com/sitemap_b.xml</loc></sitemap>
  <sitemap><loc>https://shop.example.com/sitemap_c.xml</loc></sitemap>
</sitemapindex>`;
    const leafXml = (n: string) =>
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://shop.example.com/${n}</loc></url></urlset>`;
    const DELAY_MS = 60;
    const fetchImpl = (async (url: string) => {
      if (url === "https://shop.example.com/sitemap.xml") {
        return { ok: true, status: 200, text: async () => indexXml } as unknown as Response;
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
      const leaf = url.match(/sitemap_(\w)\.xml$/)?.[1] ?? "x";
      return { ok: true, status: 200, text: async () => leafXml(leaf) } as unknown as Response;
    }) as typeof fetch;

    const started = Date.now();
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(3);
    // Sequential would take ~3 * DELAY_MS (180ms+); concurrent should land
    // close to a single DELAY_MS. Generous margin to avoid CI flakiness.
    expect(elapsed).toBeLessThan(DELAY_MS * 2.5);
  });

  it("does not throw and reports zero entries for well-formed XML with neither <url> nor <sitemap>", async () => {
    const fetchImpl = fakeFetch({
      "https://shop.example.com/sitemap.xml": { status: 200, body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>` },
    });
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(0);
    expect(result.urls).toEqual([]);
  });
});

// ── Broken-links-in-sitemap crossmatch ──────────────────────────────────────

describe("crossmatchBrokenSitemapLinks", () => {
  it("returns sitemap URLs that are broken (>=400) in the crawl cache", () => {
    const result = crossmatchBrokenSitemapLinks(
      ["https://shop.example.com/products/a", "https://shop.example.com/products/b"],
      [
        { url: "https://shop.example.com/products/a", statusCode: 404 },
        { url: "https://shop.example.com/products/b", statusCode: 200 },
      ],
    );
    expect(result).toEqual([{ url: "https://shop.example.com/products/a", statusCode: 404 }]);
  });

  it("ignores sitemap URLs absent from the crawl cache", () => {
    const result = crossmatchBrokenSitemapLinks(["https://shop.example.com/products/uncrawled"], []);
    expect(result).toEqual([]);
  });

  it("does not flag a 3xx/2xx crawled URL", () => {
    const result = crossmatchBrokenSitemapLinks(
      ["https://shop.example.com/products/a"],
      [{ url: "https://shop.example.com/products/a", statusCode: 301 }],
    );
    expect(result).toEqual([]);
  });
});

// ── Apply / Revert — echo-verified metafield writes ─────────────────────────

function makeExclusionDb(row: { id: string; shop: string; resourceId: string; status: string }) {
  let current: any = { ...row };
  const updates: any[] = [];
  const db = {
    seoSitemapExclusion: {
      findFirst: async ({ where }: any) =>
        where.id === current.id && where.shop === current.shop ? { ...current } : null,
      update: async ({ data }: any) => {
        current = { ...current, ...data };
        updates.push(data);
        return current;
      },
    },
  } as any;
  return { db, updates, getCurrent: () => current };
}

function mockAdmin(respond: (query: string, variables: any) => unknown) {
  const calls: { query: string; variables: any }[] = [];
  return {
    admin: {
      graphql: async (query: string, opts?: { variables?: any }) => {
        calls.push({ query, variables: opts?.variables });
        return { json: async () => respond(query, opts?.variables) } as unknown as Response;
      },
    } as any,
    calls,
  };
}

describe("applyExclusion", () => {
  it("flips status to 'applied' only when Shopify echoes the metafield back", async () => {
    const { db, getCurrent } = makeExclusionDb({ id: "exc-1", shop: "shop.myshopify.com", resourceId: "gid://shopify/Product/1", status: "suggested" });
    const { admin, calls } = mockAdmin((query, variables) => {
      expect(query).toContain("metafieldsSet(");
      const input = variables.metafields[0];
      expect(input).toMatchObject({
        ownerId: "gid://shopify/Product/1",
        namespace: SEO_HIDDEN_NAMESPACE,
        key: SEO_HIDDEN_KEY,
        type: SEO_HIDDEN_METAFIELD_TYPE,
        value: "1",
      });
      return {
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/1", namespace: SEO_HIDDEN_NAMESPACE, key: SEO_HIDDEN_KEY, value: "1", type: SEO_HIDDEN_METAFIELD_TYPE }],
            userErrors: [],
          },
        },
      };
    });

    const result = await applyExclusion(admin, db, "shop.myshopify.com", "exc-1");
    expect(result.ok).toBe(true);
    expect(getCurrent().status).toBe("applied");
    expect(getCurrent().appliedAt).toBeInstanceOf(Date);
    expect(calls).toHaveLength(1);
  });

  it("does NOT flip status when Shopify returns userErrors (status stays 'suggested')", async () => {
    const { db, getCurrent } = makeExclusionDb({ id: "exc-1", shop: "shop.myshopify.com", resourceId: "gid://shopify/Product/1", status: "suggested" });
    const { admin } = mockAdmin(() => ({
      data: { metafieldsSet: { metafields: [], userErrors: [{ field: ["metafields", "0"], message: "Access denied" }] } },
    }));

    const result = await applyExclusion(admin, db, "shop.myshopify.com", "exc-1");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Access denied");
    expect(getCurrent().status).toBe("suggested");
  });

  it("does NOT flip status when userErrors is empty but no echo is present (degrades safely)", async () => {
    const { db, getCurrent } = makeExclusionDb({ id: "exc-1", shop: "shop.myshopify.com", resourceId: "gid://shopify/Product/1", status: "suggested" });
    const { admin } = mockAdmin(() => ({
      data: { metafieldsSet: { metafields: [], userErrors: [] } },
    }));

    const result = await applyExclusion(admin, db, "shop.myshopify.com", "exc-1");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_confirmed");
    expect(getCurrent().status).toBe("suggested");
  });

  it("is idempotent — calling apply on an already-applied row is a no-op success without a Shopify call", async () => {
    const { db, getCurrent } = makeExclusionDb({ id: "exc-1", shop: "shop.myshopify.com", resourceId: "gid://shopify/Product/1", status: "applied" });
    const { admin, calls } = mockAdmin(() => {
      throw new Error("should not be called");
    });

    const result = await applyExclusion(admin, db, "shop.myshopify.com", "exc-1");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(getCurrent().status).toBe("applied");
  });

  it("returns not_found for an unknown/foreign-shop exclusion id", async () => {
    const { db } = makeExclusionDb({ id: "exc-1", shop: "shop.myshopify.com", resourceId: "gid://shopify/Product/1", status: "suggested" });
    const { admin } = mockAdmin(() => ({ data: {} }));
    const result = await applyExclusion(admin, db, "other-shop.myshopify.com", "exc-1");
    expect(result).toEqual({ ok: false, error: "not_found" });
  });
});

describe("revertExclusion", () => {
  it("flips status to 'reverted' only when Shopify echoes deletedMetafields back", async () => {
    const { db, getCurrent } = makeExclusionDb({ id: "exc-1", shop: "shop.myshopify.com", resourceId: "gid://shopify/Product/1", status: "applied" });
    const { admin } = mockAdmin((query, variables) => {
      expect(query).toContain("metafieldsDelete(");
      expect(variables.metafields[0]).toEqual({
        ownerId: "gid://shopify/Product/1",
        namespace: SEO_HIDDEN_NAMESPACE,
        key: SEO_HIDDEN_KEY,
      });
      return {
        data: {
          metafieldsDelete: {
            deletedMetafields: [{ ownerId: "gid://shopify/Product/1", namespace: SEO_HIDDEN_NAMESPACE, key: SEO_HIDDEN_KEY }],
            userErrors: [],
          },
        },
      };
    });

    const result = await revertExclusion(admin, db, "shop.myshopify.com", "exc-1");
    expect(result.ok).toBe(true);
    expect(getCurrent().status).toBe("reverted");
    expect(getCurrent().appliedAt).toBeNull();
  });

  it("does NOT flip status when deletedMetafields is empty (no echo)", async () => {
    const { db, getCurrent } = makeExclusionDb({ id: "exc-1", shop: "shop.myshopify.com", resourceId: "gid://shopify/Product/1", status: "applied" });
    const { admin } = mockAdmin(() => ({
      data: { metafieldsDelete: { deletedMetafields: [], userErrors: [] } },
    }));

    const result = await revertExclusion(admin, db, "shop.myshopify.com", "exc-1");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_confirmed");
    expect(getCurrent().status).toBe("applied");
  });

  it("does NOT flip status when Shopify returns userErrors", async () => {
    const { db, getCurrent } = makeExclusionDb({ id: "exc-1", shop: "shop.myshopify.com", resourceId: "gid://shopify/Product/1", status: "applied" });
    const { admin } = mockAdmin(() => ({
      data: { metafieldsDelete: { deletedMetafields: [], userErrors: [{ message: "boom" }] } },
    }));

    const result = await revertExclusion(admin, db, "shop.myshopify.com", "exc-1");
    expect(result.ok).toBe(false);
    expect(getCurrent().status).toBe("applied");
  });

  it("refuses to revert a row that isn't currently applied", async () => {
    const { db } = makeExclusionDb({ id: "exc-1", shop: "shop.myshopify.com", resourceId: "gid://shopify/Product/1", status: "suggested" });
    const { admin, calls } = mockAdmin(() => ({ data: {} }));
    const result = await revertExclusion(admin, db, "shop.myshopify.com", "exc-1");
    expect(result).toEqual({ ok: false, error: "not_applied" });
    expect(calls).toHaveLength(0);
  });
});
