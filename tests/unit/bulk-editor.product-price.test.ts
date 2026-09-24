import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import {
  buildColumnsForType,
  resolveCellValue,
  estimateCalls,
  PRODUCT_VARIANT_COLUMN_IDS,
  BULK_COLUMNS_BY_TYPE,
  VAR_PRICE_COLUMN_ID,
  VAR_COMPARE_AT_COLUMN_ID,
  VAR_SKU_COLUMN_ID,
  VAR_COST_COLUMN_ID,
  type BulkDiffEntry,
  type BulkRow,
  type BulkRowType,
  type ColumnDescriptor,
  type ProductColumnCaps,
} from "~/services/bulk-editor/columns.shared";

/**
 * The price on a PRODUCT row.
 *
 * A price belongs to a variant, which is why "where is the price column?" had
 * an answer that was correct and unhelpful at the same time. For the shop that
 * sells one thing per product the product IS its variant, so three of the
 * variant columns — price, compare-at price, SKU — appear on product rows and
 * edit that one variant through the same write path a variant row uses.
 *
 * What makes this safe is that "exactly one variant" is asked TWICE: the grid
 * renders the cell read-only without it, and the write path re-checks, because
 * it is also reached by direct POST and by CSV import and writing one of
 * several variants' prices is the one outcome that would be silently wrong.
 */

const SHOP = "test-shop.myshopify.com";
const PRODUCT_ID = "gid://shopify/Product/1";
const VARIANT_ID = "gid://shopify/ProductVariant/11";
const OTHER_VARIANT_ID = "gid://shopify/ProductVariant/12";

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

