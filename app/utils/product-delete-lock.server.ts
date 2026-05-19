/**
 * Product Delete Lock (R4-DI5)
 *
 * Prevents an in-flight product sync from RESURRECTING a product that was
 * deleted while the sync was running.
 *
 * Race: a scheduled / products-update sync calls fetchProductData (product
 * still exists in Shopify), then a `products/delete` webhook fires and
 * deleteProduct() commits the delete, then the in-flight sync's
 * saveToDatabase() upserts the product (and its images/translations) back —
 * the deleted product lives on in the cache, and Shopify does NOT redeliver
 * the delete webhook, so it never self-heals.
 *
 * Shopify never reuses a product GID, so a deleted id can never legitimately
 * come back: a short deny-window keyed by productId is safe and only needs to
 * outlive a typical in-flight sync.
 */

const EXPIRY_MS = 120_000;
const MAX_ENTRIES = 1000;

const recentDeletes = new Map<string, number>();

function evictExpired(): void {
  const now = Date.now();
  for (const [id, ts] of recentDeletes) {
    if (now - ts > EXPIRY_MS) recentDeletes.delete(id);
  }
}

export function markProductDeleted(productId: string): void {
  recentDeletes.set(productId, Date.now());
  if (recentDeletes.size > MAX_ENTRIES) evictExpired();
}

export function isProductRecentlyDeleted(
  productId: string,
  windowMs = 60_000,
): boolean {
  const ts = recentDeletes.get(productId);
  if (!ts) return false;
  if (Date.now() - ts < windowMs) return true;
  recentDeletes.delete(productId);
  return false;
}
