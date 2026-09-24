/**
 * PLAN_CONTENT_CREATION Phase 4 — the stock write path.
 *
 * A quantity is money, so the echo rule is stricter here than anywhere else in
 * this app: a write counts as successful only when Shopify returns the NEW
 * QUANTITY and it matches what was asked for. `userErrors: []` is not enough,
 * and neither is "the mutation returned an object".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyInventoryItemFields,
  applyStockChanges,
  parseCountryCode,
  parseDecimal,
  parseQuantity,
  applyVariantPrices,
  resetInventoryInputShapeProbe,
} from "../../app/services/commerce-write.server";

const ITEM = "gid://shopify/InventoryItem/1";
const LOC_A = "gid://shopify/Location/1";
const LOC_B = "gid://shopify/Location/2";

/** Minimal admin stub: one graphql() returning the given body. */
function adminWith(body: unknown) {
  return { graphql: vi.fn().mockResolvedValue({ json: async () => body }) } as never;
}

/**
 * The graphql call that carried the SET mutation.
 *
 * Not `calls[0]`: the shape lookup goes first now, and an index would pin the
 * introspection instead of the write.
 */
function stockCall(admin: unknown) {
  const calls = (admin as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls;
  const call = calls.find(([query]) => String(query).includes("inventorySetQuantities"));
  if (!call) throw new Error("the stock mutation was never sent");
  return { query: String(call[0]), variables: call[1] as { variables: { input: Record<string, never> } } };
}

/** The shape is memoised per PROCESS, so one test's answer would otherwise
 *  decide the next one's document. */
beforeEach(() => resetInventoryInputShapeProbe());

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

    const variables = stockCall(admin).variables;
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
  const params = (fields: Record<string, unknown>) => ({
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

  /** The variant echo, with a Grundpreis on it. */
  const unitEcho = (
    measurement: Record<string, unknown> | null,
    showUnitPrice: boolean | null = null,
  ) => ({
    data: {
      productVariantsBulkUpdate: {
        productVariants: [
          { id: VARIANT_GID, price: null, compareAtPrice: null, unitPriceMeasurement: measurement, showUnitPrice },
        ],
        userErrors: [],
      },
    },
  });
  const unit = (
    quantityValue: string,
    quantityUnit: string,
    referenceValue: string,
    referenceUnit: string,
  ) => ({ unitPrice: { quantityValue, quantityUnit, referenceValue, referenceUnit } });

  describe("the Grundpreis", () => {
    it("writes the measurement and confirms it from the echo", async () => {
      const stored = { quantityValue: 500, quantityUnit: "G", referenceValue: 1, referenceUnit: "KG" };
      const admin = adminWith(unitEcho(stored));
      const { db } = variantRecorder();

      const warning = await applyVariantPrices(admin, db, "s", params(unit("500", "G", "1", "KG")));

      expect(warning).toBeUndefined();
      const sent = (admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1].variables;
      expect(sent.variants[0].unitPriceMeasurement).toEqual(stored);
    });

    it("CLEARS with the empty state, never with null", async () => {
      // Measured on a live shop: `unitPriceMeasurement: null` is accepted,
      // reports no errors, and leaves the measurement exactly where it was.
      // Sending it would make "remove the unit price" a silent no-op.
      const admin = adminWith(unitEcho({ quantityValue: 0, quantityUnit: null, referenceValue: 0, referenceUnit: null }));
      const { db } = variantRecorder();

      const warning = await applyVariantPrices(admin, db, "s", params(unit("", "", "", "")));

      expect(warning).toBeUndefined();
      const sent = (admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1].variables;
      expect(sent.variants[0].unitPriceMeasurement).not.toBeNull();
      expect(sent.variants[0].unitPriceMeasurement).toEqual({
        quantityValue: 0, quantityUnit: null, referenceValue: 0, referenceUnit: null,
      });
    });

    it("catches ACCEPTED AND IGNORED on a removal", async () => {
      // The exact live failure: no errors, and the measurement still there.
      const admin = adminWith(unitEcho({ quantityValue: 500, quantityUnit: "G", referenceValue: 1, referenceUnit: "KG" }));
      const { db, updates } = variantRecorder();

      const warning = await applyVariantPrices(admin, db, "s", params(unit("", "", "", "")));

      expect(warning).toBe("unitPriceNotConfirmed");
      // …and nothing was mirrored on the strength of it.
      expect(updates).toHaveLength(0);
    });

    it("refuses half a measurement instead of writing it", async () => {
      const admin = adminWith(unitEcho(null));
      const { db } = variantRecorder();

      expect(await applyVariantPrices(admin, db, "s", params(unit("500", "G", "", "")))).toBe(
        "unitPriceIncomplete",
      );
      // Refused BEFORE the mutation: nothing was sent at all.
      expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
    });

    it("refuses the WeightUnit spelling rather than forwarding it", async () => {
      // A bad enum fails at the SCHEMA level — a top-level `errors` array with
      // `data: null` that never reaches `userErrors` — so forwarding it makes
      // the whole save read as a success while nothing was written, taking the
      // price in the same call with it.
      const admin = adminWith(unitEcho(null));
      const { db } = variantRecorder();

      expect(
        await applyVariantPrices(admin, db, "s", params(unit("500", "GRAMS", "1", "KILOGRAMS"))),
      ).toBe("unitPriceInvalid");
      expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
    });

    it("still writes the price when the measurement is refused", async () => {
      // The group case: the merchant edits the reference unit on a scope whose
      // members disagree, so one member's quartet arrives three quarters
      // empty — for a Grundpreis that member never showed. Refusing the whole
      // call took their price, barcode and tax edits with it, and retrying did
      // the same thing forever.
      const admin = adminWith({
        data: {
          productVariantsBulkUpdate: {
            productVariants: [{ id: VARIANT_GID, price: "24.90", compareAtPrice: null, unitPriceMeasurement: null, showUnitPrice: null }],
            userErrors: [],
          },
        },
      });
      const { db, updates } = variantRecorder();

      const warning = await applyVariantPrices(admin, db, "s", {
        ...params({}),
        fields: { price: "24.90", ...unit("", "", "", "KG") },
      });

      expect(warning).toBe("unitPriceIncomplete");
      const sent = (admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1].variables;
      // The price went; no measurement was sent at all.
      expect(sent.variants[0].price).toBe("24.90");
      expect(sent.variants[0].unitPriceMeasurement).toBeUndefined();
      expect((updates[0] as { data: { price: string } }).data.price).toBe("24.90");
    });

    it("mirrors the price Shopify DID store even when the switch refused", async () => {
      // Returning on the first mismatch left the cache holding the old price
      // while the warning said everything else was saved — and the bulk grid
      // reads that cache.
      const stored = { quantityValue: 500, quantityUnit: "G", referenceValue: 1, referenceUnit: "KG" };
      const admin = adminWith({
        data: {
          productVariantsBulkUpdate: {
            productVariants: [{ id: VARIANT_GID, price: "24.90", compareAtPrice: null, unitPriceMeasurement: stored, showUnitPrice: false }],
            userErrors: [],
          },
        },
      });
      const { db, updates } = variantRecorder();

      const warning = await applyVariantPrices(admin, db, "s", {
        ...params({}),
        fields: { price: "24.90", ...unit("500", "G", "1", "KG"), showUnitPrice: true },
      });

      expect(warning).toBe("unitPriceNotShown");
      expect((updates[0] as { data: { price: string } }).data.price).toBe("24.90");
    });

    it("refuses a German thousands separator instead of reading 1.000 as 1", async () => {
      // The money field two rows up has refused this since a review finding;
      // read as 1 here it stores 1 ml per 1 l, the echo matches, the save
      // reports success, and the storefront prints a Grundpreis a thousand
      // times too high — on the field that exists to satisfy a price
      // disclosure law.
      const admin = adminWith(unitEcho(null));
      const { db } = variantRecorder();

      expect(await applyVariantPrices(admin, db, "s", params(unit("1.000", "ML", "1", "L")))).toBe(
        "unitPriceAmbiguous",
      );
      expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
    });

    it("refuses grams per litre", async () => {
      // Two different questions, not one measurement. What Shopify does with a
      // mismatched pair is unmeasured, so this refuses rather than finding out
      // on a merchant's storefront.
      const admin = adminWith(unitEcho(null));
      const { db } = variantRecorder();

      expect(await applyVariantPrices(admin, db, "s", params(unit("500", "G", "1", "L")))).toBe(
        "unitPriceDimension",
      );
      expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
    });

    it("reports a switch that would not move on its OWN, not as a price failure", async () => {
      // The measurement may well be stored while only the switch refused. One
      // code for both sends a merchant looking for a price that is saved.
      const stored = { quantityValue: 500, quantityUnit: "G", referenceValue: 1, referenceUnit: "KG" };
      const admin = adminWith(unitEcho(stored, false));
      const { db } = variantRecorder();

      const warning = await applyVariantPrices(admin, db, "s", {
        ...params(unit("500", "G", "1", "KG")),
        fields: { ...unit("500", "G", "1", "KG"), showUnitPrice: true },
      });

      expect(warning).toBe("unitPriceNotShown");
    });
  });

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

  it("REFUSES an ambiguous number instead of picking a reading", async () => {
    // "1.299" is 1299 to a German merchant and 1.299 to an American one. The
    // module used to fold one comma and accept anything else, which turned a
    // €1299 product into a €1.30 one — silently, because the write succeeded.
    // The bulk grid's parser knows the case and says how to write it instead.
    const admin = adminWith(priceEcho("1299.00"));
    const { db } = variantRecorder();

    expect(await applyVariantPrices(admin, db, "s", params({ price: "1.299" }))).toBe("priceAmbiguous");
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("reads the unambiguous German and English spellings the same way", async () => {
    for (const [typed, expected] of [["1.299,00", "1299.00"], ["1,299.00", "1299.00"], ["1299", "1299.00"]]) {
      const admin = adminWith(priceEcho(expected));
      const { db } = variantRecorder();
      expect(await applyVariantPrices(admin, db, "s", params({ price: typed }))).toBeUndefined();
      const sent = (admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1].variables;
      expect(sent.variants[0].price, typed).toBe(expected);
    }
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
    expect(stockCall(admin).query).toContain('changes(quantityNames: ["on_hand"])');
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

describe("the variant's own settings", () => {
  const VARIANT_GID = "gid://shopify/ProductVariant/9";
  const ITEM_ID = "gid://shopify/InventoryItem/1";

  function recorder() {
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

  const sentTo = (admin: never) =>
    (admin as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls[0][1].variables;

  it("clears a barcode on an empty field, unlike a price", async () => {
    // A price cannot be cleared — Shopify requires one — so "" means "leave
    // it". A wrong barcode is worse than none, so "" there is a real change.
    const admin = adminWith({
      data: {
        productVariantsBulkUpdate: {
          productVariants: [{ id: VARIANT_GID, price: "9.90", compareAtPrice: null, barcode: null }],
          userErrors: [],
        },
      },
    });
    const { db } = recorder();

    const warning = await applyVariantPrices(admin, db, "s", {
      productId: "gid://shopify/Product/1",
      variantId: "9",
      variantGid: VARIANT_GID,
      fields: { barcode: "" },
    });

    expect(warning).toBeUndefined();
    expect(sentTo(admin).variants[0].barcode).toBeNull();
  });

  it("refuses a barcode or a policy the echo did not carry", async () => {
    // Both were sent and MIRRORED without ever being asked back for, so
    // Shopify accepting the call and storing nothing left the cache — and the
    // merchant — believing a policy that was never applied.
    const admin = adminWith({
      data: {
        productVariantsBulkUpdate: {
          productVariants: [
            { id: VARIANT_GID, price: "9.90", compareAtPrice: null, barcode: null, inventoryPolicy: "DENY" },
          ],
          userErrors: [],
        },
      },
    });
    const { db, updates } = recorder();

    expect(
      await applyVariantPrices(admin, db, "s", {
        productId: "gid://shopify/Product/1",
        variantId: "9",
        variantGid: VARIANT_GID,
        fields: { inventoryPolicy: "CONTINUE" },
      }),
    ).toBe("priceNotConfirmed");
    // …and nothing is mirrored, so the cache does not claim the new policy.
    expect(updates).toEqual([]);
  });

  it("refuses a stock policy that is not one of the two enums", async () => {
    // A bad enum fails at the SCHEMA level — a top-level error that never
    // reaches userErrors — and would take the price in the same call with it.
    const admin = adminWith({ data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } });
    const { db } = recorder();

    expect(
      await applyVariantPrices(admin, db, "s", {
        productId: "gid://shopify/Product/1",
        variantId: "9",
        variantGid: VARIANT_GID,
        fields: { inventoryPolicy: "MAYBE" },
      }),
    ).toBe("priceInvalid");
    expect((admin as never as { graphql: ReturnType<typeof vi.fn> }).graphql).not.toHaveBeenCalled();
  });

  it("writes `tracked` and confirms it against the echo", async () => {
    const admin = adminWith({
      data: {
        inventoryItemUpdate: {
          inventoryItem: { id: ITEM_ID, tracked: false, sku: "BX-15" },
          userErrors: [],
        },
      },
    });
    const { db, updates } = recorder();

    const warning = await applyInventoryItemFields(admin, db, "s", {
      variantId: "9",
      inventoryItemId: ITEM_ID,
      fields: { tracked: false, sku: "BX-15" },
    });

    expect(warning).toBeUndefined();
    expect(sentTo(admin).input.tracked).toBe(false);
    expect((updates[0] as { data: Record<string, unknown> }).data.inventoryTracked).toBe(false);
    expect((updates[0] as { data: Record<string, unknown> }).data.sku).toBe("BX-15");
  });

  it("refuses a `tracked` write the echo did not take", async () => {
    // `tracked` decides whether stock exists AT ALL. Accepted-and-ignored is
    // the historic silent no-op, and here it would leave the merchant looking
    // at a stock table for an item Shopify no longer counts.
    const admin = adminWith({
      data: {
        inventoryItemUpdate: {
          inventoryItem: { id: ITEM_ID, tracked: true },
          userErrors: [],
        },
      },
    });
    const { db, updates } = recorder();

    expect(
      await applyInventoryItemFields(admin, db, "s", {
        variantId: "9",
        inventoryItemId: ITEM_ID,
        fields: { tracked: false },
      }),
    ).toBe("itemFieldsNotConfirmed");
    expect(updates).toEqual([]);
  });
});

/**
 * The shape Shopify's 2026-04 inventory rework left behind.
 *
 * This is the bug that made every stock save a silent no-op on a shop whose
 * `SHOPIFY_API_VERSION` had moved past it: the document sent two fields the
 * version no longer has, Shopify refused it before execution, and the panel
 * had no way to say so. The module header quotes the server's own words.
 *
 * Pinned in both directions, because the app supports ten API versions and a
 * document that is right for one of them is wrong for the other.
 */
describe("the compare-and-swap is spelled the way the pinned version spells it", () => {
  // These drive the FALLBACK: `adminWith` answers every call with the mutation
  // echo, so the introspection gets no field list and the version pin decides.
  // That is the production path on a shop whose schema cannot be read.
  beforeEach(() => resetInventoryInputShapeProbe());

  const withVersion = async (version: string, run: () => Promise<void>) => {
    const previous = process.env.SHOPIFY_API_VERSION;
    process.env.SHOPIFY_API_VERSION = version;
    try {
      await run();
    } finally {
      // RESTORED by setting, never by deleting: a deleted variable is not the
      // same as the one the runner started with on every platform.
      process.env.SHOPIFY_API_VERSION = previous ?? "";
    }
  };

  /** The SET mutation's input, wherever the call landed — the shape lookup now
   *  goes first, so an index would pin the wrong call. */
  const inputOf = (admin: unknown) => {
    const calls = (admin as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls;
    const call = calls.find(([query]) => String(query).includes("inventorySetQuantities"));
    if (!call) throw new Error("the stock mutation was never sent");
    return (call[1] as { variables: { input: Record<string, unknown> } }).variables.input;
  };

  it("sends changeFromQuantity and NO ignoreCompareQuantity from 2026-04", async () => {
    await withVersion("2026-07", async () => {
      const admin = adminWith(echo([{ locationId: LOC_A, after: 12 }]));
      const { db } = dbRecorder();
      await applyStockChanges(admin, db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });

      const input = inputOf(admin);
      // Both of these were named by the live rejection; sending either again is
      // the whole defect.
      expect(input.ignoreCompareQuantity).toBeUndefined();
      const entry = (input.quantities as Array<Record<string, unknown>>)[0];
      expect(entry.compareQuantity).toBeUndefined();
      // The safety property survives the rename — it is the point of the call.
      expect(entry.changeFromQuantity).toBe(9);
      expect(entry.quantity).toBe(12);
    });
  });

  it("keeps the old spelling below it", async () => {
    await withVersion("2025-10", async () => {
      const admin = adminWith(echo([{ locationId: LOC_A, after: 12 }]));
      const { db } = dbRecorder();
      await applyStockChanges(admin, db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });

      const input = inputOf(admin);
      expect(input.ignoreCompareQuantity).toBe(false);
      const entry = (input.quantities as Array<Record<string, unknown>>)[0];
      expect(entry.compareQuantity).toBe(9);
      expect(entry.changeFromQuantity).toBeUndefined();
    });
  });

  it("never drops the comparison, whichever name it has", async () => {
    // The one thing neither branch may do. A write with no baseline is the
    // silent overwrite this module exists to refuse, and "make it go through"
    // is exactly the repair someone would reach for after reading the bug.
    for (const version of ["2025-10", "2026-07", "unstable"]) {
      await withVersion(version, async () => {
        const admin = adminWith(echo([{ locationId: LOC_A, after: 12 }]));
        const { db } = dbRecorder();
        await applyStockChanges(admin, db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });
        const entry = (inputOf(admin).quantities as Array<Record<string, unknown>>)[0];
        expect(entry.compareQuantity ?? entry.changeFromQuantity).toBe(9);
      });
    }
  });
});

/**
 * The schema decides, not the pin.
 *
 * The pin encodes what Shopify changed in 2026-04, but the NAME in it was
 * recorded research rather than something anyone could verify from where the
 * fix was written — and a wrong name is the same silent no-op all over again,
 * discovered by the merchant. So the shape is asked for before the write.
 */
describe("the write is built from the shape the schema really has", () => {
  beforeEach(() => resetInventoryInputShapeProbe());

  /** An admin that answers the introspection with `entry`, then the mutation.
   *  `set` defaults to a version that no longer has the opt-out switch — an
   *  EMPTY list means "this type did not answer" and is its own case below.
   *  `directives` answers the directive half; the default is a real list that
   *  simply has no `idempotent` in it, which is a definite "this version has
   *  none" and puts nothing in the document. */
  const adminWithShape = (
    entry: string[],
    set: string[] = ["name", "reason", "quantities"],
    directives: Array<{ name: string; locations?: string[]; args?: Array<{ name: string }> }> | null = [
      { name: "deprecated", locations: ["FIELD_DEFINITION"] },
    ],
  ) => {
    const graphql = vi.fn(async (query: string) =>
      String(query).includes("__type")
        ? {
            json: async () => ({
              data: {
                setInput: { inputFields: set.map((name) => ({ name })) },
                entryInput: { inputFields: entry.map((name) => ({ name })) },
                schema: directives ? { directives } : undefined,
              },
            }),
          }
        : { json: async () => echo([{ locationId: LOC_A, after: 12 }]) },
    );
    return { graphql } as never;
  };

  const inputOf = (admin: unknown) => {
    const calls = (admin as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls;
    const call = calls.find(([query]) => String(query).includes("inventorySetQuantities"));
    return call ? (call[1] as { variables: { input: Record<string, unknown> } }).variables.input : null;
  };

  it("uses the name the entry type carries, against the pin", async () => {
    // The pin says `compareQuantity` on 2025-10. The schema says otherwise, and
    // the schema is what the request is validated against.
    const previous = process.env.SHOPIFY_API_VERSION;
    process.env.SHOPIFY_API_VERSION = "2025-10";
    try {
      const admin = adminWithShape(["inventoryItemId", "locationId", "quantity", "changeFromQuantity"]);
      await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });
      const entry = (inputOf(admin)!.quantities as Array<Record<string, unknown>>)[0];
      expect(entry.changeFromQuantity).toBe(9);
      expect(entry.compareQuantity).toBeUndefined();
      // The switch is sent only where the input still has it.
      expect(inputOf(admin)!.ignoreCompareQuantity).toBeUndefined();
    } finally {
      process.env.SHOPIFY_API_VERSION = previous ?? "";
    }
  });

  it("sends the opt-out switch only where the input still has it", async () => {
    const admin = adminWithShape(
      ["inventoryItemId", "locationId", "quantity", "compareQuantity"],
      ["name", "reason", "quantities", "ignoreCompareQuantity"],
    );
    await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });
    expect(inputOf(admin)!.ignoreCompareQuantity).toBe(false);
    expect((inputOf(admin)!.quantities as Array<Record<string, unknown>>)[0].compareQuantity).toBe(9);
  });

  it("REFUSES rather than writing blind when the version has no comparison", async () => {
    // The one outcome this module may never trade away. A quantity written
    // with no baseline overwrites whatever moved in between.
    const admin = adminWithShape(["inventoryItemId", "locationId", "quantity"]);
    const { db, updates } = dbRecorder();
    const warning = await applyStockChanges(admin, db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });

    expect(warning).toBe("stockCompareUnsupported");
    expect(inputOf(admin)).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it("falls back to the pin when the lookup answers nothing", async () => {
    // Introspection switched off, a throttled read, a type named something
    // this app has never seen: an empty answer is not a verdict, and refusing
    // every stock write on it would be the worse error by far.
    const previous = process.env.SHOPIFY_API_VERSION;
    process.env.SHOPIFY_API_VERSION = "2026-07";
    try {
      const admin = adminWithShape([]);
      await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });
      const entry = (inputOf(admin)!.quantities as Array<Record<string, unknown>>)[0];
      expect(entry.changeFromQuantity).toBe(9);
    } finally {
      process.env.SHOPIFY_API_VERSION = previous ?? "";
    }
  });

  it("falls back to the pin when only ONE of the two types answered", async () => {
    // The expensive half. `__type` answers null for a name this version does
    // not have, so a renamed top-level input leaves `ignoreCompareQuantity`
    // looking REMOVED while `compareQuantity` is still sent — and omitting the
    // switch on a version that has it is the silent overwrite, reached through
    // a lookup that was meant to prevent one.
    const previous = process.env.SHOPIFY_API_VERSION;
    process.env.SHOPIFY_API_VERSION = "2025-10";
    try {
      const admin = adminWithShape(["inventoryItemId", "locationId", "quantity", "compareQuantity"], []);
      await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });
      const input = inputOf(admin)!;
      expect(input.ignoreCompareQuantity).toBe(false);
      expect((input.quantities as Array<Record<string, unknown>>)[0].compareQuantity).toBe(9);
    } finally {
      process.env.SHOPIFY_API_VERSION = previous ?? "";
    }
  });

  it("does not memoise a REFUSAL, so one odd answer is not a standing outage", async () => {
    let entry = ["inventoryItemId", "locationId", "quantity"];
    const graphql = vi.fn(async (query: string) =>
      String(query).includes("__type")
        ? {
            json: async () => ({
              data: {
                setInput: { inputFields: [{ name: "name" }, { name: "quantities" }] },
                entryInput: { inputFields: entry.map((name) => ({ name })) },
              },
            }),
          }
        : { json: async () => echo([{ locationId: LOC_A, after: 12 }]) },
    );
    const admin = { graphql } as never;
    expect(
      await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] }),
    ).toBe("stockCompareUnsupported");

    // The next save asks again rather than repeating the refusal from memory.
    entry = [...entry, "compareQuantity"];
    expect(
      await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] }),
    ).toBeUndefined();
  });

  it("asks ONCE per process, not once per save", async () => {
    const admin = adminWithShape(["inventoryItemId", "locationId", "quantity", "compareQuantity"]);
    await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });
    await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_B, 5, 4)] });
    const lookups = (admin as unknown as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls.filter(
      ([query]) => String(query).includes("__type"),
    );
    expect(lookups).toHaveLength(1);
  });
});

