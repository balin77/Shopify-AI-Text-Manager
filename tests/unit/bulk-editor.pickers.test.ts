import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import {
  buildColumnsForType,
  resolveCellValue,
  columnCanHaveCellActions,
  isPickerColumn,
  ATTRIBUTE_BLOCK_COLUMNS,
  BULK_COLUMNS_BY_TYPE,
  CATEGORY_COLUMN_ID,
  COLLECTIONS_COLUMN_ID,
  VAR_PRICE_COLUMN_ID,
  type BulkDiffEntry,
  type BulkRow,
  type BulkRowType,
  type ColumnDescriptor,
  type ProductColumnCaps,
} from "~/services/bulk-editor/columns.shared";
import {
  canonicalCollectionIds,
  collectionPickerRows,
  parseGridCollectionIds,
} from "~/services/collection-picker.shared";

/**
 * Category and collections, edited in the grid through the single editor's
 * pickers.
 *
 * Neither is text: a category is a TaxonomyCategory GID (a NAME is not writable
 * back — the tree repeats names), and a membership is a JOIN/LEAVE diff against
 * the cache, never a list. So the cell VALUE is the GID form and the write goes
 * through the editor's own `parseCategoryId` / `diffCollectionMembership`.
 *
 * The rule that earned its own tests is the one about PASTE: the editor's
 * `parseCollectionIds` drops what it cannot read, so under it a pasted
 * "Sale, Winter" would parse to NO collections and save as "leave every manual
 * collection". The grid's parser is strict, and paste skips these cells.
 */

const SHOP = "test-shop.myshopify.com";
const PRODUCT_ID = "gid://shopify/Product/1";
const SALE = "gid://shopify/Collection/10";
const WINTER = "gid://shopify/Collection/20";
const SMART = "gid://shopify/Collection/30";
const CATEGORY = "gid://shopify/TaxonomyCategory/hg-3-74";

const fullCaps: ProductColumnCaps = { metafields: true, options: true, imageAlt: true };

function columnsByType(): Record<BulkRowType, ColumnDescriptor[]> {
  return {
    ...(Object.fromEntries(
      (Object.keys(BULK_COLUMNS_BY_TYPE) as BulkRowType[]).map((t) => [t, BULK_COLUMNS_BY_TYPE[t]]),
    ) as Record<BulkRowType, ColumnDescriptor[]>),
    product: buildColumnsForType("product", [], fullCaps),
  };
}

interface RecordedCall {
  query: string;
  variables: Record<string, unknown> | undefined;
}

/** Shopify echoes the product's memberships AFTER the join/leave, and its
 *  category — which is what the mirror reads. */
function mockAdmin(after: { collections?: { id: string; title: string; ruleSet?: object | null }[] } = {}) {
  const calls: RecordedCall[] = [];
  const admin = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const variables = opts?.variables;
      calls.push({ query, variables });
      if (!query.includes("productUpdate(")) throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
      const input = (variables?.input ?? {}) as Record<string, unknown>;
      return {
        json: async () => ({
          data: {
            productUpdate: {
              product: {
                id: PRODUCT_ID,
                handle: "h",
                tags: [],
                templateSuffix: null,
                ...("category" in input
                  ? {
                      category: input.category
                        ? { id: input.category, fullName: "Home & Garden > Decor > Vases", name: "Vases" }
                        : null,
                    }
                  : {}),
                ...(after.collections
                  ? {
                      collections: {
                        pageInfo: { hasNextPage: false },
                        nodes: after.collections.map((c) => ({ ...c, ruleSet: c.ruleSet ?? null })),
                      },
                    }
                  : {}),
              },
              userErrors: [],
            },
          },
        }),
      } as unknown as Response;
    },
  };
  return { admin, calls };
}

