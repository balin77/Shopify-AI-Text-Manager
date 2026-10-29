/**
 * The cache half of the CLEARED-SLOT rule (see `product-metafields.shared.ts`).
 *
 * A metafield deleted on Shopify keeps its `ProductMetafield` row with
 * `value: ""`, so the editor's card can still show the field and re-create the
 * metafield from the row's namespace/key/type. Both write paths that delete a
 * product metafield (the card's primary save and the bulk editor) and both
 * that create one go through here, so a product never ends up with a slot AND
 * a real row for the same namespace/key.
 *
 * The rows carry no shop column; tenancy rides on the product relation, like
 * every other ProductMetafield query.
 */

import { CLEARED_METAFIELD_VALUE } from "./product-metafields.shared";

type SlotDb = {
  productMetafield: {
    findMany: (args: any) => Promise<Array<{ id: string; value: string }>>;
    updateMany: (args: any) => Promise<unknown>;
    deleteMany: (args: any) => Promise<unknown>;
  };
};

/**
 * After a CONFIRMED `metafieldsDelete`: keep ONE row of that namespace/key as
 * the cleared slot and drop any other. Returns the ids of the rows that held a
 * real value — the GIDs whose translation rows the caller deletes (the
 * translations went with the metafield on Shopify).
 */
export async function keepClearedMetafieldSlot(
  db: SlotDb,
  args: { shop: string; productId: string; namespace: string; key: string },
): Promise<string[]> {
  const rows = await db.productMetafield.findMany({
    where: { productId: args.productId, product: { shop: args.shop }, namespace: args.namespace, key: args.key },
    select: { id: true, value: true },
  });
  if (rows.length === 0) return [];
  const keep = rows.find((row) => row.value !== CLEARED_METAFIELD_VALUE) ?? rows[0];
  await db.productMetafield.updateMany({
    where: { id: keep.id, product: { shop: args.shop } },
    data: { value: CLEARED_METAFIELD_VALUE },
  });
  const extra = rows.filter((row) => row.id !== keep.id).map((row) => row.id);
  if (extra.length > 0) {
    await db.productMetafield.deleteMany({ where: { id: { in: extra }, product: { shop: args.shop } } });
  }
  return rows.filter((row) => row.value !== CLEARED_METAFIELD_VALUE).map((row) => row.id);
}

/**
 * After a CONFIRMED `metafieldsSet` created (or re-created) a metafield: the
 * slot of that namespace/key has a real row again and goes. `keepId` is the
 * echoed GID's row, never deleted.
 */
export async function dropSupersededMetafieldSlots(
  db: SlotDb,
  args: { shop: string; productId: string; namespace: string; key: string; keepId: string },
): Promise<void> {
  await db.productMetafield.deleteMany({
    where: {
      productId: args.productId,
      product: { shop: args.shop },
      namespace: args.namespace,
      key: args.key,
      value: CLEARED_METAFIELD_VALUE,
      id: { not: args.keepId },
    },
  });
}
