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
 * R3-H9 — accepted cross-period edge case (deliberately NOT fixed):
 * the refund targets the CURRENT period, not the period the op was consumed
 * in. If a WebP task is created late on the last day of a month and
 * fails/recovers after the UTC month rollover, the refund hits the new
 * month's row (or no-ops if that row doesn't exist yet, thanks to the
 * `if (!row) return`). Worst case is a ±1-op skew at a month boundary for a
 * task that both spans midnight UTC *and* fails. Properly fixing it would
 * require persisting the consume-period on every Task row and threading it
 * through all failure paths — disproportionate for a rare, ±1, self-bounded
 * (clamped, no-op-if-absent) discrepancy. Mitigation accepted; documented
 * so a future reader doesn't "fix" it without weighing that cost.
 *
 * @param {{ imageOperationCounter: any }} db Prisma client (app or standalone)
 * @param {string} shop
 * @param {number} n
 */
export async function refundImageOperations(db, shop, n) {
  if (!shop || !n || n <= 0) return;
  const period = currentImageOpPeriod();
  try {
    // R4-DI3: ONE atomic, clamped statement. The old
    // findUnique → Math.max(0,count-n) → blind update was a read-modify-write
    // that discarded any concurrent consume-increment (lost update →
    // undercount → monthly cap bypass / revenue leak; two parallel refunds
    // also lost each other). GREATEST clamps at 0 in the same statement.
    const affected = await db.$executeRaw`
      UPDATE "ImageOperationCounter"
      SET "count" = GREATEST("count" - ${n}, 0), "updatedAt" = NOW()
      WHERE "shop" = ${shop} AND "period" = ${period}
    `;
    if (affected > 0) {
      console.log(`[ImageOps] Refunded ${n} op(s) for ${shop} (period ${period})`);
    }
  } catch (err) {
    // R3-M9: console.* (not the winston `loggers`) is deliberate here — this
    // module is loaded by the standalone node services (webp-processor,
    // task-recovery) started directly from server.js, which cannot import
    // the TS app logger; there is also no server-side Sentry transport, so
    // there are no breadcrumbs to scrub. We still avoid dumping the raw error
    // object (→ "[object Object]" / lost stack): log message + stack only.
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    console.error(`[ImageOps] Refund of ${n} op(s) failed for ${shop}: ${detail}`);
  }
}