/** The cache: the product is in SALE (manual) and SMART (rule-based). */
function mockDb() {
  const tx = {
    product: { update: vi.fn(async (_args?: unknown) => ({})) },
    productCollection: {
      deleteMany: vi.fn(async (_args?: unknown) => ({ count: 2 })),
      createMany: vi.fn(async (_args?: unknown) => ({ count: 2 })),
    },
  };
  return {
    tx,
    product: {
      findUnique: vi.fn(async () => ({ seoTitle: "old", seoDescription: "old" })),
      update: vi.fn(async (_args?: unknown) => ({})),
    },
    productCollection: {
      findMany: vi.fn(async () => [
        { collectionId: SALE, collectionTitle: "Sale", automated: false },
        { collectionId: SMART, collectionTitle: "Bestseller", automated: true },
      ]),
    },
    collection: {
      findMany: vi.fn(async () => [
        { id: SALE, title: "Sale", isSmart: false, attributesSyncedAt: new Date() },
        { id: WINTER, title: "Winter", isSmart: false, attributesSyncedAt: new Date() },
        { id: SMART, title: "Bestseller", isSmart: true, attributesSyncedAt: new Date() },
      ]),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    contentTranslation: {
      findMany: vi.fn(async () => [] as { key: string; locale: string }[]),
      deleteMany: vi.fn(async (_args?: unknown) => ({ count: 0 })),
    },
    aISettings: {
      findUnique: vi.fn(async () => ({
        translationPurgeOnPrimaryChange: true,
        autoTranslateExternalChanges: false,
        subscriptionPlan: "max",
      })),
    },
  };
}

function entry(columnId: string, value: string): BulkDiffEntry {
  return { rowId: PRODUCT_ID, rowType: "product", locale: "", marketId: "", columnId, value };
}

function productUpdateInput(calls: RecordedCall[]): Record<string, unknown> | undefined {
  return calls.find((c) => c.query.includes("productUpdate("))?.variables?.input as
    | Record<string, unknown>
    | undefined;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── The pure pieces ───────────────────────────────────────────────────────

describe("canonicalCollectionIds", () => {
  it("makes the same SET read as the same string, whatever the tick order", () => {
    // The grid decides "dirty" by comparing strings; ticking and un-ticking a
    // row must not leave behind an edit that is only a re-ordering.
    expect(canonicalCollectionIds([WINTER, SALE])).toBe(canonicalCollectionIds([SALE, WINTER, SALE]));
  });
});

describe("parseGridCollectionIds — strict where the editor's parser is lenient", () => {
  it("refuses a pasted TITLE instead of reading it as 'no collections'", () => {
    // Under the lenient reading this is [] — and [] saves as "leave every
    // manual collection": the product silently leaves all of them.
    expect(parseGridCollectionIds("Sale, Winter")).toEqual({ ok: false, bad: ["Sale", "Winter"] });
  });

  it("refuses the whole cell over ONE unreadable token", () => {
    expect(parseGridCollectionIds(`${SALE}, Winter`).ok).toBe(false);
  });

  it("still takes an EMPTY cell as 'no manual collections'", () => {
    // What un-ticking every row in the picker produces.
    expect(parseGridCollectionIds("")).toEqual({ ok: true, ids: [] });
  });
});

describe("collectionPickerRows", () => {
  it("keeps a membership the collection cache never stored, so it stays ticked", () => {
    // Invisible means un-ticked, which the diff reads as "remove it".
    const rows = collectionPickerRows(
      [{ id: SALE, title: "Sale", automated: false }],
      [{ collectionId: WINTER, collectionTitle: "Winter", automated: false }],
    );
    expect(rows.map((r) => r.id).sort()).toEqual([SALE, WINTER].sort());
  });

  it("locks a row EITHER source calls rule-based — the server's own ladder", () => {
    const [row] = collectionPickerRows(
      [{ id: SMART, title: "Bestseller", automated: false }],
      [{ collectionId: SMART, collectionTitle: "Bestseller", automated: true }],
    );
    expect(row.automated).toBe(true);
  });
});

// ─── The columns ───────────────────────────────────────────────────────────

describe("the two picker columns", () => {
  const column = (id: string) => buildColumnsForType("product", [], fullCaps).find((c) => c.id === id)!;

  it("are editable field columns with a picker input, and carry no AI menu", () => {
    for (const id of [CATEGORY_COLUMN_ID, COLLECTIONS_COLUMN_ID]) {
      const col = column(id);
      expect(col.kind).toBe("field");
      expect(col.editable).toBe(true);
      expect(col.translatable).toBe(false);
      expect(isPickerColumn(col)).toBe(true);
      // "Improve with AI" on a GID is not a thing.
      expect(columnCanHaveCellActions(col)).toBe(false);
    }
  });

  it("stay read-only on a row that was never attribute-synced", () => {
    // An empty membership list there would be saved as "leave every
    // collection" — the expensive direction of the migration-default trap.
    expect(ATTRIBUTE_BLOCK_COLUMNS.has(COLLECTIONS_COLUMN_ID)).toBe(true);
    const row: BulkRow = {
      id: PRODUCT_ID,
      type: "product",
      title: "Vase",
      seoTitle: "",
      seoDescription: "",
      handle: "vase",
      collections: "",
      attributesKnown: false,
    };
    expect(resolveCellValue(row, column(COLLECTIONS_COLUMN_ID)).readOnlyReason).toBe("attributesNotSynced");
  });

  it("hold the GID form as their value", () => {
    const row: BulkRow = {
      id: PRODUCT_ID,
      type: "product",
      title: "Vase",
      seoTitle: "",
      seoDescription: "",
      handle: "vase",
      category: CATEGORY,
      categoryName: "Home & Garden > Decor > Vases",
      collections: canonicalCollectionIds([SALE]),
      attributesKnown: true,
    };
    expect(resolveCellValue(row, column(CATEGORY_COLUMN_ID)).value).toBe(CATEGORY);
    expect(resolveCellValue(row, column(COLLECTIONS_COLUMN_ID)).value).toBe(SALE);
  });
});

describe("a price cell on a multi-variant product", () => {
  it("is read-only for a reason the grid can show a placeholder for", () => {
    // The tooltip explaining it existed but had nothing to be hovered on —
    // the cell was blank. The grid now renders a placeholder per reason, and
    // this is the reason it keys that on.
    const row: BulkRow = {
      id: PRODUCT_ID,
      type: "product",
      title: "Shirt",
      seoTitle: "",
      seoDescription: "",
      handle: "shirt",
      variantCount: 2,
    };
    const col = buildColumnsForType("product", [], fullCaps).find((c) => c.id === VAR_PRICE_COLUMN_ID)!;
    expect(resolveCellValue(row, col)).toEqual({
      value: "",
      editable: false,
      readOnlyReason: "multipleVariants",
    });
  });
});

// ─── Writing them ──────────────────────────────────────────────────────────

describe("applyBulkDiff — the category", () => {
  it("sends the GID and mirrors Shopify's full path", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(CATEGORY_COLUMN_ID, CATEGORY)],
    );

    expect(result.failures).toEqual([]);
    expect(productUpdateInput(calls)?.category).toBe(CATEGORY);
    const mirrored = (db.product.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(mirrored.categoryId).toBe(CATEGORY);
    // The PATH — what the picker labels the category with.
    expect(mirrored.categoryName).toBe("Home & Garden > Decor > Vases");
    // No 1:1 copy of the cell string into a column that does not exist.
    expect("category" in mirrored).toBe(false);
  });

  it("clears as null — the product leaves the taxonomy", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(CATEGORY_COLUMN_ID, "")],
    );

    expect(productUpdateInput(calls)?.category).toBeNull();
    const mirrored = (db.product.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(mirrored.categoryId).toBeNull();
  });

  it("refuses a value that is not a category GID, per cell", async () => {
    // Forwarded, a wrong-typed id fails at the SCHEMA level — a save that
    // reads as a success while nothing was written.
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(CATEGORY_COLUMN_ID, "Vases"), entry("field.title", "Vase")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(CATEGORY_COLUMN_ID);
    expect("category" in (productUpdateInput(calls) ?? {})).toBe(false);
    expect(productUpdateInput(calls)?.title).toBe("Vase");
  });
});

