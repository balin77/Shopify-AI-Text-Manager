import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyBulkDiff } from "~/services/bulk-editor/apply.server";
import {
  BULK_COLUMNS_BY_TYPE,
  resolveCellValue,
  estimateCalls,
  COMMERCE_BLOCK_COLUMNS,
  INVENTORY_ITEM_COLUMN_IDS,
  VAR_PRICE_COLUMN_ID,
  VAR_COST_COLUMN_ID,
  VAR_TAXABLE_COLUMN_ID,
  VAR_INVENTORY_POLICY_COLUMN_ID,
  VAR_INVENTORY_TRACKED_COLUMN_ID,
  VAR_WEIGHT_COLUMN_ID,
  VAR_WEIGHT_UNIT_COLUMN_ID,
  VAR_REQUIRES_SHIPPING_COLUMN_ID,
  VAR_COUNTRY_OF_ORIGIN_COLUMN_ID,
  VAR_HS_CODE_COLUMN_ID,
  type BulkDiffEntry,
  type BulkRow,
  type BulkRowType,
  type ColumnDescriptor,
} from "~/services/bulk-editor/columns.shared";

/**
 * The §Phase 4 commerce block in the GRID.
 *
 * The single editor's variants card has had fourteen fields since Phase 4; the
 * grid had four of them. What makes this more than "nine more columns" is that
 * the block spans TWO Shopify objects: `taxable` and `inventoryPolicy` are the
 * variant's own and ride the existing `productVariantsBulkUpdate`, while cost,
 * the weight, the customs fields and `tracked` live on the variant's
 * InventoryItem and need `inventoryItemUpdate` — one call per variant, because
 * Shopify offers no bulk form of it.
 *
 * The QUANTITY is deliberately absent and that is tested too: a stock level is
 * a claim about a moment, and a grid cell fed from a cache cannot make the
 * `compareQuantity` promise the editor's panel makes.
 */

const SHOP = "test-shop.myshopify.com";
const PRODUCT_A = "gid://shopify/Product/1";
const V1 = "gid://shopify/ProductVariant/11";
const V2 = "gid://shopify/ProductVariant/12";
const ITEM_1 = "gid://shopify/InventoryItem/91";
const ITEM_2 = "gid://shopify/InventoryItem/92";

const columnsByType = Object.fromEntries(
  (Object.keys(BULK_COLUMNS_BY_TYPE) as BulkRowType[]).map((t) => [t, BULK_COLUMNS_BY_TYPE[t]]),
) as Record<BulkRowType, ColumnDescriptor[]>;

interface RecordedCall {
  query: string;
  variables: Record<string, unknown> | undefined;
}

function mockAdmin(respond?: (query: string, variables: Record<string, unknown> | undefined) => unknown) {
  const calls: RecordedCall[] = [];
  const admin = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const variables = opts?.variables;
      calls.push({ query, variables });
      const overridden = respond?.(query, variables);
      const data = overridden !== undefined ? overridden : defaultResponse(query, variables);
      return { json: async () => data } as unknown as Response;
    },
  };
  return { admin, calls };
}

function defaultResponse(query: string, variables: Record<string, unknown> | undefined): unknown {
  if (query.includes("productVariantsBulkUpdate(")) {
    const variants = (variables?.variants ?? []) as {
      id: string;
      price?: string;
      compareAtPrice?: string | null;
      barcode?: string | null;
      taxable?: boolean;
      inventoryPolicy?: string;
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
            // Echo the two variant-level commerce fields back, like Shopify.
            taxable: v.taxable === undefined ? null : v.taxable,
            inventoryPolicy: v.inventoryPolicy ?? null,
          })),
          userErrors: [],
        },
      },
    };
  }
  if (query.includes("inventoryItemUpdate(")) {
    const input = (variables?.input ?? {}) as {
      cost?: string | null;
      tracked?: boolean;
      requiresShipping?: boolean;
      harmonizedSystemCode?: string | null;
      countryCodeOfOrigin?: string | null;
      measurement?: { weight?: { value: number; unit: string } };
    };
    return {
      data: {
        inventoryItemUpdate: {
          inventoryItem: {
            id: variables?.id,
            // Shopify normalises money — "4.5" comes back "4.50", which is
            // exactly why the mirror reads the echo and not what was sent.
            unitCost: input.cost == null ? null : { amount: Number(input.cost).toFixed(2) },
            tracked: input.tracked ?? true,
            sku: null,
            requiresShipping: input.requiresShipping ?? true,
            countryCodeOfOrigin: input.countryCodeOfOrigin ?? null,
            harmonizedSystemCode: input.harmonizedSystemCode ?? null,
            measurement: input.measurement ?? null,
          },
          userErrors: [],
        },
      },
    };
  }
  throw new Error(`Unexpected query in test: ${query.slice(0, 120)}`);
}

