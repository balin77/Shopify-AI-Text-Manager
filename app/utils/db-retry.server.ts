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
 *
 * R4-DI8 — scope constraint (read before adding a caller): retrying
 * P2025/P2003 is only safe on an IDEMPOTENT, upsert-by-natural-key unit of
 * work, where those codes mean "a concurrent sync deleted the row I race to
 * (re)create" and a retry genuinely re-converges. The sole intended caller is
 * persistAltText() in api.apply-alt-text-templates.tsx (upsert on
 * (productId,mediaId) / (imageId,locale)). On a by-id update/delete path
 * P2025/P2003 are usually DETERMINISTIC (the row really is gone / FK really
 * is missing) — wrapping such code here would mask a real bug behind 4×
 * backoff. Do not reuse this helper there; pass a narrowed code set instead.
 */
const RACE_CODES = new Set(["P2002", "P2003", "P2025", "P2034", "P2028"]);

export async function withDbRaceRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  // R4-DI8: full jitter on top of the growing backoff. Locales now apply in
  // parallel and many can collide with the SAME long sync transaction at
  // once; a fixed schedule made them all retry in lock-step (thundering
  // herd, re-amplifying the collision). Jitter de-syncs the retriers.
  const baseMs = [100, 250, 500];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (i >= attempts - 1 || !RACE_CODES.has(e?.code)) throw e;
      const base = baseMs[Math.min(i, baseMs.length - 1)];
      const delay = Math.floor(base / 2 + Math.random() * base);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