describe("applyBulkDiff — the memberships", () => {
  it("JOINS and LEAVES as a diff against the cache, never as a list", async () => {
    // Cache: SALE (manual) + SMART (rule-based). Cell: WINTER + SMART.
    const { admin, calls } = mockAdmin({
      collections: [
        { id: WINTER, title: "Winter" },
        { id: SMART, title: "Bestseller", ruleSet: { appliedDisjunctively: false } },
      ],
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(COLLECTIONS_COLUMN_ID, canonicalCollectionIds([WINTER, SMART]))],
    );

    expect(result.failures).toEqual([]);
    const input = productUpdateInput(calls)!;
    expect(input.collectionsToJoin).toEqual([WINTER]);
    expect(input.collectionsToLeave).toEqual([SALE]);
    // The rule-based membership is neither joined nor left.
    expect(JSON.stringify(input)).not.toContain(SMART);
  });

  it("rebuilds the cache from the ECHO in one transaction", async () => {
    const { admin } = mockAdmin({ collections: [{ id: WINTER, title: "Winter" }] });
    const db = mockDb();

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(COLLECTIONS_COLUMN_ID, WINTER)],
    );

    // A blip between the delete and the insert would otherwise leave the
    // product cached as a member of NOTHING while the save reported success.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.tx.productCollection.deleteMany).toHaveBeenCalled();
    const created = (db.tx.productCollection.createMany.mock.calls[0]![0] as { data: { collectionId: string }[] })
      .data;
    expect(created.map((r) => r.collectionId)).toEqual([WINTER]);
    // `collections` is a relation — never copied across as a string.
    const mirrored = (db.tx.product.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect("collections" in mirrored).toBe(false);
  });

  it("REFUSES a pasted title list rather than leaving every collection", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(COLLECTIONS_COLUMN_ID, "Sale, Winter")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(COLLECTIONS_COLUMN_ID);
    // Nothing reached Shopify — in particular no `collectionsToLeave`.
    expect(calls).toHaveLength(0);
  });

  it("refuses to JOIN a rule-based collection and still writes the rest", async () => {
    // Joined, Shopify refuses — and because `productUpdate` is atomic, the
    // refusal would take this row's title with it. The picker locks the row;
    // this is the server-side twin for CSV and direct POST.
    const { admin, calls } = mockAdmin({ collections: [{ id: SALE, title: "Sale" }] });
    const db = mockDb();
    db.productCollection.findMany.mockResolvedValueOnce([
      { collectionId: SALE, collectionTitle: "Sale", automated: false },
    ]);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [
        entry(COLLECTIONS_COLUMN_ID, canonicalCollectionIds([SALE, SMART, WINTER])),
        entry("field.title", "Vase"),
      ],
    );

    const input = productUpdateInput(calls)!;
    expect(input.collectionsToJoin).toEqual([WINTER]);
    expect(input.title).toBe("Vase");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(COLLECTIONS_COLUMN_ID);
    expect(result.failures[0].message).toContain("Bestseller");
  });

  it("sends nothing when the cell already matches the cache", async () => {
    // `productUpdate` with only an id would report a save of nothing.
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(COLLECTIONS_COLUMN_ID, canonicalCollectionIds([SALE, SMART]))],
    );

    expect(result.failures).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ─── Review findings, pinned ───────────────────────────────────────────────

