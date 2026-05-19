/**
 * Canonical image-operation refund — shared by the standalone .js runtime
 * services (webp-processor.service.js, task-recovery.service.js).
 *
 * These services are started directly by server.js via plain `node` (no TS
 * loader), so they cannot import the TypeScript canonical
 * app/utils/imageOperations.server.ts. This module is the single JS source
 * of truth instead of each service keeping its own inline copy; it mirrors
 * the TS refundImageOperations() exactly (same UTC YYYY-MM period key, same
 * clamp-at-0 read-modify-write). Keep the two in sync if either changes.
 *
 * Image ops are reserved up-front at WebP-batch creation; a task that fails
 * (incl. via stuck-task / restart recovery) produced no result, so the op
 * must be given back or the merchant is billed monotonically (R3-C4 / N-H4).
 */

/** UTC "YYYY-MM" — mirrors planUtils.currentImageOpPeriod(). */
export function currentImageOpPeriod(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Refund `n` image operations for `shop` in the current period. Clamped at 0
 * so a late refund can never drive the counter negative. Never throws —
 * refund failure must not break task recovery.
 *
 * @param {{ imageOperationCounter: any }} db Prisma client (app or standalone)
 * @param {string} shop
 * @param {number} n
 */
export async function refundImageOperations(db, shop, n) {
  if (!shop || !n || n <= 0) return;
  const period = currentImageOpPeriod();
  try {
    const row = await db.imageOperationCounter.findUnique({
      where: { shop_period: { shop, period } },
      select: { count: true },
    });
    if (!row) return;
    const next = Math.max(0, row.count - n);
    await db.imageOperationCounter.update({
      where: { shop_period: { shop, period } },
      data: { count: next },
    });
    console.log(`[ImageOps] Refunded ${n} op(s) for ${shop}: ${row.count} -> ${next}`);
  } catch (err) {
    console.error(`[ImageOps] Refund of ${n} op(s) failed for ${shop}:`, err);
  }
}
