/**
 * The cache half of the cleared-slot rule: a metafield deleted on Shopify keeps
 * its ProductMetafield row with value "" (so the editor's card can still show
 * the field), the sync keeps such a row while Shopify has no metafield of that
 * namespace/key, and a real metafield of that key supersedes it.
 */
import { describe, it, expect, vi } from "vitest";
import { dropSupersededMetafieldSlots, keepClearedMetafieldSlot } from "~/services/product-metafield-slots.server";

vi.mock("@prisma/client", () => {
  class PrismaClient {}
  const Prisma = {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    join: (parts: unknown[]) => parts,
  };
  return { PrismaClient, Prisma };
});

import { upsertProductMetafields } from "~/db.server";

const SHOP = "s.myshopify.com";
const PRODUCT = "gid://shopify/Product/1";

function db(rows: Array<{ id: string; value: string }>) {
  return {
    productMetafield: {
      findMany: vi.fn(async () => rows),
      updateMany: vi.fn(async (_args: any) => ({ count: 1 })),
      deleteMany: vi.fn(async (_args: any) => ({ count: 1 })),
    },
  };
}

describe("keepClearedMetafieldSlot", () => {
  it("keeps the real row as the slot (value \"\") and reports it for the translation cleanup", async () => {
    const d = db([{ id: "gid://shopify/Metafield/5", value: "Wolle" }]);
    const former = await keepClearedMetafieldSlot(d, { shop: SHOP, productId: PRODUCT, namespace: "custom", key: "m" });
    expect(d.productMetafield.findMany).toHaveBeenCalledWith({
      where: { productId: PRODUCT, product: { shop: SHOP }, namespace: "custom", key: "m" },
      select: { id: true, value: true },
    });
    expect(d.productMetafield.updateMany).toHaveBeenCalledWith({
      where: { id: "gid://shopify/Metafield/5", product: { shop: SHOP } },
      data: { value: "" },
    });
    expect(d.productMetafield.deleteMany).not.toHaveBeenCalled();
    expect(former).toEqual(["gid://shopify/Metafield/5"]);
  });

  it("leaves exactly ONE row of that key: an older slot beside it goes", async () => {
    const d = db([
      { id: "gid://shopify/Metafield/4", value: "" },
      { id: "gid://shopify/Metafield/5", value: "Wolle" },
    ]);
    const former = await keepClearedMetafieldSlot(d, { shop: SHOP, productId: PRODUCT, namespace: "custom", key: "m" });
    expect(d.productMetafield.updateMany.mock.calls[0][0].where.id).toBe("gid://shopify/Metafield/5");
    expect(d.productMetafield.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["gid://shopify/Metafield/4"] }, product: { shop: SHOP } },
    });
    expect(former).toEqual(["gid://shopify/Metafield/5"]);
  });

  it("no cached row: nothing to keep", async () => {
    const d = db([]);
    expect(await keepClearedMetafieldSlot(d, { shop: SHOP, productId: PRODUCT, namespace: "c", key: "k" })).toEqual([]);
    expect(d.productMetafield.updateMany).not.toHaveBeenCalled();
  });
});

describe("dropSupersededMetafieldSlots", () => {
  it("deletes only slots of that key, never the kept row", async () => {
    const d = db([]);
    await dropSupersededMetafieldSlots(d, { shop: SHOP, productId: PRODUCT, namespace: "custom", key: "m", keepId: "gid://shopify/Metafield/9" });
    expect(d.productMetafield.deleteMany).toHaveBeenCalledWith({
      where: {
        productId: PRODUCT,
        product: { shop: SHOP },
        namespace: "custom",
        key: "m",
        value: "",
        id: { not: "gid://shopify/Metafield/9" },
      },
    });
  });
});

describe("upsertProductMetafields (every product sync)", () => {
  const tx = () => ({
    productMetafield: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $executeRaw: vi.fn(async () => 0),
  });

  it("a cleared slot survives the orphan sweep; real rows Shopify no longer returns do not", async () => {
    const t = tx();
    await upsertProductMetafields(t as never, PRODUCT, [
      { id: "gid://shopify/Metafield/1", namespace: "custom", key: "a", value: "x", type: "single_line_text_field" },
    ]);
    expect(t.productMetafield.deleteMany).toHaveBeenNthCalledWith(1, {
      where: { productId: PRODUCT, value: { not: "" }, id: { notIn: ["gid://shopify/Metafield/1"] } },
    });
  });

  it("a slot whose namespace/key Shopify reports again is superseded", async () => {
    const t = tx();
    await upsertProductMetafields(t as never, PRODUCT, [
      { id: "gid://shopify/Metafield/1", namespace: "custom", key: "a", value: "x", type: "single_line_text_field" },
    ]);
    expect(t.productMetafield.deleteMany).toHaveBeenNthCalledWith(2, {
      where: { productId: PRODUCT, value: "", OR: [{ namespace: "custom", key: "a" }] },
    });
  });

  it("a product with no metafields keeps its slots and loses every real row", async () => {
    const t = tx();
    await upsertProductMetafields(t as never, PRODUCT, []);
    expect(t.productMetafield.deleteMany).toHaveBeenCalledTimes(1);
    expect(t.productMetafield.deleteMany).toHaveBeenCalledWith({ where: { productId: PRODUCT, value: { not: "" } } });
    expect(t.$executeRaw).not.toHaveBeenCalled();
  });
});
