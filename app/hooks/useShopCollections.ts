/**
 * The shop's collections, as the membership pickers offer them.
 *
 * Two pickers read this list — the single editor's `CollectionsField` and the
 * bulk grid's collections cell — and the grid renders one per ROW, so a fetch
 * per mounted picker would be fifty identical requests on a page of products.
 *
 * So requests are COALESCED, not remembered: every picker that mounts within
 * `FRESH_FOR_MS` of a request shares it, and the first one after that asks
 * again. A module-scope memo that lived for the whole SPA session was the first
 * cut, and it silently changed the editor's behaviour — `CollectionsField` used
 * to fetch on every mount, so a collection created a minute ago, or one the
 * collection sync had just measured as rule-based, showed up the next time the
 * merchant opened a product. Under a session-long memo it did not until a full
 * browser reload, and a stale "manual" flag is exactly the unlocked row whose
 * join Shopify then refuses.
 *
 * Three states, never two: `null` while in flight, `{ ok: false }` when the
 * lookup failed, and a list otherwise. A failed lookup rendered as an EMPTY
 * list would read as "this shop has no collections" and invite the merchant to
 * untick every membership — so a failure is dropped from the memo (the next
 * picker to mount asks again) and reported as such.
 */

import { useEffect, useState } from "react";
import type { CollectionOption } from "~/routes/api.product-taxonomy";

export type ShopCollectionsLoaded =
  | { ok: true; collections: CollectionOption[]; truncated: boolean }
  | { ok: false };

/** Long enough that one grid page's cells, which mount in the same few
 *  milliseconds, share one request; short enough that navigating to another
 *  product asks again. */
const FRESH_FOR_MS = 10_000;

let inFlight: Promise<ShopCollectionsLoaded> | null = null;
let startedAt = 0;

export function loadShopCollections(now: number = Date.now()): Promise<ShopCollectionsLoaded> {
  if (inFlight && now - startedAt < FRESH_FOR_MS) return inFlight;
  startedAt = now;
  const request = fetch("/api/product-taxonomy?kind=collections")
    .then((r) => r.json())
    .then((data): ShopCollectionsLoaded =>
      data?.success
        ? {
            ok: true,
            collections: (data.collections ?? []) as CollectionOption[],
            truncated: data.truncated === true,
          }
        : { ok: false },
    )
    .catch((): ShopCollectionsLoaded => ({ ok: false }));
  inFlight = request;
  void request.then((result) => {
    if (!result.ok) inFlight = null;
  });
  return request;
}

/**
 * `enabled` lets a caller defer the request until it is really needed — the
 * grid asks only when a collections cell is on screen, so a product page with
 * the column hidden costs nothing.
 */
export function useShopCollections(enabled = true): ShopCollectionsLoaded | null {
  const [loaded, setLoaded] = useState<ShopCollectionsLoaded | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadShopCollections().then((result) => {
      if (!cancelled) setLoaded(result);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return loaded;
}

/** Test seam: forget the memoised request. */
export function resetShopCollectionsForTests(): void {
  inFlight = null;
}