describe("pickerDisplayValue — a read-only picker cell shows NAMES", () => {
  const cols = buildColumnsForType("product", [], fullCaps);
  const row: BulkRow = {
    id: PRODUCT_ID,
    type: "product",
    title: "Vase",
    seoTitle: "",
    seoDescription: "",
    handle: "vase",
    category: CATEGORY,
    categoryName: "Home & Garden > Decor > Vases",
    collectionMemberships: [{ collectionId: SALE, collectionTitle: "Sale", automated: false }],
  };

  it("names the cached category and the memberships instead of printing GIDs", async () => {
    const { pickerDisplayValue } = await import("~/services/bulk-editor/columns.shared");
    const cat = cols.find((c) => c.id === CATEGORY_COLUMN_ID)!;
    const coll = cols.find((c) => c.id === COLLECTIONS_COLUMN_ID)!;
    expect(pickerDisplayValue(row, cat, CATEGORY)).toBe("Home & Garden > Decor > Vases");
    expect(pickerDisplayValue(row, coll, SALE)).toBe("Sale");
  });

  it("keeps an id it cannot name as the id — never a blank that reads as 'none'", async () => {
    const { pickerDisplayValue } = await import("~/services/bulk-editor/columns.shared");
    const coll = cols.find((c) => c.id === COLLECTIONS_COLUMN_ID)!;
    expect(pickerDisplayValue(row, coll, `${SALE},${WINTER}`)).toBe(`Sale, ${WINTER}`);
  });
});

