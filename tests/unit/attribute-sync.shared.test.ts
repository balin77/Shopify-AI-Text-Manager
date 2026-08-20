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

/**
 * A response carrying EVERY key `PRODUCT_ATTRIBUTE_SELECTION` asks for — which
 * is what the mappers require before they treat the block as delivered.
 * GraphQL always returns the keys it was asked for, null-valued when unset.
 */
function fullProduct(overrides: Record<string, unknown> = {}) {
  return {
    vendor: "Acme",
    tags: [] as string[],
    templateSuffix: null,
    publishedAt: null,
    category: null,
    ...overrides,
  };
}

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
    const columns = productAttributeColumns(fullProduct({ vendor: "   " }), NOW);
    expect(columns.vendor).toBeNull();
  });

  it("drops blank tags and trims the rest", () => {
    const columns = productAttributeColumns(fullProduct({ tags: [" sale ", "", "  "] }), NOW);
    expect(columns.tags).toEqual(["sale"]);
  });

  it("requires EVERY key of the selection, not just one of them", () => {
    // A response built from a narrower selection is not a complete block.
    // Accepting it would write tags: [] over real tags and stamp
    // attributesSyncedAt — "unknown" turned into a confident wrong value.
    expect(hasProductAttributes(fullProduct())).toBe(true);
    expect(hasProductAttributes({ vendor: "Acme" })).toBe(false);
    expect(hasProductAttributes({ tags: ["sale"] })).toBe(false);
    expect(hasProductAttributes({})).toBe(false);
  });

  it("does not overwrite tags from a response that only carried vendor", () => {
    expect(productAttributeColumns({ vendor: "Acme" }, NOW)).toEqual({});
  });

  it("falls back to the category leaf name when fullName is absent", () => {
    const columns = productAttributeColumns(
      fullProduct({ category: { id: "gid://x/1", name: "Shirts" } }),
      NOW,
    );
    expect(columns.categoryName).toBe("Shirts");
  });

  it("maps an unparsable publishedAt to null instead of an Invalid Date", () => {
    const columns = productAttributeColumns(fullProduct({ publishedAt: "not-a-date" }), NOW);
    expect(columns.publishedAt).toBeNull();
  });

  it("maps a never-published product to publishedAt null", () => {
    const columns = productAttributeColumns(fullProduct({ publishedAt: null }), NOW);
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

  it("names the API version AND the model it read, so the two are never confused", () => {
    // The envelope's whole job. `ruleSet` is a LOSSY back-projection of
    // `sources` (CLAUDE.md) — exclusions, extra sources and variant targeting
    // vanish from it — so a reader that could not tell which model a row holds
    // would have to guess, and guessing wrong changes a collection's
    // membership.
    const legacy = collectionAttributeColumns(
      { sortOrder: "MANUAL", templateSuffix: null, ruleSet: null },
      "2025-10",
      NOW,
    );
    expect(legacy.sourcesJson).toMatchObject({ shape: "ruleSet", apiVersion: "2025-10" });

    // From 2026-07 the sync asks for `sources` INSTEAD of `ruleSet`, so the
    // envelope says so. Storing this as a "ruleSet" row would hand the rule
    // editor a tree in the wrong shape.
    const modern = collectionAttributeColumns(
      { sortOrder: "MANUAL", templateSuffix: null, sources: [] },
      "2026-07",
      NOW,
    );
    expect(modern.sourcesJson).toMatchObject({ shape: "sources", apiVersion: "2026-07" });
  });

  it("reads 'is this rule-based' off the model the version actually delivers", () => {
    // On 2026-07 the signal is a CONDITION, not the presence of a source.
    // Asking `ruleSet` there would answer "manual" for every collection whose
    // tree the projection cannot express.
    const smart = collectionAttributeColumns(
      {
        sortOrder: "MANUAL",
        templateSuffix: null,
        sources: [
          {
            __typename: "CollectionConditionsSource",
            inclusion: { conditions: [{ __typename: "CollectionSourceInclusionConditionProductTag" }] },
            exclusion: null,
          },
        ],
      },
      "2026-07",
      NOW,
    );
    expect(smart.isSmart).toBe(true);

    const manual = collectionAttributeColumns(
      { sortOrder: "MANUAL", templateSuffix: null, sources: [] },
      "2026-07",
      NOW,
    );
    expect(manual.isSmart).toBe(false);
  });

  it("reads a MANUAL collection's own source as manual", () => {
    // MEASURED (2026-08-20, live 2026-07 shop): every collection of a shop
    // with no smart collection at all came back with a
    // `CollectionConditionsSource` carrying ZERO conditions and hand-picked
    // `selections`. So a source is not evidence of a rule — it is evidence of
    // a membership, which every collection has. Reading it the old way locked
    // every row of the membership picker with "managed by this collection's
    // rules" next to collections that have none.
    const columns = collectionAttributeColumns(
      {
        sortOrder: "MANUAL",
        templateSuffix: null,
        sources: [
          {
            __typename: "CollectionConditionsSource",
            inclusion: { conditions: [] },
            exclusion: { conditions: [] },
          },
        ],
      },
      "2026-07",
      NOW,
    );
    expect(columns.isSmart).toBe(false);
    // The tree is still mirrored — the editor has to be able to hand back
    // what it cannot render.
    expect(columns.attributesSyncedAt).toBe(NOW);
  });

  it("counts an EXCLUSION-only source as rule-based", () => {
    const columns = collectionAttributeColumns(
      {
        sortOrder: "MANUAL",
        templateSuffix: null,
        sources: [
          {
            __typename: "CollectionConditionsSource",
            inclusion: { conditions: [] },
            exclusion: { conditions: [{ __typename: "CollectionSourceExclusionConditionProductTag" }] },
          },
        ],
      },
      "2026-07",
      NOW,
    );
    expect(columns.isSmart).toBe(true);
  });

  it("counts a SUB-COLLECTIONS source as rule-based", () => {
    // Its members follow another collection, which is no more hand-picked
    // than a tag rule is — and Shopify refuses a manual join either way.
    const columns = collectionAttributeColumns(
      {
        sortOrder: "MANUAL",
        templateSuffix: null,
        sources: [{ __typename: "CollectionSubCollectionsSource" }],
      },
      "2026-07",
      NOW,
    );
    expect(columns.isSmart).toBe(true);
  });

  it("REFUSES a sources selection too narrow to answer the question", () => {
    // `sources { id }` would report "no conditions" for a real rule tree and
    // mark it MANUAL — the expensive direction: the picker then offers a join
    // Shopify refuses, and `productUpdate` is atomic, so the refusal takes the
    // merchant's text edits with it. Nothing is written at all instead.
    expect(
      collectionAttributeColumns(
        {
          sortOrder: "MANUAL",
          templateSuffix: null,
          sources: [{ __typename: "CollectionConditionsSource" }],
        },
        "2026-07",
        NOW,
      ),
    ).toEqual({});
  });

  it("requires EVERY key of the selection", () => {
    expect(collectionAttributeColumns({ sortOrder: "MANUAL" }, "2025-10", NOW)).toEqual({});
  });

  it("clears the tree when a collection stopped being rule-based", () => {
    // A stale tree left behind would keep the rule editor showing rules that
    // no longer govern the collection's membership.
    const columns = collectionAttributeColumns(
      { sortOrder: "MANUAL", templateSuffix: null, ruleSet: null },
      "2025-10",
      NOW,
    );
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
      { author: { name: "Jane Doe" }, tags: ["news"], templateSuffix: null, isPublished: true, publishedAt: "2026-03-04T00:00:00Z" },
      NOW,
    );
    expect(columns.author).toBe("Jane Doe");
    expect(columns.tags).toEqual(["news"]);
    expect(columns.isPublished).toBe(true);
    expect(columns.publishedAt).toEqual(new Date("2026-03-04T00:00:00Z"));
    expect(columns.attributesSyncedAt).toBe(NOW);
  });

  it("maps a missing author to null rather than an empty string", () => {
    const columns = articleAttributeColumns(
      { author: null, tags: [], templateSuffix: null, isPublished: true, publishedAt: null },
      NOW,
    );
    expect(columns.author).toBeNull();
  });

  it("requires EVERY key of the selection", () => {
    expect(articleAttributeColumns({ author: { name: "x" } }, NOW)).toEqual({});
  });

  it("writes isPublished false for an unpublished article", () => {
    // The column DEFAULTS to true, so a false has to be written explicitly —
    // dropping it would publish every draft in the sidebar's eyes.
    const columns = articleAttributeColumns(
      { author: { name: "x" }, tags: [], templateSuffix: null, isPublished: false, publishedAt: null },
      NOW,
    );
    expect(columns.isPublished).toBe(false);
  });
});

describe("pageAttributeColumns", () => {
  it("returns {} when the block was not delivered", () => {
    expect(pageAttributeColumns({}, NOW)).toEqual({});
    // A narrower selection is not a complete block, even though the one key
    // it did carry is a real one.
    expect(pageAttributeColumns({ templateSuffix: "x" }, NOW)).toEqual({});
    expect(pageAttributeColumns({ isPublished: true }, NOW)).toEqual({});
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
