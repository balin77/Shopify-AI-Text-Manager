/**
 * The keys a translation repair CLAIMS, and the ones a merchant save marks so
 * that repair can see it.
 *
 * A resource carries several independent repairs — a product's own fields come
 * from the `products/update` webhook, its sub-resources and its alt texts from
 * their own saves — and they must not share one lock: claiming the product for
 * an alt-text run makes the webhook's field reconciliation bail for 30 seconds,
 * and with auto-translate on those field translations are then neither purged
 * nor refreshed, permanently, because the sync has advanced their digest
 * baseline by the time anything looks again.
 *
 * They live HERE, in one client-safe module, because both ends have to agree:
 * the repair passes the key as `RepairTarget.lockId`, and the save path that
 * writes a translation for the same surface marks the SAME key — otherwise the
 * "a merchant save abandons the run" rule is structurally dead and the AI
 * silently overwrites a hand-written value.
 */

/** A product's IMAGE alt texts (MediaImage resources). */
export function altTextLockId(productId: string): string {
  return `${productId}#altText`;
}

/** A product's options, option values and metafields. */
export function subResourceLockId(productId: string): string {
  return `${productId}#subResources`;
}

/** A collection's / article's featured-image alt. */
export function featuredAltLockId(parentId: string): string {
  return `${parentId}#featuredAlt`;
}
