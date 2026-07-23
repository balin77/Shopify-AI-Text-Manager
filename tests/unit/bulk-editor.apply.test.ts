import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyBulkDiff, METAFIELDS_SET_CHUNK } from "~/services/bulk-editor/apply.server";
import {
  buildColumnsForType,
  metafieldColumnId,
  optionColumnId,
  IMG_ALT_COLUMN_ID,
  BULK_COLUMNS_BY_TYPE,
  type BulkDiffEntry,
  type BulkRowType,
  type ColumnDescriptor,
  type MetafieldColumnSpec,
  type ProductColumnCaps,
} from "~/services/bulk-editor/columns.shared";

/**
 * Mock-gateway tests for the Phase-2 persistence pipeline (Plan §4.4/§12):
 * fixed target-group order, metafieldsSet chunking at 25, clearing via
 * metafieldsDelete, and cell-granular partial failures (BulkFailure.columnId).
 *
 * The gateway is the REAL ShopifyApiGateway running over a fake admin client
 * — the queue/rate-limit plumbing runs, only the transport is mocked.
 */

const PRODUCT_ID = "gid://shopify/Product/1";
const SHOP = "test-shop.myshopify.com";

const fullCaps: ProductColumnCaps = { metafields: true, options: true, imageAlt: true };

function columnsFor(specs: MetafieldColumnSpec[]): Record<BulkRowType, ColumnDescriptor[]> {
  return {
    product: buildColumnsForType("product", specs, fullCaps),
    variant: BULK_COLUMNS_BY_TYPE.variant,
    collection: BULK_COLUMNS_BY_TYPE.collection,
    article: BULK_COLUMNS_BY_TYPE.article,
    page: BULK_COLUMNS_BY_TYPE.page,
    blog: BULK_COLUMNS_BY_TYPE.blog,
    policy: BULK_COLUMNS_BY_TYPE.policy,
    metaobject: BULK_COLUMNS_BY_TYPE.metaobject,
  };
}

interface RecordedCall {
  query: string;
  variables: Record<string, unknown> | undefined;
}

/** Fake admin client: records every GraphQL call and answers by mutation name
 * with a success-shaped payload (overridable per test). */
function mockAdmin(overrides?: {
  respond?: (query: string, variables: Record<string, unknown> | undefined) => unknown | undefined;
}) {
  const calls: RecordedCall[] = [];
  const admin = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const variables = opts?.variables;
      calls.push({ query, variables });
      const overridden = overrides?.respond?.(query, variables);
      const data = overridden !== undefined ? overridden : defaultResponse(query, variables);
      return { json: async () => data } as unknown as Response;
    },
  };
  return { admin, calls };
}

function defaultResponse(query: string, variables: Record<string, unknown> | undefined): unknown {
  if (query.includes("productUpdate(")) {
    return { data: { productUpdate: { userErrors: [] } } };
  }
  if (query.includes("metafieldsSet(")) {
    // Echo every input back with a synthetic GID — the pipeline mirrors ONLY
    // echoed values into the DB.
    const inputs = (variables?.metafields ?? []) as {
      namespace: string;
      key: string;
      value: string;
      type: string;
    }[];
    return {
      data: {
        metafieldsSet: {
          metafields: inputs.map((m, i) => ({
            id: `gid://shopify/Metafield/${i + 1}`,
            namespace: m.namespace,
            key: m.key,
            value: m.value,
            type: m.type,
          })),
          userErrors: [],
        },
      },
    };
  }
  if (query.includes("metafieldsDelete(")) {
    const identifiers = (variables?.metafields ?? []) as {
      ownerId: string;
      namespace: string;
      key: string;
    }[];
    return { data: { metafieldsDelete: { deletedMetafields: identifiers, userErrors: [] } } };
  }
  if (query.includes("productOptionUpdate(")) {
    // Echo the option back (like Shopify) so the persist path's echo check
    // passes: the target option with its sent name and the changed value names.
    const opt = (variables?.option ?? {}) as { id: string; name?: string };
    const valueUpdates = (variables?.optionValuesToUpdate ?? []) as { id: string; name: string }[];
    return {
      data: {
        productOptionUpdate: {
          product: { options: [{ id: opt.id, name: opt.name ?? "Size", values: valueUpdates.map((v) => v.name) }] },
          userErrors: [],
        },
      },
    };
  }
  if (query.includes("productUpdateMedia(")) {
    // Echo the sent alt back (like Shopify) so the persist path's echo check passes.
    const media = (variables?.media ?? []) as { id: string; alt?: string }[];
    return {
      data: {
        productUpdateMedia: {
          media: media.map((m) => ({ alt: m.alt ?? null, mediaErrors: [] })),
          mediaUserErrors: [],
        },
      },
    };
  }
  if (query.includes("translationsRemove(")) {
    // Phase 4b invalidation — echo back every (key, locale) asked for.
    const keys = (variables?.translationKeys ?? []) as string[];
    const locales = (variables?.locales ?? []) as string[];
    const translations = locales.flatMap((locale) => keys.map((key) => ({ key, locale })));
    return { data: { translationsRemove: { translations, userErrors: [] } } };
  }
  throw new Error(`Unexpected query in test: ${query.slice(0, 120)}`);
}

