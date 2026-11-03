/**
 * Who cached which primary value, and what was last confirmed.
 *
 * Several saves of one item can overlap (a Save pressed twice, an own AI save queued
 * behind a full save, a re-save after switching away and back). Each one caches the
 * values it carries before it is answered, so the cache entry of a field belongs to
 * the NEWEST request that carries it. A refused request may take back only what it
 * still owns, and what it takes back is the value an EARLIER request had confirmed
 * meanwhile (never "nothing", which would let a lagging read show the pre-save text
 * as if nobody had saved).
 *
 * A confirmation lives exactly as long as the overlay entry it can restore (the loader
 * deletes both together), so it needs no age. (The editor orders presses and edits of
 * the merchant on one counter of its own, `eventSeqRef`; that is not used here.)
 */

export type OverlayOwners = Record<string, Record<string, unknown>>;
export type OverlayConfirmed = Record<string, Record<string, { value: string; seq: number }>>;

/** A save's answer was a success: its values are what Shopify holds now. */
export function recordConfirmedValues(
  confirmed: OverlayConfirmed,
  itemId: string,
  sentFields: Record<string, string> | undefined,
  unconfirmed: ReadonlySet<string>,
  overlay: Record<string, string> | undefined,
  /** The editor's event number at the confirmation: orders it against loader reads. */
  seq = 0,
): void {
  if (!sentFields || !overlay) return;
  const byKey = (confirmed[itemId] ??= {});
  for (const [key, value] of Object.entries(sentFields)) {
    // Only a key the overlay still holds: after a Reload dropped it, nothing restores it.
    if (!unconfirmed.has(key) && key in overlay) byKey[key] = { value, seq };
  }
}

/**
 * A request that is refused (or never left) gives back the cache entries it still
 * owns. `cache` is the item's overlay; keys another request owns are left alone.
 */
export function forgetOwnedKeys(args: {
  cacheByItem: Record<string, Record<string, string>>;
  owners: OverlayOwners;
  confirmed: OverlayConfirmed;
  itemId: string;
  sentKeys: Iterable<string>;
  token: unknown;
  onlyKeys?: ReadonlySet<string>;
}): string[] {
  const { cacheByItem, owners, confirmed, itemId, sentKeys, token, onlyKeys } = args;
  const cached = cacheByItem[itemId];
  const itemOwners = owners[itemId];
  /** Keys whose cache entry changed (deleted or put back to a confirmed value). */
  const touched: string[] = [];
  for (const key of sentKeys) {
    if (onlyKeys && !onlyKeys.has(key)) continue;
    if (itemOwners && key in itemOwners && itemOwners[key] !== token) continue;
    if (cached) {
      const c = confirmed[itemId]?.[key];
      if (c) cached[key] = c.value;
      else delete cached[key];
      touched.push(key);
    }
    if (itemOwners) delete itemOwners[key];
  }
  if (cached && Object.keys(cached).length === 0) delete cacheByItem[itemId];
  return touched;
}

/** Nothing of the item is out any more: ownership has no use. (Confirmations end with the overlay entry itself.) */
export function pruneOwners(owners: OverlayOwners, itemId: string): void {
  delete owners[itemId];
}

/** What a primary save's form needs to remember beyond its values. */
export interface FormMeta {
  /** Keys announced as changed ONLY because a save ahead of it carried another value. */
  carryOnly: Set<string>;
  /** The form deliberately withholds `changedFields` (accept-and-translate writes the translations itself). */
  withheld: boolean;
}
