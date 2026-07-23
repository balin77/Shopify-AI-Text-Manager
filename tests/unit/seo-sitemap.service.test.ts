import { describe, it, expect } from "vitest";
import {
  findThinContentPages,
  findArchivedProducts,
  findEmptyCollections,
  computeExclusionSuggestions,
  upsertExclusionSuggestions,
  fetchSitemapInfo,
  crossmatchBrokenSitemapLinks,
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

// ── Sitemap XML parsing (injectable fetch, no msw needed) ──────────────────

function fakeFetch(responses: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (url: string) => {
    const r = responses[url];
    if (!r) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body } as unknown as Response;
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

  it("treats an empty response body as a fetch failure (ok:false)", async () => {
    const fetchImpl = fakeFetch({ "https://shop.example.com/sitemap.xml": { status: 200, body: "" } });
    const result = await fetchSitemapInfo(fetchImpl, "shop.example.com");
    expect(result.ok).toBe(false);
    expect(result.entryCount).toBe(0);
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