/** The cache rows both passes read: ownership for the grouping, and the
 *  InventoryItem address plus the weight pair for the second pass. */
function mockDb(
  rows: Record<string, { productId: string; inventoryItemId: string | null; weight?: string | null; weightUnit?: string | null }> = {
    [V1]: { productId: PRODUCT_A, inventoryItemId: ITEM_1, weight: "1.5", weightUnit: "KILOGRAMS" },
    [V2]: { productId: PRODUCT_A, inventoryItemId: ITEM_2, weight: null, weightUnit: null },
  },
) {
  return {
    productVariant: {
      findMany: vi.fn(async (args: { where: { shopifyGid: { in: string[] } } }) =>
        args.where.shopifyGid.in
          .filter((gid) => rows[gid])
          .map((gid) => ({
            // The NUMERIC id, which is what the commerce mirror is keyed by.
            id: gid.split("/").pop()!,
            shopifyGid: gid,
            productId: rows[gid].productId,
            inventoryItemId: rows[gid].inventoryItemId,
            weight: rows[gid].weight ?? null,
            weightUnit: rows[gid].weightUnit ?? null,
          })),
      ),
      updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
    },
  };
}

function entry(rowId: string, columnId: string, value: string): BulkDiffEntry {
  return { rowId, rowType: "variant", locale: "", marketId: "", columnId, value };
}

