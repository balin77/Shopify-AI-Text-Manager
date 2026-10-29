import { Prisma, PrismaClient } from "@prisma/client";

declare global {
  var __db: PrismaClient | undefined;
}

// Single shared PrismaClient instance across the entire process.
// Uses globalThis so standalone services (task-cleanup, task-recovery)
// can reuse the same instance instead of creating their own.
const prismaClientInstance = globalThis.__db ?? new PrismaClient();
globalThis.__db = prismaClientInstance;

// Named export as 'db'
export const db = prismaClientInstance;

// Default export
export default prismaClientInstance;

/**
 * Upsert product metafields using PostgreSQL ON CONFLICT DO UPDATE.
 * - Deletes orphaned metafields (present in DB but not in the new set)
 * - Inserts new metafields or updates existing ones atomically
 * Safe under concurrent execution (no unique constraint errors).
 */
export async function upsertProductMetafields(
  tx: Pick<PrismaClient, "productMetafield" | "$executeRaw">,
  productId: string,
  metafields: Array<{ id: string; namespace: string; key: string; value: string; type: string }>,
): Promise<void> {
  const metafieldIds = metafields.map((mf) => mf.id);

  // Delete metafields no longer returned by Shopify — except a CLEARED SLOT
  // (`value: ""`, product-metafields.shared.ts): Shopify never returns a
  // metafield this app deleted, so dropping the slot here would make the field
  // vanish from the editor's card on the next sync, which is exactly what the
  // slot exists to prevent. Shopify never stores a blank value, so a returned
  // metafield can never be mistaken for a slot.
  await tx.productMetafield.deleteMany({
    where: {
      productId,
      value: { not: "" },
      ...(metafieldIds.length > 0 ? { id: { notIn: metafieldIds } } : {}),
    },
  });
  // …but a slot whose namespace/key Shopify reports a real metafield for again
  // (set in the Shopify admin, by another app, an import) is superseded.
  if (metafields.length > 0) {
    await tx.productMetafield.deleteMany({
      where: {
        productId,
        value: "",
        OR: metafields.map((mf) => ({ namespace: mf.namespace, key: mf.key })),
      },
    });
  }

  // Bulk upsert via INSERT ... ON CONFLICT DO UPDATE (single atomic query)
  if (metafields.length > 0) {
    const values = metafields.map(
      (mf) => Prisma.sql`(${mf.id}, ${productId}, ${mf.namespace}, ${mf.key}, ${mf.value}, ${mf.type})`,
    );
    await tx.$executeRaw`
      INSERT INTO "ProductMetafield" (id, "productId", namespace, key, value, type)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (id) DO UPDATE SET
        namespace = EXCLUDED.namespace,
        key = EXCLUDED.key,
        value = EXCLUDED.value,
        type = EXCLUDED.type
    `;
  }
}