function mockDb() {
  return {
    product: {
      findUnique: vi.fn(async () => ({ seoTitle: "old", seoDescription: "old" })),
      update: vi.fn(async () => ({})),
    },
    productMetafield: {
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    productOption: {
      findFirst: vi.fn(async (_args?: unknown) => ({
        id: "gid://shopify/ProductOption/1",
        productId: PRODUCT_ID,
        name: "Size",
        position: 1,
        values: JSON.stringify([
          { id: "gid://shopify/ProductOptionValue/1", name: "S" },
          { id: "gid://shopify/ProductOptionValue/2", name: "M" },
        ]),
        linkedMetafieldKey: null,
      })),
      update: vi.fn(async (_args: unknown) => ({})),
    },
    productImage: {
      findFirst: vi.fn(async (_args?: unknown) => ({
        id: "img-row-1",
        productId: PRODUCT_ID,
        mediaId: "gid://shopify/MediaImage/5",
        altText: "old alt",
      })),
      update: vi.fn(async (_args: unknown) => ({})),
    },
    collection: { findUnique: vi.fn(), update: vi.fn() },
    page: { update: vi.fn() },
    article: { update: vi.fn() },
    // Phase 4b: stale-foreign-translation invalidation reads existing foreign
    // rows and deletes the confirmed ones. Default: no foreign translations
    // exist ⇒ invalidation short-circuits before any Shopify call.
    contentTranslation: {
      findMany: vi.fn(async () => [] as { key: string; locale: string }[]),
      deleteMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
    },
    metaobjectTranslation: {
      findMany: vi.fn(async () => [] as { key: string; locale: string }[]),
      deleteMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
    },
  };
}

function entry(columnId: string, value: string): BulkDiffEntry {
  return { rowId: PRODUCT_ID, rowType: "product", locale: "", marketId: "", columnId, value };
}

const MATERIAL_SPEC: MetafieldColumnSpec = {
  namespace: "custom",
  key: "material",
  type: "single_line_text_field",
};
const LIST_SPEC: MetafieldColumnSpec = {
  namespace: "custom",
  key: "tags",
  type: "list.single_line_text_field",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("applyBulkDiff — target-group order (Plan §4.4)", () => {
  it("persists base → metafields → options → image alt, in that order, in one row pass", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();
    const columnsByType = columnsFor([MATERIAL_SPEC]);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [
        // Deliberately shuffled — the ORDER of diff entries must not matter.
        entry(IMG_ALT_COLUMN_ID, "new alt"),
        entry(optionColumnId(1, "name"), "Größe"),
        entry(metafieldColumnId("custom", "material"), "Linen"),
        entry("field.title", "New title"),
      ],
    );

    expect(result.failures).toEqual([]);
    expect(result.saved).toBe(1);

    const order = calls.map((c) => {
      if (c.query.includes("productUpdate(")) return "productUpdate";
      if (c.query.includes("metafieldsSet(")) return "metafieldsSet";
      if (c.query.includes("productOptionUpdate(")) return "productOptionUpdate";
      if (c.query.includes("productUpdateMedia(")) return "productUpdateMedia";
      return "other";
    });
    expect(order).toEqual(["productUpdate", "metafieldsSet", "productOptionUpdate", "productUpdateMedia"]);
  });

  it("mirrors the alt-text with altTextModifiedAt so the webhook-triggered resync preserves it (§4.3/§10.3)", async () => {
    const { admin } = mockAdmin();
    const db = mockDb();
    const before = Date.now();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      [entry(IMG_ALT_COLUMN_ID, "fresh alt")],
    );

    expect(result.failures).toEqual([]);
    expect(db.productImage.update).toHaveBeenCalledTimes(1);
    const args = db.productImage.update.mock.calls[0][0] as unknown as {
      data: { altText: string; altTextModifiedAt: Date };
    };
    expect(args.data.altText).toBe("fresh alt");
    expect(args.data.altTextModifiedAt).toBeInstanceOf(Date);
    expect(args.data.altTextModifiedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("applyBulkDiff — metafields (Plan §4.1/§4.4/§14)", () => {
  it("sends ALL dirty metafields of one product in one call, chunked at 25", async () => {
    const specs: MetafieldColumnSpec[] = [];
    const diff: BulkDiffEntry[] = [];
    for (let i = 0; i < METAFIELDS_SET_CHUNK + 1; i++) {
      specs.push({ namespace: "custom", key: `field${i}`, type: "single_line_text_field" });
      diff.push(entry(metafieldColumnId("custom", `field${i}`), `value ${i}`));
    }
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor(specs) },
      diff,
    );

    expect(result.failures).toEqual([]);
    const setCalls = calls.filter((c) => c.query.includes("metafieldsSet("));
    expect(setCalls).toHaveLength(2);
    expect((setCalls[0].variables?.metafields as unknown[]).length).toBe(METAFIELDS_SET_CHUNK);
    expect((setCalls[1].variables?.metafields as unknown[]).length).toBe(1);
    // Upsert-form inputs: ownerId+namespace+key+type+value — type is
    // mandatory so an empty cell can CREATE the metafield (§14 no. 4).
    const first = (setCalls[0].variables?.metafields as Record<string, unknown>[])[0];
    expect(first).toMatchObject({
      ownerId: PRODUCT_ID,
      namespace: "custom",
      type: "single_line_text_field",
    });
    // Echoed values are mirrored into the DB.
    expect(db.productMetafield.upsert).toHaveBeenCalledTimes(METAFIELDS_SET_CHUNK + 1);
  });

  it("chunks metafieldsDelete at 25 like metafieldsSet (Finding 9)", async () => {
    const specs: MetafieldColumnSpec[] = [];
    const diff: BulkDiffEntry[] = [];
    for (let i = 0; i < METAFIELDS_SET_CHUNK + 1; i++) {
      specs.push({ namespace: "custom", key: `field${i}`, type: "single_line_text_field" });
      diff.push(entry(metafieldColumnId("custom", `field${i}`), "")); // "" = clear
    }
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor(specs) },
      diff,
    );

    expect(result.failures).toEqual([]);
    const deleteCalls = calls.filter((c) => c.query.includes("metafieldsDelete("));
    expect(deleteCalls).toHaveLength(2);
    expect((deleteCalls[0].variables?.metafields as unknown[]).length).toBe(METAFIELDS_SET_CHUNK);
    expect((deleteCalls[1].variables?.metafields as unknown[]).length).toBe(1);
    expect(db.productMetafield.deleteMany).toHaveBeenCalledTimes(METAFIELDS_SET_CHUNK + 1);
  });

  it("clears a metafield cell via metafieldsDelete, NEVER metafieldsSet with '' (§14 no. 4)", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([MATERIAL_SPEC]) },
      [entry(metafieldColumnId("custom", "material"), "")],
    );

    expect(result.failures).toEqual([]);
    expect(calls.some((c) => c.query.includes("metafieldsSet("))).toBe(false);
    const deleteCalls = calls.filter((c) => c.query.includes("metafieldsDelete("));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].variables?.metafields).toEqual([
      { ownerId: PRODUCT_ID, namespace: "custom", key: "material" },
    ]);
    // Local row removed only after Shopify confirmed the delete (echo check).
    expect(db.productMetafield.deleteMany).toHaveBeenCalledWith({
      where: { productId: PRODUCT_ID, namespace: "custom", key: "material" },
    });
  });

  it("does NOT delete the local row when Shopify does not echo the removal (CLAUDE.md invariant)", async () => {
    const { admin } = mockAdmin({
      respond: (query) =>
        query.includes("metafieldsDelete(")
          ? { data: { metafieldsDelete: { deletedMetafields: [], userErrors: [] } } }
          : undefined,
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([MATERIAL_SPEC]) },
      [entry(metafieldColumnId("custom", "material"), "")],
    );

    expect(db.productMetafield.deleteMany).not.toHaveBeenCalled();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(metafieldColumnId("custom", "material"));
  });

  it("parses list metafields back to a JSON array and rejects empty values without calling Shopify", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();
    const columnsByType = columnsFor([LIST_SPEC]);

    const ok = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(metafieldColumnId("custom", "tags"), "Red | Blue | Green")],
    );
    expect(ok.failures).toEqual([]);
    const setCall = calls.find((c) => c.query.includes("metafieldsSet("));
    const input = (setCall?.variables?.metafields as { value: string }[])[0];
    expect(input.value).toBe(JSON.stringify(["Red", "Blue", "Green"]));

    calls.length = 0;
    const bad = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(metafieldColumnId("custom", "tags"), "Red | | Green")],
    );
    expect(bad.saved).toBe(0);
    expect(bad.failures).toHaveLength(1);
    expect(bad.failures[0].columnId).toBe(metafieldColumnId("custom", "tags"));
    expect(calls.some((c) => c.query.includes("metafieldsSet("))).toBe(false);
  });
});