function mockAdmin() {
  const calls: RecordedCall[] = [];
  const admin = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const variables = opts?.variables;
      calls.push({ query, variables });
      if (query.includes("productVariantsBulkUpdate(")) {
        const variants = (variables?.variants ?? []) as {
          id: string;
          price?: string;
          compareAtPrice?: string | null;
          inventoryItem?: { sku: string };
        }[];
        return {
          json: async () => ({
            data: {
              productVariantsBulkUpdate: {
                productVariants: variants.map((v) => ({
                  id: v.id,
                  sku: v.inventoryItem?.sku ?? "KEEP",
                  price: v.price ?? "10.0",
                  compareAtPrice: v.compareAtPrice === undefined ? null : v.compareAtPrice,
                  barcode: null,
                  taxable: null,
                  inventoryPolicy: null,
                })),
                userErrors: [],
              },
            },
          }),
        } as unknown as Response;
      }
      if (query.includes("productUpdate(")) {
        return {
          json: async () => ({
            data: {
              productUpdate: {
                product: { id: PRODUCT_ID, handle: "h", tags: [], templateSuffix: null },
                userErrors: [],
              },
            },
          }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected query in test: ${query.slice(0, 100)}`);
    },
  };
  return { admin, calls };
}

function mockDb(variantGids: string[] = [VARIANT_ID]) {
  return {
    product: {
      findUnique: vi.fn(async () => ({ seoTitle: "old", seoDescription: "old" })),
      update: vi.fn(async (_args?: unknown) => ({})),
    },
    productVariant: {
      findMany: vi.fn(async (args: { take?: number }) =>
        variantGids.slice(0, args.take ?? variantGids.length).map((gid) => ({
          shopifyGid: gid,
          id: gid.split("/").pop()!,
          productId: PRODUCT_ID,
        })),
      ),
      updateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
    },
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

const productColumn = (id: string) =>
  buildColumnsForType("product", [], fullCaps).find((c) => c.id === id)!;

function productRow(over: Partial<BulkRow> = {}): BulkRow {
  return {
    id: PRODUCT_ID,
    type: "product",
    title: "Kumikobox",
    seoTitle: "",
    seoDescription: "",
    handle: "kumikobox",
    variantCount: 1,
    singleVariant: { id: VARIANT_ID, price: "49.90", compareAtPrice: "", sku: "KB-1" },
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── Which columns, and only which ─────────────────────────────────────────

describe("the product row's variant columns", () => {
  it("carries exactly price, compare-at price and SKU", () => {
    // Cost, customs and the stock policy stay on the variant rows: they are
    // per-variant settings a merchant goes looking for, not numbers they scan a
    // catalogue for.
    const ids = buildColumnsForType("product", [], fullCaps)
      .filter((c) => c.kind === "variant")
      .map((c) => c.id);
    expect(ids.sort()).toEqual([...PRODUCT_VARIANT_COLUMN_IDS].sort());
    expect(ids).not.toContain(VAR_COST_COLUMN_ID);
  });
});

// ─── Three states, none of them collapsed ──────────────────────────────────

describe("resolveCellValue — a price cell on a product row", () => {
  it("edits the ONE variant when there is exactly one", () => {
    expect(resolveCellValue(productRow(), productColumn(VAR_PRICE_COLUMN_ID))).toEqual({
      value: "49.90",
      editable: true,
    });
    expect(resolveCellValue(productRow(), productColumn(VAR_SKU_COLUMN_ID))).toEqual({
      value: "KB-1",
      editable: true,
    });
  });

  it("refuses to pick one of SEVERAL prices", () => {
    // Which price would the cell show, and which would a save overwrite? Either
    // choice is wrong, so the cell says what the situation is instead.
    const cell = resolveCellValue(
      productRow({ variantCount: 2, singleVariant: undefined }),
      productColumn(VAR_PRICE_COLUMN_ID),
    );
    expect(cell.editable).toBe(false);
    expect(cell.readOnlyReason).toBe("multipleVariants");
    expect(cell.value).toBe("");
  });

  it("tells an uncached product apart from a multi-variant one", () => {
    // Shopify gives every product at least one variant, so a count of zero is
    // the cache lacking them — a resync, not a restriction.
    const cell = resolveCellValue(
      productRow({ variantCount: 0, singleVariant: undefined }),
      productColumn(VAR_PRICE_COLUMN_ID),
    );
    expect(cell.readOnlyReason).toBe("variantsNotSynced");
  });

  it("reads SEVERAL off the cached options when the variants are not cached", () => {
    // The list reload caches options but no variants. An option with two
    // values proves several variants, and "reload to edit" would be an errand
    // that leaves the cell read-only anyway.
    const cell = resolveCellValue(
      productRow({
        variantCount: 0,
        singleVariant: undefined,
        options: [
          {
            id: "gid://shopify/ProductOption/1",
            position: 1,
            name: "Size",
            values: [
              { id: "gid://shopify/ProductOptionValue/1", name: "S" },
              { id: "gid://shopify/ProductOptionValue/2", name: "M" },
            ],
            hasValueIds: true,
            linked: false,
          },
        ],
      }),
      productColumn(VAR_PRICE_COLUMN_ID),
    );
    expect(cell.editable).toBe(false);
    expect(cell.readOnlyReason).toBe("multipleVariants");
  });
});

// ─── The call estimate ─────────────────────────────────────────────────────

describe("estimateCalls", () => {
  it("counts the three cells as ONE productVariantsBulkUpdate", () => {
    const columns = buildColumnsForType("product", [], fullCaps);
    const calls = estimateCalls(
      [
        entry(VAR_PRICE_COLUMN_ID, "9.90"),
        entry(VAR_COMPARE_AT_COLUMN_ID, "19.90"),
        entry(VAR_SKU_COLUMN_ID, "X"),
      ],
      columns,
    );
    expect(calls).toBe(1);
  });

  it("counts the variant write beside the product's own", () => {
    const columns = buildColumnsForType("product", [], fullCaps);
    const calls = estimateCalls(
      [entry("field.title", "New"), entry(VAR_PRICE_COLUMN_ID, "9.90")],
      columns,
    );
    // One productUpdate + one productVariantsBulkUpdate.
    expect(calls).toBe(2);
  });
});

// ─── Writing it ────────────────────────────────────────────────────────────

describe("applyBulkDiff — a product row's price", () => {
  it("writes the single variant through productVariantsBulkUpdate", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(VAR_PRICE_COLUMN_ID, "59.90"), entry(VAR_SKU_COLUMN_ID, "KB-2")],
    );

    expect(result.failures).toEqual([]);
    const call = calls.find((c) => c.query.includes("productVariantsBulkUpdate("))!;
    expect(call.variables?.productId).toBe(PRODUCT_ID);
    const sent = (call.variables?.variants ?? []) as Record<string, unknown>[];
    expect(sent).toHaveLength(1);
    // The mutation addresses the VARIANT, not the row id the cells came under.
    expect(sent[0].id).toBe(VARIANT_ID);
    expect(sent[0].price).toBe("59.90");
    expect(sent[0].inventoryItem).toEqual({ sku: "KB-2" });
  });

  it("marks a failure on the PRODUCT row, where the merchant typed", async () => {
    // The mutation is the variant's; the cell is the product's. The two ids
    // came apart for exactly this.
    const { admin } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      // "1.299" is genuinely ambiguous — 1299 to a German, 1.299 to an
      // American — and the money parser refuses it rather than repricing the
      // product by a factor of a thousand.
      [entry(VAR_PRICE_COLUMN_ID, "1.299")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].rowId).toBe(PRODUCT_ID);
    expect(result.failures[0].rowType).toBe("product");
    expect(result.failures[0].columnId).toBe(VAR_PRICE_COLUMN_ID);
  });

  it("REFUSES a multi-variant product, even though the grid never offers it", async () => {
    // This path is reached by direct POST and by CSV import too, and writing
    // one of several variants' prices is the one outcome that would be
    // silently wrong.
    const { admin, calls } = mockAdmin();
    const db = mockDb([VARIANT_ID, OTHER_VARIANT_ID]);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(VAR_PRICE_COLUMN_ID, "59.90")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(VAR_PRICE_COLUMN_ID);
    expect(result.failures[0].message).toContain("several variants");
    expect(calls.some((c) => c.query.includes("productVariantsBulkUpdate("))).toBe(false);
  });

  it("names the resync when the product has no cached variants", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb([]);

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(VAR_PRICE_COLUMN_ID, "59.90")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toContain("resync");
    expect(calls.some((c) => c.query.includes("productVariantsBulkUpdate("))).toBe(false);
  });

  it("still saves the product's own fields in the same row", async () => {
    // Two mutations, two stages, failures per cell — the fixed target-group
    // order gained a fifth member, not a new all-or-nothing.
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry("field.title", "Kumikobox II"), entry(VAR_PRICE_COLUMN_ID, "59.90")],
    );

    expect(result.failures).toEqual([]);
    expect(calls.some((c) => c.query.includes("productUpdate("))).toBe(true);
    expect(calls.some((c) => c.query.includes("productVariantsBulkUpdate("))).toBe(true);
  });

  it("mirrors the echo onto the VARIANT row, not the product row", async () => {
    const { admin } = mockAdmin();
    const db = mockDb();

    await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType: columnsByType() },
      [entry(VAR_PRICE_COLUMN_ID, "59.90")],
    );

    const mirror = db.productVariant.updateMany.mock.calls[0]![0] as {
      where: { shopifyGid: string };
      data: Record<string, unknown>;
    };
    expect(mirror.where.shopifyGid).toBe(VARIANT_ID);
    expect(mirror.data.price).toBe("59.90");
  });
});
