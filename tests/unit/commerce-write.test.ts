/**
 * PLAN_CONTENT_CREATION Phase 4 — the stock write path.
 *
 * A quantity is money, so the echo rule is stricter here than anywhere else in
 * this app: a write counts as successful only when Shopify returns the NEW
 * QUANTITY and it matches what was asked for. `userErrors: []` is not enough,
 * and neither is "the mutation returned an object".
 */

import { describe, it, expect, vi } from "vitest";
import { applyStockChanges, parseQuantity } from "../../app/services/commerce-write.server";

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

const echo = (entries: Array<{ locationId: string; after: number }>) => ({
  data: {
    inventorySetQuantities: {
      inventoryAdjustmentGroup: {
        changes: entries.map((e) => ({
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
    const admin = adminWith({
      data: {
        inventorySetQuantities: {
          inventoryAdjustmentGroup: null,
          userErrors: [{ message: "stale", code: "STALE_COMPARE_QUANTITY" }],
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
