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

/**
 * ONE product medium's alt, for a repair started by a PER-IMAGE save (the
 * image manager, the SKU generator, a template apply, the SEO fix). Those saves
 * come one image at a time — the image manager saves on every blur — and with
 * the product-wide key each save's claim ABORTED the previous image's run
 * mid-locale (its entries landing in neither list). A key per medium lets
 * image 2's save leave image 1's run alone, while a second save of the SAME
 * image still supersedes the run translating its older text.
 */
export function mediaAltLockId(productId: string, mediaId: string): string {
  return `${altTextLockId(productId)}:${mediaId}`;
}

/**
 * The key the PRODUCT SYNC's shield asks for beside `altTextLockId` — marked by
 * every alt repair, watched by no repair. A per-medium repair must still keep
 * the `products/update` sync from rewriting the alt-translation cache from a
 * read-back that has not caught up, without claiming the product-wide lock a
 * product-editor run is watching.
 */
export function altTextSyncShieldId(productId: string): string {
  return `${productId}#altTextShield`;
}

/** A product's options, option values and metafields. */
export function subResourceLockId(productId: string): string {
  return `${productId}#subResources`;
}

/** A collection's / article's featured-image alt. */
export function featuredAltLockId(parentId: string): string {
  return `${parentId}#featuredAlt`;
}

/**
 * The same surface written on a MARKET layer — a key only the SYNCS ask for.
 *
 * The mark answers two different questions and they disagree about layers. A
 * REPAIR writes global rows only, so a market override can never collide with
 * it, and a mark it can see would abort a run it does not conflict with,
 * leaving that run's remaining entries in neither list — neither refreshed nor
 * removed. The SYNCS have the opposite need: their translation-cache rewrite
 * deletes every layer it fetched and re-inserts from a read Shopify may not be
 * consistent on yet, so a market translation saved a second ago has to shield
 * itself just as a global one does.
 *
 * So a market write marks THIS key instead, and every sync shield asks for it
 * beside the plain one. Answering the conflict by marking nothing (the first
 * cut) silently gave the market layer back the bug the whole module exists to
 * prevent.
 */
export function marketLayerLockId(lockId: string): string {
  return `${lockId}#market`;
}