describe("the membership refusal message", () => {
  it("gives a rule-based and an unmeasured collection their OWN reason", async () => {
    // One sentence for both told merchants their manual collection was
    // rule-based, and sent them looking for a rule that does not exist.
    const { admin } = mockAdmin({ collections: [] });
    const db = mockDb();
    db.collection.findMany.mockResolvedValueOnce([
      { id: SALE, title: "Sale", isSmart: false, attributesSyncedAt: new Date() },
      // Never attribute-synced: its `false` is a migration default.
      { id: WINTER, title: "Winter", isSmart: false, attributesSyncedAt: null as unknown as Date },
      { id: SMART, title: "Bestseller", isSmart: true, attributesSyncedAt: new Date() },
    ]);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      // Leaves SMART (refused: rule-based) and joins WINTER (refused: unknown).
      [entry(COLLECTIONS_COLUMN_ID, canonicalCollectionIds([SALE, WINTER]))],
    );

    const message = result.failures.find((f) => f.columnId === COLLECTIONS_COLUMN_ID)!.message;
    expect(message).toMatch(/"Bestseller" — a rule-based collection/);
    expect(message).toMatch(/"Winter" — not loaded from Shopify yet/);
  });
});

describe("the echo rule for the picker halves", () => {
  it("does NOT wipe the cached category when Shopify echoed no category", async () => {
    // `product: null` with no userErrors confirms nothing; mirroring it as
    // "no category" would show "Not set" for a product that still has one.
    const calls: RecordedCall[] = [];
    const admin = {
      graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
        calls.push({ query, variables: opts?.variables });
        return {
          json: async () => ({ data: { productUpdate: { product: null, userErrors: [] } } }),
        } as unknown as Response;
      },
    };
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(CATEGORY_COLUMN_ID, CATEGORY)],
    );

    const mirrored = (db.product.update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect("categoryId" in mirrored).toBe(false);
    expect(result.failures.map((f) => f.columnId)).toEqual([CATEGORY_COLUMN_ID]);
  });

  it("keeps BOTH reasons on the collections cell when the mutation then fails", async () => {
    // The grid keys failures by cell — a second entry would replace the first
    // and the merchant would lose either why a collection was kept or why the
    // save failed.
    const admin = {
      graphql: async () =>
        ({
          json: async () => ({
            data: { productUpdate: { product: null, userErrors: [{ field: ["title"], message: "Title is bad." }] } },
          }),
        }) as unknown as Response,
    };
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      // Leaves SMART (refused) and joins WINTER (sent, then the whole call fails).
      [entry(COLLECTIONS_COLUMN_ID, canonicalCollectionIds([SALE, WINTER]))],
    );

    const onCell = result.failures.filter((f) => f.columnId === COLLECTIONS_COLUMN_ID);
    expect(onCell).toHaveLength(1);
    expect(onCell[0].message).toContain("Bestseller");
    expect(onCell[0].message).toContain("Title is bad.");
  });
});
