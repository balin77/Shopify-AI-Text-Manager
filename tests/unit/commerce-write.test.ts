/**
 * PLAN_CONTENT_CREATION Phase 4 — the stock write path.
 *
 * A quantity is money, so the echo rule is stricter here than anywhere else in
 * this app: a write counts as successful only when Shopify returns the NEW
 * QUANTITY and it matches what was asked for. `userErrors: []` is not enough,
 * and neither is "the mutation returned an object".
 */

import { describe, it, expect, vi } from "vitest";
import {
  applyInventoryItemFields,
  applyStockChanges,
  parseCountryCode,
  parseDecimal,
  parseQuantity,
  applyVariantPrices,
} from "../../app/services/commerce-write.server";

const ITEM = "gid://shopify/InventoryItem/1";
const LOC_A = "gid://shopify/Location/1";
const LOC_B = "gid://shopify/Location/2";

/** Minimal admin stub: one graphql() returning the given body. */
function adminWith(body: unknown) {
  return { graphql: vi.fn().mockResolvedValue({ json: async () => body }) } as never;
}

/** Records what the mirror wrote. */
function dbRecorder() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    db: {
      inventoryLevel: {
        updateMany: vi.fn(async (args: Record<string, unknown>) => {
          updates.push(args);
          return { count: 1 };
        }),
      },
    } as never,
  };
}

const change = (locationId: string, quantity: number, compareQuantity: number) => ({
  inventoryItemId: ITEM,
  locationId,
  quantity,
  compareQuantity,
});

const echo = (entries: Array<{ locationId: string; after: number; name?: string }>) => ({
  data: {
    inventorySetQuantities: {
      inventoryAdjustmentGroup: {
        changes: entries.map((e) => ({
          name: e.name ?? "on_hand",
          quantityAfterChange: e.after,
          item: { id: ITEM },
          location: { id: e.locationId },
        })),
      },
      userErrors: [],
    },
  },
});

describe("parseQuantity", () => {
  it("accepts a whole non-negative number", () => {
    expect(parseQuantity("0")).toBe(0);
    expect(parseQuantity(" 12 ")).toBe(12);
  });

  it("refuses anything that is not one", () => {
    // A bad scalar fails at the GraphQL SCHEMA level, which never reaches
    // `userErrors` — the call would read as a success while nothing was
    // written.
    expect(parseQuantity("3.5")).toBeNull();
    expect(parseQuantity("many")).toBeNull();
    expect(parseQuantity("-2")).toBeNull();
    expect(parseQuantity("")).toBeNull();
  });
});

describe("applyStockChanges", () => {
  it("sends compareQuantity and refuses to ignore it", async () => {
    // The whole safety property: without it a stale page silently overwrites
    // whatever happened in between.
    const admin = adminWith(echo([{ locationId: LOC_A, after: 12 }]));
    const { db } = dbRecorder();
    await applyStockChanges(admin, db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });

    const variables = (admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1];
    expect(variables.variables.input.ignoreCompareQuantity).toBe(false);
    expect(variables.variables.input.quantities[0]).toMatchObject({ compareQuantity: 9, quantity: 12 });
    // Only ever on_hand: `available` is derived from it minus open
    // commitments, and writing it directly would contradict them.
    expect(variables.variables.input.name).toBe("on_hand");
  });

  it("mirrors only what Shopify ECHOED", async () => {
    const admin = adminWith(echo([{ locationId: LOC_A, after: 12 }]));
    const { db, updates } = dbRecorder();
    const warning = await applyStockChanges(admin, db, "s", {
      variantId: "42",
      changes: [change(LOC_A, 12, 9)],
    });
    expect(warning).toBeUndefined();
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({ onHand: 12 });
  });

  it("refuses to mirror a quantity that came back DIFFERENT", async () => {
    // "no userErrors" has never meant "stored". Here Shopify answered with a
    // different number, and writing 12 into the cache would leave it claiming
    // stock the shop does not hold.
    const admin = adminWith(echo([{ locationId: LOC_A, after: 7 }]));
    const { db, updates } = dbRecorder();
    const warning = await applyStockChanges(admin, db, "s", {
      variantId: "42",
      changes: [change(LOC_A, 12, 9)],
    });
    expect(warning).toBe("stockNotConfirmed");
    expect(updates).toHaveLength(0);
  });

  it("mirrors the confirmed half of a partial apply and still warns", async () => {
    const admin = adminWith(echo([{ locationId: LOC_A, after: 12 }]));
    const { db, updates } = dbRecorder();
    const warning = await applyStockChanges(admin, db, "s", {
      variantId: "42",
      changes: [change(LOC_A, 12, 9), change(LOC_B, 4, 4)],
    });
    // A merchant who edited two locations and got one through should see that
    // one — and be told the other did not land.
    expect(updates).toHaveLength(1);
    expect(warning).toBe("stockNotConfirmed");
  });

  it("tells a STALE compare apart from a plain failure", async () => {
    // "someone else changed it" is actionable by reloading. Reading it as a
    // generic failure would invite a retry that overwrites the other change.
    //
    // The code is `COMPARE_QUANTITY_STALE`. This test used to feed whatever
    // string the implementation expected, which proved nothing about the API —
    // and the implementation had the words the other way round, so the safety
    // message never fired on a real shop.
    const admin = adminWith({
      data: {
        inventorySetQuantities: {
          inventoryAdjustmentGroup: null,
          userErrors: [{ message: "stale", code: "COMPARE_QUANTITY_STALE" }],
        },
      },
    });
    const { db } = dbRecorder();
    expect(
      await applyStockChanges(admin, db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] }),
    ).toBe("stockChangedMeanwhile");
  });

  it("treats a schema-level error as a failure, not a success", async () => {
    // A top-level `errors` array with `data: null` never reaches `userErrors`.
    const admin = adminWith({ errors: [{ message: "Field 'foo' doesn't exist" }], data: null });
    const { db, updates } = dbRecorder();
    expect(
      await applyStockChanges(admin, db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] }),
    ).toBe("stockFailed");
    expect(updates).toHaveLength(0);
  });

  it("does nothing at all with no changes", async () => {
    const admin = adminWith(echo([]));
    const { db } = dbRecorder();
    expect(await applyStockChanges(admin, db, "s", { variantId: "42", changes: [] })).toBeUndefined();
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("never throws — the content save has already happened", async () => {
    const admin = { graphql: vi.fn().mockRejectedValue(new Error("network")) } as never;
    const { db } = dbRecorder();
    expect(
      await applyStockChanges(admin, db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] }),
    ).toBe("stockFailed");
  });
});

