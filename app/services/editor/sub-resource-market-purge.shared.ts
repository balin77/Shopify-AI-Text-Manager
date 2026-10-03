/**
 * Market overrides of sub-resources (option names, option values, metafields)
 * that a PRIMARY save's purge confirmed removed on Shopify, while the loaded
 * item still carries their rows until it is re-read. The server names the
 * resource ids (`marketPurgedResourceIds`, confirmed ones only); the page keeps
 * them in a set that hides those resources' MARKET rows (the global row then
 * shows through, as it does on the storefront) until the re-read item no longer
 * holds them. Import-free: the hook and the tests share it.
 */
export type SubResourceTranslationRows = Record<
  string,
  Array<{ key: string; value: string; locale: string; marketId?: string }>
>;

/** Drop the ids the (re-read) item no longer carries a market row for. */
export function retirePurgedMarketResources(
  hidden: Set<string>,
  rows: SubResourceTranslationRows | undefined,
): void {
  if (hidden.size === 0) return;
  for (const id of [...hidden]) {
    const stillThere = (rows?.[id] ?? []).some((row) => (row.marketId ?? "") !== "");
    if (!stillThere) hidden.delete(id);
  }
}
