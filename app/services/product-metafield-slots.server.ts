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

// ─── Live check before a slot is re-created ────────────────────────────────

/** What Shopify holds RIGHT NOW under a slot's namespace/key. */
export type LiveSlotState =
  | { kind: "absent" }
  | { kind: "exists"; metafield: { id: string; namespace: string; key: string; value: string; type: string } }
  /** The read failed or answered something unreadable: nothing is known. */
  | { kind: "unknown" };

type SlotGraphql = (
  query: string,
  options: { variables: Record<string, unknown> },
) => Promise<{ json: () => Promise<unknown> }>;

/** Aliases per query: each is a cheap single-field lookup on one product. */
const SLOT_READS_PER_QUERY = 25;

/**
 * Re-creating a metafield from a CLEARED SLOT is `metafieldsSet`, an UPSERT by
 * (owner, namespace, key). The slot only says that THIS app deleted the
 * metafield once; a real metafield of that namespace/key may exist on Shopify
 * by now (set in the admin, by another app, or simply beyond a sync's window),
 * and the set would overwrite it silently. So the save asks Shopify first, one
 * aliased `product { metafield(namespace:, key:) }` lookup per slot.
 *
 * Returns one state per slot, in order. A failed read (throw, top-level
 * errors, no product in the answer, an alias missing) is `unknown` for every
 * slot of that query — the caller must not write on `unknown`.
 */
export async function readLiveSlotMetafields(
  graphql: SlotGraphql,
  productId: string,
  slots: Array<{ namespace: string; key: string }>,
): Promise<LiveSlotState[]> {
  const states: LiveSlotState[] = slots.map(() => ({ kind: "unknown" }));
  for (let start = 0; start < slots.length; start += SLOT_READS_PER_QUERY) {
    const chunk = slots.slice(start, start + SLOT_READS_PER_QUERY);
    const variableDefs = chunk.map((_, i) => `$ns${i}: String!, $key${i}: String!`).join(", ");
    const fields = chunk
      .map(
        (_, i) => `m${i}: metafield(namespace: $ns${i}, key: $key${i}) {
        id
        namespace
        key
        value
        type
      }`,
      )
      .join("\n      ");
    // Aliases are generated (m0, m1, ...) and every value rides in variables.
    const query = `#graphql
  query contentPilotSlotMetafields($id: ID!, ${variableDefs}) {
    product(id: $id) {
      id
      ${fields}
    }
  }`;
    const variables: Record<string, unknown> = { id: productId };
    chunk.forEach((slot, i) => {
      variables[`ns${i}`] = slot.namespace;
      variables[`key${i}`] = slot.key;
    });
    let product: Record<string, unknown> | null = null;
    try {
      const response = await graphql(query, { variables });
      const payload = (await response.json()) as {
        data?: { product?: Record<string, unknown> | null } | null;
        errors?: unknown;
      };
      const hasErrors = Array.isArray(payload?.errors) && payload.errors.length > 0;
      product = !hasErrors && payload?.data?.product ? payload.data.product : null;
    } catch {
      product = null;
    }
    if (!product) continue; // every slot of this chunk stays `unknown`
    chunk.forEach((slot, i) => {
      const alias = `m${i}`;
      if (!(alias in product!)) return; // unknown
      const node = product![alias] as
        | { id?: unknown; namespace?: unknown; key?: unknown; value?: unknown; type?: unknown }
        | null;
      if (node === null) {
        states[start + i] = { kind: "absent" };
        return;
      }
      if (
        !node ||
        typeof node.id !== "string" ||
        typeof node.value !== "string" ||
        typeof node.type !== "string"
      ) {
        return; // unknown: an answer that cannot be mirrored is not knowledge
      }
      states[start + i] = {
        kind: "exists",
        metafield: {
          id: node.id,
          namespace: typeof node.namespace === "string" ? node.namespace : slot.namespace,
          key: typeof node.key === "string" ? node.key : slot.key,
          value: node.value,
          type: node.type,
        },
      };
    });
  }
  return states;
}