// ── The InventoryItem's own settings ────────────────────────────────────────

describe("parseDecimal", () => {
  it("accepts a comma as a decimal separator", () => {
    // The merchant types what their keyboard and locale give them; this app
    // already learned that lesson on the price field.
    expect(parseDecimal("4,50")).toBe("4.50");
    expect(parseDecimal("4.5")).toBe("4.5");
  });

  it("refuses anything that is not a non-negative number", () => {
    expect(parseDecimal("-1")).toBeNull();
    expect(parseDecimal("4.5.1")).toBeNull();
    expect(parseDecimal("free")).toBeNull();
    expect(parseDecimal("")).toBeNull();
  });
});

describe("parseCountryCode", () => {
  it("uppercases a two-letter code and refuses the rest", () => {
    expect(parseCountryCode(" de ")).toBe("DE");
    expect(parseCountryCode("Germany")).toBeNull();
    expect(parseCountryCode("D")).toBeNull();
  });
});

/**
 * The SELLING price.
 *
 * Its own block because it is the one money write in this module with NO
 * compare-and-swap: `productVariantsBulkUpdate` overwrites whatever is there,
 * and Shopify offers nothing like `compareQuantity`. The echo is therefore the
 * only line of defence, and these tests are mostly about it holding.
 */
describe("applyVariantPrices", () => {
  const VARIANT_GID = "gid://shopify/ProductVariant/9";
  const PRODUCT_GID = "gid://shopify/Product/1";
  const priceEcho = (price: string | null, compareAtPrice: string | null = null) => ({
    data: {
      productVariantsBulkUpdate: {
        productVariants: [{ id: VARIANT_GID, price, compareAtPrice }],
        userErrors: [],
      },
    },
  });
  const params = (fields: Record<string, string>) => ({
    productId: PRODUCT_GID,
    variantId: "9",
    variantGid: VARIANT_GID,
    fields,
  });

  function variantRecorder() {
    const updates: Array<Record<string, unknown>> = [];
    return {
      updates,
      db: {
        productVariant: {
          updateMany: vi.fn(async (args: Record<string, unknown>) => {
            updates.push(args);
            return { count: 1 };
          }),
        },
      } as never,
    };
  }

  it("folds a German comma and mirrors what Shopify STORED", async () => {
    const admin = adminWith(priceEcho("9.90"));
    const { db, updates } = variantRecorder();

    const warning = await applyVariantPrices(admin, db, "s", params({ price: "9,90" }));

    expect(warning).toBeUndefined();
    const sent = (admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1].variables;
    expect(sent.variants[0].price).toBe("9.90");
    expect((updates[0] as { data: { price: string } }).data.price).toBe("9.90");
  });

  it("accepts Shopify's own normalisation without calling it a mismatch", async () => {
    // "9.9" sent, "9.90" echoed — the same money. A string compare would
    // report that as unconfirmed and refuse to mirror it.
    const admin = adminWith(priceEcho("9.90"));
    const { db } = variantRecorder();

    expect(await applyVariantPrices(admin, db, "s", params({ price: "9.9" }))).toBeUndefined();
  });

  it("refuses a DIFFERENT price rather than mirroring it", async () => {
    // No compare-and-swap exists here, so this is the only thing standing
    // between the merchant and a number they did not write.
    const admin = adminWith(priceEcho("12.00"));
    const { db, updates } = variantRecorder();

    expect(await applyVariantPrices(admin, db, "s", params({ price: "9.90" }))).toBe("priceNotConfirmed");
    expect(updates).toEqual([]);
  });

  it("treats a missing variant in the echo as unconfirmed", async () => {
    // The silent no-op: `userErrors: []` and nothing written.
    const admin = adminWith({ data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } });
    const { db, updates } = variantRecorder();

    expect(await applyVariantPrices(admin, db, "s", params({ price: "9.90" }))).toBe("priceNotConfirmed");
    expect(updates).toEqual([]);
  });

  it("clears the compare-at price on an empty string", async () => {
    // How a merchant ends a sale. "" must reach Shopify as null rather than be
    // dropped as "unchanged".
    const admin = adminWith(priceEcho("9.90", null));
    const { db, updates } = variantRecorder();

    const warning = await applyVariantPrices(admin, db, "s", params({ compareAtPrice: "" }));

    expect(warning).toBeUndefined();
    const sent = (admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1].variables;
    expect(sent.variants[0].compareAtPrice).toBeNull();
    expect((updates[0] as { data: { compareAtPrice: unknown } }).data.compareAtPrice).toBeNull();
  });

  it("refuses a price that is not a number instead of forwarding it", async () => {
    // A bad scalar fails at the SCHEMA level, where `userErrors` never sees it
    // — the call would read as a success while nothing was written.
    const admin = adminWith(priceEcho("9.90"));
    const { db } = variantRecorder();

    expect(await applyVariantPrices(admin, db, "s", params({ price: "sehr günstig" }))).toBe("priceInvalid");
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("sends only the fields the caller touched", async () => {
    const admin = adminWith(priceEcho("9.90"));
    const { db } = variantRecorder();

    await applyVariantPrices(admin, db, "s", params({ price: "9.90" }));

    const sent = (admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1].variables;
    expect(Object.keys(sent.variants[0]).sort()).toEqual(["id", "price"]);
  });
});

describe("applyInventoryItemFields", () => {
  const ITEM_ID = "gid://shopify/InventoryItem/1";
  const itemEcho = (overrides: Record<string, unknown> = {}) => ({
    data: {
      inventoryItemUpdate: {
        inventoryItem: {
          id: ITEM_ID,
          requiresShipping: true,
          countryCodeOfOrigin: "DE",
          harmonizedSystemCode: "610910",
          unitCost: { amount: "4.50" },
          measurement: { weight: { value: 0.35, unit: "KILOGRAMS" } },
          ...overrides,
        },
        userErrors: [],
      },
    },
  });

  function variantRecorder() {
    const updates: Array<Record<string, unknown>> = [];
    return {
      updates,
      db: {
        productVariant: {
          updateMany: vi.fn(async (args: Record<string, unknown>) => {
            updates.push(args);
            return { count: 1 };
          }),
        },
      } as never,
    };
  }

  it("writes only the keys the caller SENT", async () => {
    // "absent" means leave alone and "" means clear — rebuilding every key
    // would collapse the two and wipe what the merchant did not touch.
    const admin = adminWith(itemEcho());
    const { db } = variantRecorder();
    await applyInventoryItemFields(admin, db, "s", {
      variantId: "42",
      inventoryItemId: ITEM_ID,
      fields: { cost: "4,50" },
    });
    const input = (admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1].variables.input;
    expect(Object.keys(input)).toEqual(["cost"]);
    expect(input.cost).toBe("4.50");
  });

  it("reads an empty cost as a deliberate CLEAR", async () => {
    const admin = adminWith(itemEcho({ unitCost: null }));
    const { db, updates } = variantRecorder();
    const warning = await applyInventoryItemFields(admin, db, "s", {
      variantId: "42",
      inventoryItemId: ITEM_ID,
      fields: { cost: "" },
    });
    expect(warning).toBeUndefined();
    expect(updates[0].data).toMatchObject({ cost: null });
  });

  it("REFUSES an invalid enum rather than forwarding it", async () => {
    // WeightUnit and CountryCode are enums, and a bad one fails at the SCHEMA
    // level — which never reaches `userErrors`, so the call would read as a
    // success while nothing was written.
    const admin = adminWith(itemEcho());
    const { db } = variantRecorder();
    expect(
      await applyInventoryItemFields(admin, db, "s", {
        variantId: "42",
        inventoryItemId: ITEM_ID,
        fields: { weight: { value: "1", unit: "STONES" } },
      }),
    ).toBe("itemFieldsInvalid");
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("refuses a weight with no unit", async () => {
    const admin = adminWith(itemEcho());
    const { db } = variantRecorder();
    expect(
      await applyInventoryItemFields(admin, db, "s", {
        variantId: "42",
        inventoryItemId: ITEM_ID,
        fields: { weight: { value: "", unit: "KILOGRAMS" } },
      }),
    ).toBe("itemFieldsInvalid");
  });

  it("mirrors what Shopify NORMALISED, not what was sent", async () => {
    // "4.5" comes back "4.50". Writing the sent value would leave the cache
    // claiming a number the shop does not hold, and the panel reads the cache.
    const admin = adminWith(itemEcho());
    const { db, updates } = variantRecorder();
    await applyInventoryItemFields(admin, db, "s", {
      variantId: "42",
      inventoryItemId: ITEM_ID,
      fields: { cost: "4.5" },
    });
    expect(updates[0].data).toMatchObject({ cost: "4.50" });
  });

  it("does nothing when no field was sent", async () => {
    const admin = adminWith(itemEcho());
    const { db } = variantRecorder();
    expect(
      await applyInventoryItemFields(admin, db, "s", { variantId: "42", inventoryItemId: ITEM_ID, fields: {} }),
    ).toBeUndefined();
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("treats a missing echo as NOT CONFIRMED", async () => {
    const admin = adminWith({ data: { inventoryItemUpdate: { inventoryItem: null, userErrors: [] } } });
    const { db, updates } = variantRecorder();
    expect(
      await applyInventoryItemFields(admin, db, "s", {
        variantId: "42",
        inventoryItemId: ITEM_ID,
        fields: { cost: "4.50" },
      }),
    ).toBe("itemFieldsNotConfirmed");
    expect(updates).toHaveLength(0);
  });
});

describe("applyStockChanges — the ledger the echo belongs to", () => {
  it("judges against on_hand and ignores the available entry", async () => {
    // Setting on_hand ALSO produces an `available` ledger change (available =
    // on_hand minus open commitments). A map keyed only by item+location let
    // that second entry shadow the first, so a write that SUCCEEDED came back
    // as "not confirmed" — or, if the numbers coincided, was confirmed against
    // the wrong ledger entirely.
    const admin = adminWith(
      echo([
        { locationId: LOC_A, after: 12, name: "on_hand" },
        { locationId: LOC_A, after: 9, name: "available" },
      ]),
    );
    const { db, updates } = dbRecorder();
    const warning = await applyStockChanges(admin, db, "s", {
      variantId: "42",
      changes: [change(LOC_A, 12, 9)],
    });
    expect(warning).toBeUndefined();
    expect(updates[0].data).toMatchObject({ onHand: 12 });
  });

  it("asks Shopify for the on_hand changes only", async () => {
    const admin = adminWith(echo([{ locationId: LOC_A, after: 12 }]));
    const { db } = dbRecorder();
    await applyStockChanges(admin, db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });
    const query = (admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][0];
    expect(query).toContain('changes(quantityNames: ["on_hand"])');
  });

  it("refuses to write stock for an UNTRACKED variant, and says which it is", async () => {
    // Sending it anyway comes back as a generic failure, which tells the
    // merchant nothing about why — and this is the one reason that is a fact
    // about their setup rather than an error.
    const admin = adminWith(echo([{ locationId: LOC_A, after: 12 }]));
    const { db } = dbRecorder();
    expect(
      await applyStockChanges(admin, db, "s", {
        variantId: "42",
        changes: [change(LOC_A, 12, 9)],
        tracked: false,
      }),
    ).toBe("stockUntracked");
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("does NOT read an unknown tracking state as untracked", async () => {
    // `null` means the cache never learned it. Refusing on that would block a
    // legitimate correction on every product the panel has not loaded before.
    const admin = adminWith(echo([{ locationId: LOC_A, after: 12 }]));
    const { db } = dbRecorder();
    expect(
      await applyStockChanges(admin, db, "s", {
        variantId: "42",
        changes: [change(LOC_A, 12, 9)],
        tracked: null,
      }),
    ).toBeUndefined();
  });
});
