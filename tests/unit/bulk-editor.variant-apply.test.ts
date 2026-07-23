import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import {
  BULK_COLUMNS_BY_TYPE,
  VAR_SKU_COLUMN_ID,
  VAR_PRICE_COLUMN_ID,
  VAR_COMPARE_AT_COLUMN_ID,
  VAR_BARCODE_COLUMN_ID,
  type BulkDiffEntry,
  type BulkRowType,
  type ColumnDescriptor,
} from "~/services/bulk-editor/columns.shared";

/**
 * Mock-gateway tests for the Phase-3 variant persistence (Plan §5.4/§14/§12):
 * ONE productVariantsBulkUpdate per PRODUCT, userErrors field-path ARRAY
 * resolution to the exact cell, price-not-nullable vs. compareAtPrice-null
 * semantics, and the echo mirror into the DB cache.
 */

const SHOP = "test-shop.myshopify.com";
const PRODUCT_A = "gid://shopify/Product/1";
const PRODUCT_B = "gid://shopify/Product/2";
const V1 = "gid://shopify/ProductVariant/11";
const V2 = "gid://shopify/ProductVariant/12";
const V3 = "gid://shopify/ProductVariant/21";

const columnsByType = Object.fromEntries(
  (Object.keys(BULK_COLUMNS_BY_TYPE) as BulkRowType[]).map((t) => [t, BULK_COLUMNS_BY_TYPE[t]]),
) as Record<BulkRowType, ColumnDescriptor[]>;

interface RecordedCall {
  query: string;
  variables: Record<string, unknown> | undefined;
}

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

/** Default: echo every sent variant back verbatim (success shape). */
function defaultResponse(query: string, variables: Record<string, unknown> | undefined): unknown {
  if (query.includes("productVariantsBulkUpdate(")) {
    const variants = (variables?.variants ?? []) as {
      id: string;
      price?: string;
      compareAtPrice?: string | null;
      barcode?: string | null;
      inventoryItem?: { sku: string };
    }[];
    return {
      data: {
        productVariantsBulkUpdate: {
          productVariants: variants.map((v) => ({
            id: v.id,
            sku: v.inventoryItem?.sku ?? "KEEP",
            price: v.price ?? "10.0",
            compareAtPrice: v.compareAtPrice === undefined ? null : v.compareAtPrice,
            barcode: v.barcode ?? null,
          })),
          userErrors: [],
        },
      },
    };
  }
  throw new Error(`Unexpected query in test: ${query.slice(0, 120)}`);
}

function mockDb(ownership: Record<string, string> = { [V1]: PRODUCT_A, [V2]: PRODUCT_A, [V3]: PRODUCT_B }) {
  return {
    productVariant: {
      findMany: vi.fn(async (args: { where: { shopifyGid: { in: string[] } } }) =>
        args.where.shopifyGid.in
          .filter((gid) => ownership[gid])
          .map((gid) => ({ shopifyGid: gid, productId: ownership[gid] })),
      ),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
    },
  };
}

function entry(rowId: string, columnId: string, value: string): BulkDiffEntry {
  return { rowId, rowType: "variant", locale: "", marketId: "", columnId, value };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("applyBulkDiff — variant rows group to ONE call per product (Plan §5.4)", () => {
  it("collapses variant rows of the same product into one productVariantsBulkUpdate", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [
        entry(V1, VAR_PRICE_COLUMN_ID, "19.90"),
        entry(V2, VAR_SKU_COLUMN_ID, "NEW-SKU"),
        entry(V3, VAR_PRICE_COLUMN_ID, "5.00"),
      ],
    );

    expect(result.failures).toEqual([]);
    expect(result.saved).toBe(3);

    const bulkCalls = calls.filter((c) => c.query.includes("productVariantsBulkUpdate("));
    expect(bulkCalls).toHaveLength(2);
    const byProduct = new Map(bulkCalls.map((c) => [c.variables?.productId as string, c.variables?.variants as unknown[]]));
    expect((byProduct.get(PRODUCT_A) ?? []).length).toBe(2);
    expect((byProduct.get(PRODUCT_B) ?? []).length).toBe(1);
  });

  it("sends only the CHANGED fields; SKU goes through inventoryItem (Plan §5.4)", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    await applyBulkDiff({ db: db as never, shop: SHOP, admin: admin as never, columnsByType }, [
      entry(V1, VAR_SKU_COLUMN_ID, "SK-001"),
      entry(V1, VAR_PRICE_COLUMN_ID, "49.90"),
    ]);

    const call = calls.find((c) => c.query.includes("productVariantsBulkUpdate("));
    const input = (call?.variables?.variants as Record<string, unknown>[])[0];
    expect(input).toEqual({ id: V1, price: "49.90", inventoryItem: { sku: "SK-001" } });
    // inventoryQuantity is NEVER part of the input (§11).
    expect(JSON.stringify(call?.variables)).not.toContain("inventoryQuantity");
  });

  it("clears compareAtPrice with an explicit null; clearing price is a CELL error (§14)", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_COMPARE_AT_COLUMN_ID, ""), entry(V2, VAR_PRICE_COLUMN_ID, "")],
    );

    // V1: compareAtPrice → null went out; V2: price clear failed pre-flight.
    const call = calls.find((c) => c.query.includes("productVariantsBulkUpdate("));
    const variants = call?.variables?.variants as Record<string, unknown>[];
    expect(variants).toHaveLength(1);
    expect(variants[0]).toEqual({ id: V1, compareAtPrice: null });

    expect(result.saved).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ rowId: V2, columnId: VAR_PRICE_COLUMN_ID });
    expect(result.failures[0].message).toContain("cannot be empty");
  });

  it("rejects unparseable and negative money input as cell errors without calling Shopify", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_PRICE_COLUMN_ID, "abc"), entry(V2, VAR_COMPARE_AT_COLUMN_ID, "-5")],
    );

    expect(calls.some((c) => c.query.includes("productVariantsBulkUpdate("))).toBe(false);
    expect(result.saved).toBe(0);
    const byCell = new Map(result.failures.map((f) => [`${f.rowId}|${f.columnId}`, f.message]));
    expect(byCell.get(`${V1}|${VAR_PRICE_COLUMN_ID}`)).toContain("not a valid amount");
    expect(byCell.get(`${V2}|${VAR_COMPARE_AT_COLUMN_ID}`)).toContain("negative");
  });
});

