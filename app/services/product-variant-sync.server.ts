/**
 * Variant rows in the regular product sync (docs/plans/PLAN_BULK_EDITOR.md
 * §5.1) — shared by BOTH product write paths (syncAllProducts' writeProduct
 * and syncProduct's saveToDatabase in product-sync.service.ts) and by the
 * bulk editor's echo mirror (apply.server.ts).
 *
 * Invariants:
 *
 * - NO deleteMany+createMany like images/options: `galleryJson` and
 *   `imageKey` come from the image manager (api.product-variants.tsx /
 *   api.update-variant-match-key.tsx) and MUST survive the sync. The update
 *   payload therefore never mentions them; removal is a targeted deleteMany
 *   of only the ids Shopify no longer returned.
 * - Money-string → Decimal conversion happens in exactly ONE place:
 *   moneyToDecimalString below (§5.2). Everything that writes
 *   ProductVariant.price/compareAtPrice goes through it.
 * - A missing `variants` block (query error, partial response) syncs NOTHING
 *   and deletes NOTHING — never wipe cached rows on uncertainty.
 * - PLAN_CONTENT_CREATION Phase 4: the COMMERCE block (cost, shipping, customs)
 *   is picked up here OPPORTUNISTICALLY — `variantCommerceColumns` returns `{}`
 *   for a response that did not carry it, so a narrower query cannot overwrite
 *   what a full read established, and cannot stamp `commerceSyncedAt`.
 *
 *   STOCK is deliberately NOT synced here. Two reasons, both decisive: the
 *   selection costs roughly 60 points per variant, so embedding it in a
 *   100-product batch query blows past Shopify's 1000-point ceiling; and stock
 *   is volatile, so a value written by a nightly catalogue sync is wrong by
 *   morning. `/api/product-commerce` reads it live per product instead.
 */

import { variantCommerceColumns, type ShopifyVariantCommerce } from "./commerce-sync.shared";

/** Variant node shape of the sync queries (getProductsBulk / getProduct). */
export interface ShopifySyncVariant {
  /** gid://shopify/ProductVariant/... */
  id: string;
  title: string;
  sku: string | null;
  /** Shopify Money scalar — a decimal STRING ("12.5", "1299.9"). */
  price: string | null;
  compareAtPrice: string | null;
  position: number;
  barcode: string | null;
  image?: { url: string } | null;
  /** PLAN Phase 4 — present only when the query selected the commerce block. */
  taxable?: boolean | null;
  inventoryPolicy?: string | null;
  inventoryItem?: ShopifyVariantCommerce["inventoryItem"];
}

/**
 * THE Money-string → Decimal-column conversion (Plan §5.2 — "an genau EINER
 * Stelle"). Shopify Money is a plain decimal string with a dot; normalize to
 * two fraction digits so the DB mirror is byte-comparable. Anything
 * non-numeric or negative maps to null — a corrupt price must not crash a
 * 100-product sync batch.
 */
export function moneyToDecimalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) return null;
  return num.toFixed(2);
}

/** Structural slice of Prisma.TransactionClient the upsert needs — keeps the
 * helper unit-testable with a plain mock (no Prisma engine in tests). The
 * args are `any` on purpose: Prisma's generated delegates are generic and do
 * not structurally match narrowed literal arg types. */
export interface VariantSyncTx {
  productVariant: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteMany(args: any): Promise<unknown>;
  };
}

/**
 * Upserts the product's variant rows from a sync fetch and deletes the rows
 * whose ids Shopify no longer returned. Targeted upsert on shopifyGid —
 * NEVER delete+recreate (see module head). `variants` null/undefined means
 * "the query did not deliver the block": skip entirely, keep the cache.
 *
 * `hasNextPage` (review Finding 4): the sync fetches variants(first:100)
 * WITHOUT pagination (Plan §5.1). When Shopify reports more pages, the
 * fetched list is only a WINDOW — a cached row absent from it may simply
 * live beyond the window, so deleting `notIn: keptGids` would wipe real
 * variants (including their image-manager galleryJson/imageKey). Deletion is
 * therefore skipped entirely for such products; truly deleted variants are
 * cleaned up once the product drops to ≤100 variants, and the UI already
 * flags the capped window via Product.hasMoreVariants.
 */
export async function syncProductVariantRows(
  tx: VariantSyncTx,
  productId: string,
  variants: ShopifySyncVariant[] | null | undefined,
  hasNextPage: boolean = false,
): Promise<void> {
  if (!variants) return;

  const keptGids: string[] = [];
  for (const variant of variants) {
    if (!variant?.id) continue;
    keptGids.push(variant.id);
    const numericId = variant.id.replace("gid://shopify/ProductVariant/", "");
    // `{}` when the query did not select the block — so this spread adds
    // nothing and the existing columns (and `commerceSyncedAt`) survive.
    const commerce = variantCommerceColumns(variant as ShopifyVariantCommerce);
    const shared = {
      title: variant.title,
      sku: variant.sku ?? null,
      position: variant.position,
      price: moneyToDecimalString(variant.price),
      compareAtPrice: moneyToDecimalString(variant.compareAtPrice),
      barcode: variant.barcode ?? null,
      ...commerce,
    };
    await tx.productVariant.upsert({
      where: { shopifyGid: variant.id },
      create: {
        id: numericId,
        shopifyGid: variant.id,
        productId,
        ...shared,
        // galleryJson/imageKey start null — the image manager owns them.
      },
      // galleryJson/imageKey deliberately ABSENT from the update — image
      // manager data must survive every sync (§5.1/§10.3).
      update: { productId, ...shared },
    });

  }

  // Targeted removal of vanished variants only. An empty keptGids list means
  // Shopify really returned zero variants for the product — remove all rows.
  // With hasNextPage the fetched list is a truncated window (see doc above):
  // NEVER delete on partial knowledge.
  if (hasNextPage) return;
  await tx.productVariant.deleteMany({
    where: { productId, shopifyGid: { notIn: keptGids } },
  });
}
