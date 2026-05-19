/**
 * Image-Operation Quota Util
 *
 * Atomic consume + read for the rolling monthly image-operation quota
 * (Bulk-Upload + WebP conversion). Our real variable cost is image compute/
 * bandwidth, not AI (tokens are merchant-funded BYO).
 *
 * Enforced lazily at the upload/convert routes — there is no downgrade cleanup
 * because the counter is usage data, not entitlement data (mirrors how the
 * product cap is enforced lazily; cleanup only ever prunes entitled content).
 * See docs/ROADMAP.md §Limit-Review Befund 3.
 */

import { db } from "../db.server";
import { type Plan } from "../config/plans";
import { getMonthlyImageOperationsLimit, currentImageOpPeriod } from "./planUtils";
import { logger } from "./logger.server";

export interface ConsumeResult {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Atomically reserve `n` image operations for the current (UTC) month.
 *
 * Whole-request semantics: this single call's `n` ops are consumed only if
 * they all fit; a partial `n` is never charged. NOTE this is per request, not
 * per UI drop: /api/convert-webp sends one request with n = images.length (so
 * a WebP batch is all-or-nothing), but the bulk uploader fires one
 * /api/staged-upload request per file (n = 1 each), so a 5-file drop with 3
 * ops left commits 3 and rejects 2 — that is acceptable and intended.
 */
export async function consumeImageOperations(
  shop: string,
  plan: Plan,
  n: number
): Promise<ConsumeResult> {
  const limit = getMonthlyImageOperationsLimit(plan);
  const period = currentImageOpPeriod();

  if (limit === 0) {
    return { allowed: false, used: 0, limit: 0, remaining: 0 };
  }

  return db.$transaction(async (tx) => {
    // Ensure the period row exists.
    await tx.imageOperationCounter.upsert({
      where: { shop_period: { shop, period } },
      create: { shop, period, count: 0 },
      update: {},
    });

    // Atomic conditional increment: the `count <= limit - n` predicate is
    // re-evaluated against the row at write time, so two concurrent requests
    // for the same shop cannot both pass the cap (closes the check-then-act
    // race; a plain read-then-write under READ COMMITTED could overbook).
    const res = await tx.imageOperationCounter.updateMany({
      where: { shop, period, count: { lte: limit - n } },
      data: { count: { increment: n } },
    });

    const row = await tx.imageOperationCounter.findUnique({
      where: { shop_period: { shop, period } },
      select: { count: true },
    });
    const used = row?.count ?? 0;

    if (res.count === 0) {
      logger.info(
        `[ImageOps] Quota blocked for ${shop} (${plan}): used ${used}, +${n} > ${limit}`
      );
      return { allowed: false, used, limit, remaining: Math.max(0, limit - used) };
    }

    return { allowed: true, used, limit, remaining: Math.max(0, limit - used) };
  });
}

/**
 * Refund `n` previously-consumed image operations for the current period.
 *
 * Image ops are reserved up-front (at batch creation) but the actual compute
 * happens asynchronously and can fail. Without a refund path the merchant is
 * billed monotonically for results that were never produced. Clamped at 0 so
 * a late refund (e.g. after a month rollover) can never drive the counter
 * negative.
 */
export async function refundImageOperations(
  shop: string,
  n: number
): Promise<void> {
  if (n <= 0) return;
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
    logger.info(`[ImageOps] Refunded ${n} op(s) for ${shop}: ${row.count} → ${next}`);
  } catch (err) {
    logger.error(
      `[ImageOps] Refund of ${n} op(s) failed for ${shop}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Read-only current usage for the Settings → Usage display (no increment).
 */
export async function getImageOperationUsage(
  shop: string
): Promise<{ count: number; period: string }> {
  const period = currentImageOpPeriod();
  const row = await db.imageOperationCounter.findUnique({
    where: { shop_period: { shop, period } },
    select: { count: true },
  });
  return { count: row?.count ?? 0, period };
}