describe("applyBulkDiff — variant userErrors field ARRAY resolution (§14 no. 1)", () => {
  it('lands ["variants","1","price"] on the SECOND variant\'s price cell', async () => {
    const { admin } = mockAdmin({
      respond: (query) =>
        query.includes("productVariantsBulkUpdate(")
          ? {
              data: {
                productVariantsBulkUpdate: {
                  productVariants: null,
                  userErrors: [{ field: ["variants", "1", "price"], message: "Price is invalid" }],
                },
              },
            }
          : undefined,
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_PRICE_COLUMN_ID, "10.00"), entry(V2, VAR_PRICE_COLUMN_ID, "20.00")],
    );

    expect(result.saved).toBe(0);
    const byCell = new Map(result.failures.map((f) => [`${f.rowId}|${f.columnId}`, f.message]));
    // Named index → the exact cell gets the real message…
    expect(byCell.get(`${V2}|${VAR_PRICE_COLUMN_ID}`)).toBe("Price is invalid");
    // …the sibling gets the atomicity explanation.
    expect(byCell.get(`${V1}|${VAR_PRICE_COLUMN_ID}`)).toContain("atomically");
    // Nothing mirrored on userErrors.
    expect(db.productVariant.updateMany).not.toHaveBeenCalled();
  });

  it("resolves the inventoryItem.sku path to the SKU cell and tolerates the dot-string form", async () => {
    const { admin } = mockAdmin({
      respond: (query) =>
        query.includes("productVariantsBulkUpdate(")
          ? {
              data: {
                productVariantsBulkUpdate: {
                  productVariants: null,
                  userErrors: [{ field: "variants.0.inventoryItem.sku", message: "SKU already taken" }],
                },
              },
            }
          : undefined,
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_SKU_COLUMN_ID, "DUP")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ rowId: V1, columnId: VAR_SKU_COLUMN_ID, message: "SKU already taken" });
  });
});

describe("applyBulkDiff — variant echo mirror (Plan §5.4)", () => {
  it("mirrors ONLY echoed values into the DB (normalized), keyed by shopifyGid", async () => {
    const { admin } = mockAdmin({
      respond: (query) =>
        query.includes("productVariantsBulkUpdate(")
          ? {
              data: {
                productVariantsBulkUpdate: {
                  productVariants: [
                    { id: V1, sku: "KEEP", price: "19.9", compareAtPrice: null, barcode: null },
                  ],
                  userErrors: [],
                },
              },
            }
          : undefined,
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_PRICE_COLUMN_ID, "19.90"), entry(V1, VAR_BARCODE_COLUMN_ID, "4006381333931")],
    );

    expect(result.failures).toEqual([]);
    expect(db.productVariant.updateMany).toHaveBeenCalledTimes(1);
    const args = db.productVariant.updateMany.mock.calls[0][0] as unknown as {
      where: unknown;
      data: Record<string, unknown>;
    };
    expect(args.where).toEqual({ shopifyGid: V1 });
    // Echo values (normalized) — not the sent ones; only the sent FIELDS.
    expect(args.data).toEqual({ price: "19.90", barcode: null });
  });

  it("fails the cells when Shopify does not echo the variant back (silent no-op guard)", async () => {
    const { admin } = mockAdmin({
      respond: (query) =>
        query.includes("productVariantsBulkUpdate(")
          ? { data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } }
          : undefined,
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_PRICE_COLUMN_ID, "19.90")],
    );

    expect(result.saved).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toContain("did not confirm");
    expect(db.productVariant.updateMany).not.toHaveBeenCalled();
  });

  it("fails a variant that is not in the local cache (tenancy/resync guard) without a mutation", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb({}); // nothing owned

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_PRICE_COLUMN_ID, "19.90")],
    );

    expect(calls.some((c) => c.query.includes("productVariantsBulkUpdate("))).toBe(false);
    expect(result.saved).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].message).toContain("resync");
  });
});