function inventoryCall(calls: RecordedCall[]) {
  return calls.find((c) => c.query.includes("inventoryItemUpdate("));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── The column universe ───────────────────────────────────────────────────

describe("the variant commerce columns", () => {
  const ids = BULK_COLUMNS_BY_TYPE.variant.map((c) => c.id);

  it("offers every field of the single editor's variants card except the quantity", () => {
    // A stock level is a claim about a MOMENT: the editor reads it live and
    // writes it with `compareQuantity` against the number the merchant was
    // looking at, so a value that moved under their feet is refused rather than
    // overwritten. A grid cell fed from a cache cannot promise that, and
    // "cached + typed number" is the classic source of inventory drift.
    expect(ids).toEqual(
      expect.arrayContaining([
        VAR_COST_COLUMN_ID,
        VAR_TAXABLE_COLUMN_ID,
        VAR_INVENTORY_POLICY_COLUMN_ID,
        VAR_INVENTORY_TRACKED_COLUMN_ID,
        VAR_WEIGHT_COLUMN_ID,
        VAR_WEIGHT_UNIT_COLUMN_ID,
        VAR_REQUIRES_SHIPPING_COLUMN_ID,
        VAR_COUNTRY_OF_ORIGIN_COLUMN_ID,
        VAR_HS_CODE_COLUMN_ID,
      ]),
    );
    expect(ids.some((id) => /quantity|onHand|stock/i.test(id))).toBe(false);
  });

  it("keeps price, compare-at, SKU and barcode OUT of the commerce block", () => {
    // They predate `commerceSyncedAt` and come from the ordinary product sync,
    // so gating them on it would lock four working columns.
    expect(COMMERCE_BLOCK_COLUMNS.has(VAR_PRICE_COLUMN_ID)).toBe(false);
    expect(COMMERCE_BLOCK_COLUMNS.has(VAR_COST_COLUMN_ID)).toBe(true);
  });

  it("splits the block by which Shopify object holds the value", () => {
    // The two that are the VARIANT's own ride the existing bulk update; the
    // rest need `inventoryItemUpdate`, which is addressed by an InventoryItem
    // GID a variant may not have.
    expect(INVENTORY_ITEM_COLUMN_IDS.has(VAR_TAXABLE_COLUMN_ID)).toBe(false);
    expect(INVENTORY_ITEM_COLUMN_IDS.has(VAR_INVENTORY_POLICY_COLUMN_ID)).toBe(false);
    expect(INVENTORY_ITEM_COLUMN_IDS.has(VAR_COST_COLUMN_ID)).toBe(true);
    expect(INVENTORY_ITEM_COLUMN_IDS.has(VAR_WEIGHT_COLUMN_ID)).toBe(true);
  });

  it("gives every boolean and enum column its vocabulary", () => {
    // A select with no options renders as an empty dropdown, which is a control
    // whose next save clears a working value.
    for (const column of BULK_COLUMNS_BY_TYPE.variant) {
      if (column.inputType !== "select") continue;
      expect(column.selectOptions, column.id).toBeDefined();
      expect(column.selectOptions!.length, column.id).toBeGreaterThan(0);
    }
  });
});

// ─── The commerceSyncedAt gate ─────────────────────────────────────────────

describe("a variant row that was never commerce-synced", () => {
  const column = (id: string) => BULK_COLUMNS_BY_TYPE.variant.find((c) => c.id === id)!;

  const row = (over: Partial<BulkRow> = {}): BulkRow => ({
    id: V1,
    type: "variant",
    title: "S / Blau",
    seoTitle: "",
    seoDescription: "",
    handle: "",
    price: "19.90",
    cost: "",
    taxable: "",
    inventoryItemId: ITEM_1,
    commerceKnown: true,
    ...over,
  });

  it("locks the whole block, and says which half needs resyncing", () => {
    // `taxable` is the quietly expensive one: rendered as "no" and saved along
    // with a neighbouring cell, it stops charging tax on a product that owes
    // it.
    const cell = resolveCellValue(row({ commerceKnown: false }), column(VAR_TAXABLE_COLUMN_ID));
    expect(cell.editable).toBe(false);
    expect(cell.readOnlyReason).toBe("commerceNotSynced");
  });

  it("leaves the PRICE editable — a different block, a different sync", () => {
    const cell = resolveCellValue(row({ commerceKnown: false }), column(VAR_PRICE_COLUMN_ID));
    expect(cell).toEqual({ value: "19.90", editable: true });
  });

  it("locks the InventoryItem columns of a variant with no inventory item", () => {
    const cell = resolveCellValue(row({ inventoryItemId: undefined }), column(VAR_COST_COLUMN_ID));
    expect(cell.editable).toBe(false);
    expect(cell.readOnlyReason).toBe("missingInventoryItem");
  });

  it("leaves the variant's OWN commerce columns editable without one", () => {
    // `taxable` and `inventoryPolicy` are written on the variant, so a missing
    // InventoryItem says nothing about them.
    const cell = resolveCellValue(row({ inventoryItemId: undefined }), column(VAR_TAXABLE_COLUMN_ID));
    expect(cell).toEqual({ value: "", editable: true });
  });
});

// ─── The call estimate ─────────────────────────────────────────────────────

describe("estimateCalls", () => {
  it("adds one inventoryItemUpdate per variant that touches the item half", () => {
    // Shopify has no bulk form of that mutation, so a 200-row save of cost
    // prices is 200 calls on top of the one bulk update — the fan-out this
    // guard exists to notice before MAX_TASK_CALLS is blown past.
    const opts = { variantProductIdByRowId: { [V1]: PRODUCT_A, [V2]: PRODUCT_A } };
    const pricesOnly = estimateCalls(
      [entry(V1, VAR_PRICE_COLUMN_ID, "1"), entry(V2, VAR_PRICE_COLUMN_ID, "2")],
      BULK_COLUMNS_BY_TYPE.variant,
      opts,
    );
    expect(pricesOnly).toBe(1);

    const withCost = estimateCalls(
      [entry(V1, VAR_COST_COLUMN_ID, "1"), entry(V2, VAR_COST_COLUMN_ID, "2")],
      BULK_COLUMNS_BY_TYPE.variant,
      opts,
    );
    expect(withCost).toBe(3);
  });

  it("counts a variant's several item cells as ONE call", () => {
    const calls = estimateCalls(
      [
        entry(V1, VAR_COST_COLUMN_ID, "1"),
        entry(V1, VAR_WEIGHT_COLUMN_ID, "2"),
        entry(V1, VAR_HS_CODE_COLUMN_ID, "6109"),
      ],
      BULK_COLUMNS_BY_TYPE.variant,
      { variantProductIdByRowId: { [V1]: PRODUCT_A } },
    );
    expect(calls).toBe(2);
  });
});

// ─── Writing them ──────────────────────────────────────────────────────────

describe("applyBulkDiff — the variant's OWN commerce fields", () => {
  it("sends taxable and inventoryPolicy in the bulk update and mirrors the echo", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_TAXABLE_COLUMN_ID, "false"), entry(V1, VAR_INVENTORY_POLICY_COLUMN_ID, "CONTINUE")],
    );

    expect(result.failures).toEqual([]);
    const sent = (calls.find((c) => c.query.includes("productVariantsBulkUpdate("))!.variables
      ?.variants ?? []) as Record<string, unknown>[];
    expect(sent[0].taxable).toBe(false);
    expect(sent[0].inventoryPolicy).toBe("CONTINUE");
    // No second mutation: neither field lives on the InventoryItem.
    expect(inventoryCall(calls)).toBeUndefined();

    const mirrored = (db.productVariant.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data;
    expect(mirrored.taxable).toBe(false);
    expect(mirrored.inventoryPolicy).toBe("CONTINUE");
  });

  it("refuses a stock policy outside the enum PER CELL", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_INVENTORY_POLICY_COLUMN_ID, "SOMETIMES"), entry(V1, VAR_PRICE_COLUMN_ID, "19.90")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(VAR_INVENTORY_POLICY_COLUMN_ID);
    // Dropped rather than forwarded: a bad enum fails at the SCHEMA level,
    // where `userErrors` never sees it and the whole call reads as a success.
    const sent = (calls.find((c) => c.query.includes("productVariantsBulkUpdate("))!.variables
      ?.variants ?? []) as Record<string, unknown>[];
    expect(sent[0].inventoryPolicy).toBeUndefined();
    expect(sent[0].price).toBe("19.90");
  });
});