describe("a refused write", () => {
  it("tells a stale comparison from a demand for one", async () => {
    // `COMPARE_QUANTITY_REQUIRED` reported as "someone else changed it" sends
    // the merchant into a reload loop over a request that can never succeed.
    const refuse = (code: string) => ({
      data: { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ message: "no", code }] } },
    });
    const stale = await applyStockChanges(adminWith(refuse("COMPARE_QUANTITY_STALE")), dbRecorder().db, "s", {
      variantId: "42", changes: [change(LOC_A, 12, 9)],
    });
    const required = await applyStockChanges(adminWith(refuse("COMPARE_QUANTITY_REQUIRED")), dbRecorder().db, "s", {
      variantId: "42", changes: [change(LOC_A, 12, 9)],
    });
    expect(stale).toBe("stockChangedMeanwhile");
    expect(required).toBe("stockFailed");
  });
});

/**
 * `@idempotent`, the other half of the 2026-04 inventory rework.
 *
 * Once the input shape was right, production refused both inventory mutations
 * for the directive — before execution, so no `userErrors` and nothing
 * written, the same shape of silence as the field rename. Where it sits and
 * what it takes are read from the schema: a directive spelled by hand is
 * refused exactly like a missing one.
 */
describe("the idempotency directive is read from the schema, not spelled", () => {
  beforeEach(() => resetInventoryInputShapeProbe());

  const adminWithDirective = (
    directives: Array<{ name: string; locations?: string[]; args?: Array<{ name: string }> }>,
  ) => {
    const graphql = vi.fn(async (query: string) =>
      String(query).includes("__type")
        ? {
            json: async () => ({
              data: {
                setInput: { inputFields: [{ name: "name" }, { name: "quantities" }] },
                entryInput: {
                  inputFields: [
                    { name: "inventoryItemId" },
                    { name: "locationId" },
                    { name: "quantity" },
                    { name: "changeFromQuantity" },
                  ],
                },
                schema: { directives },
              },
            }),
          }
        : { json: async () => echo([{ locationId: LOC_A, after: 12 }]) },
    );
    return { graphql } as never;
  };

  const send = async (admin: unknown) => {
    await applyStockChanges(admin as never, dbRecorder().db, "s", {
      variantId: "42",
      changes: [change(LOC_A, 12, 9)],
    });
    return stockCall(admin).query;
  };

  it("puts it on the OPERATION with a key where the schema says so", async () => {
    const query = await send(
      adminWithDirective([{ name: "idempotent", locations: ["MUTATION"], args: [{ name: "key" }] }]),
    );
    expect(query).toMatch(/mutation setOnHandQuantities\([^)]*\) @idempotent\(key: "[0-9a-f-]{36}"\)/);
    // Not on the field as well — one directive, one place.
    expect(query).not.toMatch(/inventorySetQuantities\(input: \$input\) @idempotent/);
  });

  it("puts it on the FIELD where that is the declared location", async () => {
    const query = await send(
      adminWithDirective([{ name: "idempotent", locations: ["FIELD"], args: [{ name: "key" }] }]),
    );
    expect(query).toMatch(/inventorySetQuantities\(input: \$input\) @idempotent\(key: "/);
    expect(query).not.toMatch(/mutation setOnHandQuantities\([^)]*\) @idempotent/);
  });

  it("sends it bare where it takes no key", async () => {
    const query = await send(adminWithDirective([{ name: "idempotent", locations: ["MUTATION"], args: [] }]));
    expect(query).toContain("@idempotent {");
    expect(query).not.toContain("key:");
  });

  it("sends NOTHING where the schema has no such directive", async () => {
    // A directive a version does not know is itself a schema-level refusal, so
    // an absent one is left absent rather than added on the strength of the pin.
    const query = await send(adminWithDirective([{ name: "deprecated", locations: ["FIELD_DEFINITION"] }]));
    expect(query).not.toContain("@idempotent");
  });

  it("gives each document its OWN key", async () => {
    const admin = adminWithDirective([
      { name: "idempotent", locations: ["MUTATION"], args: [{ name: "key" }] },
    ]);
    await send(admin);
    await send(admin);
    // Read off ALL the mutation calls: `stockCall` answers with the first, and
    // the question here is what the SECOND one carried.
    const keys = (admin as unknown as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls
      .map(([query]) => String(query).match(/key: "([0-9a-f-]{36})"/)?.[1])
      .filter(Boolean);
    expect(keys).toHaveLength(2);
    // Two separate saves are two operations, not one retried — sharing a key
    // would make the second a no-op on a platform that honours it.
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("keeps the directive when the INPUT types did not answer", async () => {
    // The two halves are separate questions with separate consequences. The
    // compare field has the version pin behind it; the directive has nothing,
    // and a mutation that needs it is refused before it runs. Discarding the
    // directive because a type got renamed would answer a rename with an
    // outage.
    const graphql = vi.fn(async (query: string) =>
      String(query).includes("__type")
        ? {
            json: async () => ({
              data: {
                setInput: null,
                entryInput: null,
                schema: { directives: [{ name: "idempotent", locations: ["MUTATION"], args: [{ name: "key" }] }] },
              },
            }),
          }
        : { json: async () => echo([{ locationId: LOC_A, after: 12 }]) },
    );
    const admin = { graphql } as never;
    await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });
    expect(stockCall(admin).query).toContain("@idempotent(key:");
  });

  it("does not memoise an unread directive list", async () => {
    // Same rule as the refused comparison: an answer that is missing half its
    // evidence must not become this process's standing verdict, or one
    // throttled introspection refuses every inventory mutation until a deploy.
    let directives: Array<{ name: string; locations?: string[]; args?: Array<{ name: string }> }> | null = null;
    const graphql = vi.fn(async (query: string) =>
      String(query).includes("__type")
        ? {
            json: async () => ({
              data: {
                setInput: { inputFields: [{ name: "name" }, { name: "quantities" }] },
                entryInput: {
                  inputFields: [
                    { name: "inventoryItemId" },
                    { name: "locationId" },
                    { name: "quantity" },
                    { name: "changeFromQuantity" },
                  ],
                },
                schema: directives ? { directives } : undefined,
              },
            }),
          }
        : { json: async () => echo([{ locationId: LOC_A, after: 12 }]) },
    );
    const admin = { graphql } as never;
    await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_A, 12, 9)] });

    directives = [{ name: "idempotent", locations: ["MUTATION"], args: [{ name: "key" }] }];
    await applyStockChanges(admin, dbRecorder().db, "s", { variantId: "42", changes: [change(LOC_B, 5, 4)] });
    const mutations = graphql.mock.calls.filter(([query]) =>
      String(query).includes("inventorySetQuantities"),
    );
    expect(String(mutations[1][0])).toContain("@idempotent(key:");
  });

  it("asks the schema ONCE for both halves of one save", async () => {
    // The stock write needs the compare field AND the directive. Reading the
    // shape twice is a second round trip per save and a second warn line for
    // one failure.
    const admin = adminWithDirective([
      { name: "idempotent", locations: ["MUTATION"], args: [{ name: "key" }] },
    ]);
    await send(admin);
    const lookups = (admin as unknown as { graphql: ReturnType<typeof vi.fn> }).graphql.mock.calls.filter(
      ([query]) => String(query).includes("__type"),
    );
    expect(lookups).toHaveLength(1);
  });
});
