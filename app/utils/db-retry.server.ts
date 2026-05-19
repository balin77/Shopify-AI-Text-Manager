/**
 * Retry a DB unit of work that can lose a race against a concurrent
 * transaction touching the same rows.
 *
 * The canonical case: saving an alt-text to Shopify fires a `products/update`
 * webhook whose product-sync handler wipes and recreates this product's
 * ProductImage rows inside a transaction. An "apply alt-text" request running
 * at the same time (and, since locales now apply in parallel, several at once)
 * can interleave with that and hit:
 *
 *  - P2002 unique violation   — both sides race to (re)create the same
 *                               (productId, mediaId) ProductImage row
 *  - P2003 FK violation       — the row we reference was deleted mid-flight
 *  - P2025 record not found   — same, on an update/delete path
 *  - P2034 write conflict /   — Postgres serialization failure or deadlock
 *          deadlock             between the two transactions (the canonical
 *                               "just retry me" code)
 *  - P2028 transaction timeout — our short interactive tx blocked on row locks
 *                               held by the long sync tx
 *
 * All of these are transient: a retry re-reads the now-consistent state and
 * succeeds. Backoff grows so a deadlock loser and a request waiting out a long
 * sync transaction both get enough room.
 */
const RACE_CODES = new Set(["P2002", "P2003", "P2025", "P2034", "P2028"]);

export async function withDbRaceRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  const backoffMs = [100, 250, 500];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (i >= attempts - 1 || !RACE_CODES.has(e?.code)) throw e;
      await new Promise((r) => setTimeout(r, backoffMs[Math.min(i, backoffMs.length - 1)]));
    }
  }
}