describe("applyBulkDiff — the InventoryItem half", () => {
  it("writes cost through inventoryItemUpdate and mirrors Shopify's rounding", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_COST_COLUMN_ID, "4.5")],
    );

    expect(result.failures).toEqual([]);
    const call = inventoryCall(calls)!;
    expect(call.variables?.id).toBe(ITEM_1);
    expect((call.variables?.input as Record<string, unknown>).cost).toBe("4.50");
    // The mirror comes from the ECHO, so it holds what the shop stored.
    const mirrors = db.productVariant.updateMany.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(mirrors.some((m) => m.cost === "4.50")).toBe(true);
  });

  it("is ONE call per variant, not per product", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    await applyBulkDiff({ db: db as never, shop: SHOP, admin: admin as never, columnsByType }, [
      entry(V1, VAR_COST_COLUMN_ID, "1.00"),
      entry(V2, VAR_COST_COLUMN_ID, "2.00"),
    ]);

    // `inventoryItemUpdate` is addressed by a single InventoryItem GID —
    // Shopify offers no bulk form, which is what `estimateCalls` counts.
    const itemCalls = calls.filter((c) => c.query.includes("inventoryItemUpdate("));
    expect(itemCalls).toHaveLength(2);
    expect(itemCalls.map((c) => c.variables?.id).sort()).toEqual([ITEM_1, ITEM_2]);
    // …while the variants' own fields still collapse into one call per product.
    expect(calls.filter((c) => c.query.includes("productVariantsBulkUpdate("))).toHaveLength(0);
  });

  it("completes a half-changed weight from the CACHED row", async () => {
    // Shopify REPLACES the measurement rather than merging into it, so "change
    // only the value" is not an operation that exists. The unit comes from the
    // cached row — which is the value the merchant was looking at in the
    // neighbouring cell.
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_WEIGHT_COLUMN_ID, "2.25")],
    );

    expect(result.failures).toEqual([]);
    const input = inventoryCall(calls)!.variables?.input as {
      measurement?: { weight?: { value: number; unit: string } };
    };
    expect(input.measurement?.weight).toEqual({ value: 2.25, unit: "KILOGRAMS" });
  });

  it("takes the VALUE from the cache when only the unit changed", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    await applyBulkDiff({ db: db as never, shop: SHOP, admin: admin as never, columnsByType }, [
      entry(V1, VAR_WEIGHT_UNIT_COLUMN_ID, "GRAMS"),
    ]);

    const input = inventoryCall(calls)!.variables?.input as {
      measurement?: { weight?: { value: number; unit: string } };
    };
    expect(input.measurement?.weight).toEqual({ value: 1.5, unit: "GRAMS" });
  });

  it("refuses a weight the cache cannot complete, rather than sending half of one", async () => {
    // A number with no unit is not a weight, and `WeightUnit` is an ENUM — a
    // missing one fails at the schema level.
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V2, VAR_WEIGHT_COLUMN_ID, "2")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(VAR_WEIGHT_COLUMN_ID);
    expect(result.failures[0].message).toContain("unit");
    expect(inventoryCall(calls)).toBeUndefined();
  });

  it("saves both halves when the merchant filled both cells", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V2, VAR_WEIGHT_COLUMN_ID, "500"), entry(V2, VAR_WEIGHT_UNIT_COLUMN_ID, "GRAMS")],
    );

    expect(result.failures).toEqual([]);
    const input = inventoryCall(calls)!.variables?.input as {
      measurement?: { weight?: { value: number; unit: string } };
    };
    expect(input.measurement?.weight).toEqual({ value: 500, unit: "GRAMS" });
  });

  it("refuses a country code that is not two letters, on its own cell", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_COUNTRY_OF_ORIGIN_COLUMN_ID, "Germany")],
    );

    // `CountryCode` is an enum: forwarding "Germany" fails at the schema level,
    // where the whole call reads as a success while nothing was written.
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(VAR_COUNTRY_OF_ORIGIN_COLUMN_ID);
    expect(inventoryCall(calls)).toBeUndefined();
  });

  it("fails every item cell it sent when Shopify refuses the call", async () => {
    // `inventoryItemUpdate` applies as a unit, so per-cell attribution here
    // means "every cell that went with it" — the same semantics the variant
    // bulk update reports for an atomic refusal.
    const { admin } = mockAdmin((query) => {
      if (query.includes("inventoryItemUpdate(")) {
        return {
          data: { inventoryItemUpdate: { inventoryItem: null, userErrors: [{ message: "Nope." }] } },
        };
      }
      return undefined;
    });
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_COST_COLUMN_ID, "1.00"), entry(V1, VAR_HS_CODE_COLUMN_ID, "6109")],
    );

    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((f) => f.columnId).sort()).toEqual(
      [VAR_COST_COLUMN_ID, VAR_HS_CODE_COLUMN_ID].sort(),
    );
    // Shopify's own words, not a generic code — the grid marks cells, and a
    // merchant needs to know why.
    expect(result.failures[0].message).toBe("Nope.");
  });

  it("refuses the item half for a variant with no inventory item, naming the resync", async () => {
    // The grid renders these cells read-only without one, so this is the
    // direct-POST / CSV entrance.
    const { admin, calls } = mockAdmin();
    const db = mockDb({ [V1]: { productId: PRODUCT_A, inventoryItemId: null } });

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [entry(V1, VAR_COST_COLUMN_ID, "1.00")],
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].columnId).toBe(VAR_COST_COLUMN_ID);
    expect(result.failures[0].message).toContain("Resync");
    expect(inventoryCall(calls)).toBeUndefined();
  });

  it("runs BOTH passes for a save that touches both objects", async () => {
    const { admin, calls } = mockAdmin();
    const db = mockDb();

    const result = await applyBulkDiff(
      { db: db as never, shop: SHOP, admin: admin as never, columnsByType },
      [
        entry(V1, VAR_PRICE_COLUMN_ID, "19.90"),
        entry(V1, VAR_TAXABLE_COLUMN_ID, "true"),
        entry(V1, VAR_COST_COLUMN_ID, "8.00"),
        entry(V1, VAR_INVENTORY_TRACKED_COLUMN_ID, "false"),
        entry(V1, VAR_REQUIRES_SHIPPING_COLUMN_ID, "false"),
      ],
    );

    expect(result.failures).toEqual([]);
    expect(calls.filter((c) => c.query.includes("productVariantsBulkUpdate("))).toHaveLength(1);
    expect(calls.filter((c) => c.query.includes("inventoryItemUpdate("))).toHaveLength(1);
    const input = inventoryCall(calls)!.variables?.input as Record<string, unknown>;
    expect(input.cost).toBe("8.00");
    expect(input.tracked).toBe(false);
    expect(input.requiresShipping).toBe(false);
    // `taxable` is the variant's, so it must NOT be in the item input.
    expect("taxable" in input).toBe(false);
  });
});