describe("applyBulkDiff — cell-granular partial failures (Plan §4.4/§12)", () => {
  it("lands a metafieldsSet userError on the RIGHT cell while the base fields still save", async () => {
    const specs: MetafieldColumnSpec[] = [
      MATERIAL_SPEC,
      { namespace: "custom", key: "care", type: "single_line_text_field" },
    ];
    const { admin } = mockAdmin({
      respond: (query) =>
        query.includes("metafieldsSet(")
          ? {
              data: {
                metafieldsSet: {
                  metafields: null,
                  // Shopify's field path is an ARRAY of segments (§14 no. 1).
                  userErrors: [{ field: ["metafields", "1", "value"], message: "Value is invalid" }],
                },
              },
            }
          : undefined,
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor(specs) },
      [
        entry("field.title", "Still fine"),
        entry(metafieldColumnId("custom", "material"), "Linen"),
        entry(metafieldColumnId("custom", "care"), "bad value"),
      ],
    );

    // Base productUpdate succeeded and was mirrored.
    expect(db.product.update).toHaveBeenCalled();
    // The row is not "saved" (it has failures), but only the metafield cells
    // carry them — the named index gets the real message, the sibling gets
    // the atomicity explanation (metafieldsSet is atomic per call).
    expect(result.saved).toBe(0);
    const byColumn = new Map(result.failures.map((f) => [f.columnId, f.message]));
    expect(byColumn.get(metafieldColumnId("custom", "care"))).toBe("Value is invalid");
    expect(byColumn.has(metafieldColumnId("custom", "material"))).toBe(true);
    expect(byColumn.has("field.title")).toBe(false);
    // No DB mirror for the failed (atomic) chunk.
    expect(db.productMetafield.upsert).not.toHaveBeenCalled();
  });

  it("fails an option values-count mismatch as a cell error without calling Shopify (§4.2)", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      // Option 1 has two values (S, M) — three provided.
      [entry(optionColumnId(1, "values"), "S | M | L")],
    );

    expect(result.saved).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(optionColumnId(1, "values"));
    expect(result.failures[0].message).toContain("2 value(s)");
    expect(calls.some((c) => c.query.includes("productOptionUpdate("))).toBe(false);
  });

  it("rejects edits on a metaobject-linked option entirely — name included (§14 no. 5)", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();
    db.productOption.findFirst.mockResolvedValue({
      id: "gid://shopify/ProductOption/2",
      productId: PRODUCT_ID,
      name: "Color",
      position: 1,
      values: JSON.stringify([{ id: "gid://shopify/ProductOptionValue/9", name: "Red" }]),
      linkedMetafieldKey: "color",
    } as never);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      [entry(optionColumnId(1, "name"), "Colour"), entry(optionColumnId(1, "values"), "Crimson")],
    );

    expect(result.saved).toBe(0);
    expect(result.failures.map((f) => f.columnId).sort()).toEqual([
      optionColumnId(1, "name"),
      optionColumnId(1, "values"),
    ]);
    expect(calls.some((c) => c.query.includes("productOptionUpdate("))).toBe(false);
  });

  it("maps renamed option values positionally onto their GIDs and mirrors the DB row", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      [entry(optionColumnId(1, "values"), "Small | M")],
    );

    expect(result.failures).toEqual([]);
    const call = calls.find((c) => c.query.includes("productOptionUpdate("));
    // Only the CHANGED value is sent (S → Small; M unchanged).
    expect(call?.variables?.optionValuesToUpdate).toEqual([
      { id: "gid://shopify/ProductOptionValue/1", name: "Small" },
    ]);
    expect(db.productOption.update).toHaveBeenCalledTimes(1);
    const mirrored = db.productOption.update.mock.calls[0][0] as unknown as { data: { values: string } };
    expect(JSON.parse(mirrored.data.values)).toEqual([
      { id: "gid://shopify/ProductOptionValue/1", name: "Small" },
      { id: "gid://shopify/ProductOptionValue/2", name: "M" },
    ]);
  });

  it("fails the option update and skips the DB mirror when Shopify does not echo it back (silent no-op guard)", async () => {
    // userErrors:[] but the product echoes no matching option → the accepted
    // call stored nothing. Must surface as a cell error, never mirror to DB.
    const { admin } = mockAdmin({
      respond: (query) =>
        query.includes("productOptionUpdate(")
          ? { data: { productOptionUpdate: { product: { options: [] }, userErrors: [] } } }
          : undefined,
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      [entry(optionColumnId(1, "values"), "Small | M")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(optionColumnId(1, "values"));
    expect(db.productOption.update).not.toHaveBeenCalled();
  });

  it("fails img.alt as a cell error when the cached image has no mediaId (§4.3)", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();
    db.productImage.findFirst.mockResolvedValue({
      id: "img-row-1",
      productId: PRODUCT_ID,
      mediaId: null,
      altText: "x",
    } as never);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      [entry(IMG_ALT_COLUMN_ID, "new alt")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(IMG_ALT_COLUMN_ID);
    expect(calls.some((c) => c.query.includes("productUpdateMedia("))).toBe(false);
  });

  it("fails img.alt and skips the DB mirror when Shopify echoes back the unchanged alt (silent no-op guard)", async () => {
    // Accepted call, no mediaErrors, but the echoed alt is still the OLD value
    // → Shopify stored nothing. Must not mirror "new alt" into the DB.
    const { admin } = mockAdmin({
      respond: (query) =>
        query.includes("productUpdateMedia(")
          ? { data: { productUpdateMedia: { media: [{ alt: "old alt", mediaErrors: [] }], mediaUserErrors: [] } } }
          : undefined,
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      [entry(IMG_ALT_COLUMN_ID, "new alt")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(IMG_ALT_COLUMN_ID);
    expect(db.productImage.update).not.toHaveBeenCalled();
  });

  it("rejects a partial-SEO product write as a CELL error when the cache row is missing (Finding 7)", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();
    // No cache row → the untouched SEO half cannot be resolved.
    db.product.findUnique.mockResolvedValue(null as never);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      [entry("field.seoTitle", "New SEO title"), entry("field.title", "Still saves")],
    );

    // The SEO cell fails with the resync hint — and NO productUpdate call
    // ever carries a `seo` input (the "" fallback would wipe the untouched
    // description on Shopify).
    const seoFailure = result.failures.find((f) => f.columnId === "field.seoTitle");
    expect(seoFailure).toBeDefined();
    expect(seoFailure?.message).toContain("resync");
    const updateCalls = calls.filter((c) => c.query.includes("productUpdate("));
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0].variables?.input as Record<string, unknown>;
    expect(input.seo).toBeUndefined();
    // The row's OTHER base cell still saved.
    expect(input.title).toBe("Still saves");
    expect(result.failures.some((f) => f.columnId === "field.title")).toBe(false);
  });

  it("rejects a partial-SEO collection write BEFORE any Shopify call when the cache row is missing (Finding 7)", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();
    db.collection.findUnique.mockResolvedValue(null as never);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      [
        {
          rowId: "gid://shopify/Collection/3",
          rowType: "collection",
          locale: "",
          marketId: "",
          columnId: "field.seoDescription",
          value: "Only one half",
        },
      ],
    );

    // Row-level failure (collections are single-mutation) with the resync
    // hint — and NOT A SINGLE Shopify call, so nothing was half-written.
    expect(result.saved).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBeUndefined();
    expect(result.failures[0].message).toContain("resync");
    expect(calls).toHaveLength(0);
  });

  it("keeps single-mutation rows on row-level failures (no columnId)", async () => {
    const { admin } = mockAdmin();
    const db = mockDb();
    db.page.update.mockResolvedValue({} as never);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      [
        {
          rowId: "gid://shopify/Page/7",
          rowType: "page",
          locale: "",
          marketId: "",
          columnId: "field.title",
          value: "   ",
        },
      ],
    );

    expect(result.saved).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBeUndefined();
    expect(result.failures[0].message).toBe("Title cannot be empty.");
  });
});

