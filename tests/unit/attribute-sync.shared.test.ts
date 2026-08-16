/**
 * PLAN_CONTENT_CREATION Phase 0 — sync mapping of the merchandising attributes.
 *
 * The load-bearing property under test is NOT "the fields are copied across".
 * It is the one the plan calls out as its own risk row: a column of this block
 * is only meaningful when `attributesSyncedAt` is set, and a response that did
 * not CARRY the block must leave the stored values alone. Writing the migration
 * defaults over a value an earlier sync established — or stamping
 * `attributesSyncedAt` for data that never arrived — turns "unknown" into a
 * confident, wrong "missing" in the attribute sidebar.
 */

import { describe, it, expect } from "vitest";
import {
  productAttributeColumns,
  productCollectionRows,
  collectionAttributeColumns,
  articleAttributeColumns,
  pageAttributeColumns,
  attributesKnown,
  hasProductAttributes,
} from "~/services/attribute-sync.shared";

const NOW = new Date("2026-08-16T12:00:00.000Z");

describe("productAttributeColumns", () => {
  it("returns {} when the response did not carry the attribute block", () => {
    // An older query path: the keys are ABSENT, not empty. Writing anything
    // here would erase vendor/tags a full sync had already established.
    expect(productAttributeColumns({}, NOW)).toEqual({});
    expect(productAttributeColumns(null, NOW)).toEqual({});
    expect(productAttributeColumns(undefined, NOW)).toEqual({});
  });

  it("does NOT stamp attributesSyncedAt for a response without the block", () => {
    expect(productAttributeColumns({}, NOW).attributesSyncedAt).toBeUndefined();
  });

  it("maps a delivered block and stamps attributesSyncedAt", () => {
    const columns = productAttributeColumns(
      {
        vendor: "Acme",
        tags: ["sale", "new"],
        templateSuffix: "wide",
        publishedAt: "2026-01-02T03:04:05Z",
        category: { id: "gid://shopify/TaxonomyCategory/aa-1", fullName: "Apparel > Shirts", name: "Shirts" },
      },
      NOW,
    );

    expect(columns).toEqual({
      vendor: "Acme",
      tags: ["sale", "new"],
      categoryId: "gid://shopify/TaxonomyCategory/aa-1",
      categoryName: "Apparel > Shirts",
      templateSuffix: "wide",
      publishedAt: new Date("2026-01-02T03:04:05Z"),
      attributesSyncedAt: NOW,
    });
  });

  it("treats an empty vendor as null, not as the string \"\"", () => {
    // Shopify returns "" for an unset vendor; a "" in the cache would render
    // as a set-but-blank value in the sidebar.
    const columns = productAttributeColumns({ vendor: "   ", tags: [] }, NOW);
    expect(columns.vendor).toBeNull();
  });

  it("drops blank tags and trims the rest", () => {
    const columns = productAttributeColumns({ vendor: "x", tags: [" sale ", "", "  "] }, NOW);
    expect(columns.tags).toEqual(["sale"]);
  });

  it("still recognises the block when only tags came back", () => {
    expect(hasProductAttributes({ tags: [] })).toBe(true);
    expect(hasProductAttributes({})).toBe(false);
  });

  it("falls back to the category leaf name when fullName is absent", () => {
    const columns = productAttributeColumns(
      { vendor: "x", tags: [], category: { id: "gid://x/1", name: "Shirts" } },
      NOW,
    );
    expect(columns.categoryName).toBe("Shirts");
  });

  it("maps an unparsable publishedAt to null instead of an Invalid Date", () => {
    const columns = productAttributeColumns({ vendor: "x", tags: [], publishedAt: "not-a-date" }, NOW);
    expect(columns.publishedAt).toBeNull();
  });

  it("maps a never-published product to publishedAt null", () => {
    const columns = productAttributeColumns({ vendor: "x", tags: [], publishedAt: null }, NOW);
    expect(columns.publishedAt).toBeNull();
  });
});

describe("productCollectionRows", () => {
  const SHOP = "test.myshopify.com";
  const PRODUCT = "gid://shopify/Product/1";

  it("returns null when the membership block was not requested", () => {
    // null is the caller's signal to SKIP the delete-and-rebuild. Returning an
    // empty row list instead would wipe the memberships and report
    // "in 0 collections" for data this response never contained.
    expect(productCollectionRows(SHOP, PRODUCT, null)).toBeNull();
    expect(productCollectionRows(SHOP, PRODUCT, undefined)).toBeNull();
  });

  it("distinguishes 'not requested' from a genuinely empty membership", () => {
    const result = productCollectionRows(SHOP, PRODUCT, { nodes: [], pageInfo: { hasNextPage: false } });
    expect(result).not.toBeNull();
    expect(result!.rows).toEqual([]);
    expect(result!.hasMore).toBe(false);
  });

  it("marks rule-based memberships as automated", () => {
    const result = productCollectionRows(SHOP, PRODUCT, {
      pageInfo: { hasNextPage: false },
      nodes: [
        { id: "gid://shopify/Collection/1", title: "Manual", ruleSet: null },
        { id: "gid://shopify/Collection/2", title: "Smart", ruleSet: { appliedDisjunctively: true } },
      ],
    });
    expect(result!.rows).toEqual([
      { shop: SHOP, productId: PRODUCT, collectionId: "gid://shopify/Collection/1", collectionTitle: "Manual", automated: false },
      { shop: SHOP, productId: PRODUCT, collectionId: "gid://shopify/Collection/2", collectionTitle: "Smart", automated: true },
    ]);
  });

  it("de-duplicates repeated collection ids", () => {
    // The unique index would reject the second row and take the whole
    // createMany with it.
    const result = productCollectionRows(SHOP, PRODUCT, {
      nodes: [
        { id: "gid://shopify/Collection/1", title: "A" },
        { id: "gid://shopify/Collection/1", title: "A" },
      ],
    });
    expect(result!.rows).toHaveLength(1);
  });

  it("reports a truncated membership window", () => {
    const result = productCollectionRows(SHOP, PRODUCT, {
      pageInfo: { hasNextPage: true },
      nodes: [{ id: "gid://shopify/Collection/1", title: "A" }],
    });
    expect(result!.hasMore).toBe(true);
  });
});

