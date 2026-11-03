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
 * One monotonic counter orders everything: a request's press, a confirmation, an
 * edit of the merchant. "Confirmed after this request was pressed" is a comparison
 * of two numbers, so no clock and no flag per case is needed.
 */

export type OverlayOwners = Record<string, Record<string, unknown>>;
export type OverlayConfirmed = Record<string, Record<string, { value: string; seq: number }>>;

/** A save's answer was a success: its values are what Shopify holds now. */
export function recordConfirmedValues(
  confirmed: OverlayConfirmed,
  itemId: string,
  sentFields: Record<string, string> | undefined,
  unconfirmed: ReadonlySet<string>,
  seq: number,
): void {
  if (!sentFields) return;
  const byKey = (confirmed[itemId] ??= {});
  for (const [key, value] of Object.entries(sentFields)) {
    if (!unconfirmed.has(key)) byKey[key] = { value, seq };
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
  pressSeq: number | undefined;
  onlyKeys?: ReadonlySet<string>;
}): void {
  const { cacheByItem, owners, confirmed, itemId, sentKeys, token, pressSeq, onlyKeys } = args;
  const cached = cacheByItem[itemId];
  const itemOwners = owners[itemId];
  for (const key of sentKeys) {
    if (onlyKeys && !onlyKeys.has(key)) continue;
    if (itemOwners && key in itemOwners && itemOwners[key] !== token) continue;
    if (cached) {
      const c = confirmed[itemId]?.[key];
      if (c && pressSeq !== undefined && c.seq > pressSeq) cached[key] = c.value;
      else delete cached[key];
    }
    if (itemOwners) delete itemOwners[key];
  }
  if (cached && Object.keys(cached).length === 0) delete cacheByItem[itemId];
}

/** Nothing of the item is out any more: ownership and confirmations have no use. */
export function pruneOwnership(owners: OverlayOwners, confirmed: OverlayConfirmed, itemId: string): void {
  delete owners[itemId];
  delete confirmed[itemId];
}