describe("applyBulkDiff — stale-foreign-translation invalidation (Phase 4b)", () => {
  it("removes the changed primary field's foreign translations (Shopify + DB) on save", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();
    // One existing German title translation → must be invalidated.
    db.contentTranslation.findMany.mockResolvedValue([{ key: "title", locale: "de" }] as never);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]), foreignLocales: ["de"] },
      [entry("field.title", "New title")],
    );

    expect(result.failures).toEqual([]);
    // Shopify removal issued for the title key in de.
    const remove = calls.find((c) => c.query.includes("translationsRemove("));
    expect(remove).toBeDefined();
    expect(remove?.variables?.translationKeys).toEqual(["title"]);
    expect(remove?.variables?.locales).toEqual(["de"]);
    // Local row deleted only after the echo confirmed it.
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    const del = db.contentTranslation.deleteMany.mock.calls[0][0] as unknown as { where: Record<string, unknown> };
    expect(del.where).toMatchObject({ resourceId: PRODUCT_ID, locale: "de", marketId: "" });
  });

  it("does NOT delete the local row when Shopify does not confirm the removal", async () => {
    const { admin } = mockAdmin({
      respond: (query) =>
        query.includes("translationsRemove(")
          ? { data: { translationsRemove: { translations: [], userErrors: [] } } } // no echo
          : undefined,
    });
    const db = mockDb();
    db.contentTranslation.findMany.mockResolvedValue([{ key: "title", locale: "de" }] as never);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]), foreignLocales: ["de"] },
      [entry("field.title", "New title")],
    );

    expect(result.failures).toEqual([]); // primary save still succeeded
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("makes no invalidation query when no foreign locales are configured", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    await applyBulkDiff(
      // foreignLocales omitted → invalidation is a no-op.
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsFor([]) },
      [entry("field.title", "New title")],
    );

    expect(db.contentTranslation.findMany).not.toHaveBeenCalled();
    expect(calls.some((c) => c.query.includes("translationsRemove("))).toBe(false);
  });
});