describe("collectionAttributeColumns", () => {
  it("returns {} when the block was not delivered", () => {
    expect(collectionAttributeColumns({}, "2025-10", NOW)).toEqual({});
    expect(collectionAttributeColumns(null, "2025-10", NOW)).toEqual({});
  });

  it("stores the rule tree in a discriminated envelope, verbatim", () => {
    const ruleSet = {
      appliedDisjunctively: false,
      rules: [{ column: "TAG", relation: "EQUALS", condition: "sale" }],
    };
    const columns = collectionAttributeColumns(
      { sortOrder: "BEST_SELLING", templateSuffix: null, ruleSet },
      "2025-10",
      NOW,
    );

    expect(columns.isSmart).toBe(true);
    expect(columns.sortOrder).toBe("BEST_SELLING");
    expect(columns.templateSuffix).toBeNull();
    expect(columns.sourcesJson).toEqual({ shape: "ruleSet", apiVersion: "2025-10", data: ruleSet });
    expect(columns.attributesSyncedAt).toBe(NOW);
  });

  it("names the API version it read, so a 2026-07 'sources' row is never mistaken for a ruleSet row", () => {
    const columns = collectionAttributeColumns({ sortOrder: "MANUAL" }, "2026-07", NOW);
    expect(columns.sourcesJson).toMatchObject({ shape: "ruleSet", apiVersion: "2026-07" });
  });

  it("clears the tree when a collection stopped being rule-based", () => {
    // A stale tree left behind would keep the rule editor showing rules that
    // no longer govern the collection's membership.
    const columns = collectionAttributeColumns({ sortOrder: "MANUAL", ruleSet: null }, "2025-10", NOW);
    expect(columns.isSmart).toBe(false);
    expect(columns.sourcesJson).toEqual({ shape: "ruleSet", apiVersion: "2025-10", data: null });
  });
});

describe("articleAttributeColumns", () => {
  it("returns {} when the block was not delivered", () => {
    expect(articleAttributeColumns({}, NOW)).toEqual({});
  });

  it("flattens the author object to its name", () => {
    // ArticleCreateInput requires an author (PLAN §1.4) — this is the one
    // attribute whose absence blocks a feature outright, not just a display.
    const columns = articleAttributeColumns(
      { author: { name: "Jane Doe" }, tags: ["news"], isPublished: true, publishedAt: "2026-03-04T00:00:00Z" },
      NOW,
    );
    expect(columns.author).toBe("Jane Doe");
    expect(columns.tags).toEqual(["news"]);
    expect(columns.isPublished).toBe(true);
    expect(columns.publishedAt).toEqual(new Date("2026-03-04T00:00:00Z"));
    expect(columns.attributesSyncedAt).toBe(NOW);
  });

  it("maps a missing author to null rather than an empty string", () => {
    const columns = articleAttributeColumns({ author: null, tags: [] }, NOW);
    expect(columns.author).toBeNull();
  });

  it("writes isPublished false for an unpublished article", () => {
    // The column DEFAULTS to true, so a false has to be written explicitly —
    // dropping it would publish every draft in the sidebar's eyes.
    const columns = articleAttributeColumns({ author: { name: "x" }, tags: [], isPublished: false }, NOW);
    expect(columns.isPublished).toBe(false);
  });
});

describe("pageAttributeColumns", () => {
  it("returns {} when the block was not delivered", () => {
    expect(pageAttributeColumns({}, NOW)).toEqual({});
    expect(pageAttributeColumns({ templateSuffix: "x" }, NOW)).toEqual({});
  });

  it("maps a delivered block", () => {
    const columns = pageAttributeColumns(
      { templateSuffix: "contact", isPublished: false, publishedAt: null },
      NOW,
    );
    expect(columns).toEqual({
      templateSuffix: "contact",
      isPublished: false,
      publishedAt: null,
      attributesSyncedAt: NOW,
    });
  });
});

describe("attributesKnown", () => {
  it("is the discriminator between 'unknown' and 'the merchant left it empty'", () => {
    expect(attributesKnown({ attributesSyncedAt: null })).toBe(false);
    expect(attributesKnown({})).toBe(false);
    expect(attributesKnown(null)).toBe(false);
    expect(attributesKnown({ attributesSyncedAt: NOW })).toBe(true);
    expect(attributesKnown({ attributesSyncedAt: NOW.toISOString() })).toBe(true);
  });
});
