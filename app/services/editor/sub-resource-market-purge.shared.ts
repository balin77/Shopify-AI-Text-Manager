/**
 * Market overrides of sub-resources (option names, option values, metafields)
 * that a PRIMARY save's purge confirmed removed on Shopify, while the loaded
 * item still carries their rows until it is re-read. The server names the
 * resource ids (`marketPurgedResourceIds`, confirmed ones only); the page keeps
 * them in a map id -> the item that was loaded WHEN the answer arrived, which
 * hides those resources' MARKET rows (the global row then shows through, as on
 * the storefront). The hide lasts until the item is re-read - a different item
 * object - and never longer: retiring on "no market row left" could keep a
 * resource hidden for good and then hide an override the merchant writes later.
 * Import-free: the hook and the tests share it.
 */

/** Drop every hide that was made against an item other than `currentItem`. */
export function retirePurgedMarketResources(
  hidden: Map<string, unknown>,
  currentItem: unknown,
): void {
  for (const [id, itemAtHide] of [...hidden]) {
    if (itemAtHide !== currentItem) hidden.delete(id);
  }
}
