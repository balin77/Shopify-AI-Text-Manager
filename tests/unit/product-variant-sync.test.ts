import { describe, it, expect, vi } from "vitest";
import {
  moneyToDecimalString,
  syncProductVariantRows,
  type ShopifySyncVariant,
} from "~/services/product-variant-sync.server";

/**
 * Regression tests for the Phase-3 variant sync (Plan §5.1/§10.3/§12):
 * targeted upsert on shopifyGid that NEVER touches galleryJson/imageKey
 * (image-manager data), plus targeted deletion of only the ids Shopify no
 * longer returned — never deleteMany+createMany like images/options.
 */

const PRODUCT_ID = "gid://shopify/Product/1";

function variant(num: number, overrides: Partial<ShopifySyncVariant> = {}): ShopifySyncVariant {
  return {
    id: `gid://shopify/ProductVariant/${num}`,
    title: `Variant ${num}`,
    sku: `SKU-${num}`,
    price: "12.5",
    compareAtPrice: null,
    position: num,
    barcode: null,
    image: null,
    ...overrides,
  };
}

function mockTx() {
  return {
    productVariant: {
      upsert: vi.fn(async (_args: unknown) => ({})),
      deleteMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
    },
  };
}

describe("moneyToDecimalString — the ONE Money→Decimal conversion (Plan §5.2)", () => {
  it("normalizes Shopify Money strings to two fraction digits", () => {
    expect(moneyToDecimalString("12.5")).toBe("12.50");
    expect(moneyToDecimalString("1299.9")).toBe("1299.90");
    expect(moneyToDecimalString("0")).toBe("0.00");
  });

  it("maps null/empty/garbage/negative to null instead of crashing the batch", () => {
    expect(moneyToDecimalString(null)).toBeNull();
    expect(moneyToDecimalString(undefined)).toBeNull();
    expect(moneyToDecimalString("")).toBeNull();
    expect(moneyToDecimalString("abc")).toBeNull();
    expect(moneyToDecimalString("-5")).toBeNull();
  });
});

describe("syncProductVariantRows (Plan §5.1)", () => {
  it("upserts on shopifyGid WITHOUT touching galleryJson/imageKey", async () => {
    const tx = mockTx();
    await syncProductVariantRows(tx, PRODUCT_ID, [variant(1), variant(2, { compareAtPrice: "19.9" })]);

    expect(tx.productVariant.upsert).toHaveBeenCalledTimes(2);
    const first = tx.productVariant.upsert.mock.calls[0][0] as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(first.where).toEqual({ shopifyGid: "gid://shopify/ProductVariant/1" });
    // Numeric id + GID split follows the image-manager convention
    // (api.product-variants.tsx).
    expect(first.create.id).toBe("1");
    expect(first.create.productId).toBe(PRODUCT_ID);
    expect(first.create.price).toBe("12.50");
    // THE invariant: image-manager fields are never part of the update.
    expect("galleryJson" in first.update).toBe(false);
    expect("imageKey" in first.update).toBe(false);
    expect("galleryJson" in first.create).toBe(false);
    expect("imageKey" in first.create).toBe(false);

    const second = tx.productVariant.upsert.mock.calls[1][0] as { update: Record<string, unknown> };
    expect(second.update.compareAtPrice).toBe("19.90");
  });

  it("deletes ONLY the ids Shopify no longer returned (targeted, per product)", async () => {
    const tx = mockTx();
    await syncProductVariantRows(tx, PRODUCT_ID, [variant(1), variant(3)]);

    expect(tx.productVariant.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.productVariant.deleteMany).toHaveBeenCalledWith({
      where: {
        productId: PRODUCT_ID,
        shopifyGid: { notIn: ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/3"] },
      },
    });
  });

  it("does NOTHING when the variants block is missing — never wipe on uncertainty", async () => {
    const tx = mockTx();
    await syncProductVariantRows(tx, PRODUCT_ID, null);
    await syncProductVariantRows(tx, PRODUCT_ID, undefined);
    expect(tx.productVariant.upsert).not.toHaveBeenCalled();
    expect(tx.productVariant.deleteMany).not.toHaveBeenCalled();
  });

  it("stores unparseable/negative prices as null instead of failing the row", async () => {
    const tx = mockTx();
    await syncProductVariantRows(tx, PRODUCT_ID, [variant(1, { price: "not-a-price" })]);
    const call = tx.productVariant.upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update.price).toBeNull();
  });
});
