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
 * Whole-batch semantics: the batch is consumed only if it fits entirely. A
 * partial batch is never charged — callers reject the whole request so the
 * merchant sees a single clear quota error instead of a half-applied upload.
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
    const row = await tx.imageOperationCounter.upsert({
      where: { shop_period: { shop, period } },
      create: { shop, period, count: 0 },
      update: {},
    });

    const used = row.count;
    if (used + n > limit) {
      logger.info(
        `[ImageOps] Quota blocked for ${shop} (${plan}): used ${used}, +${n} > ${limit}`
      );
      return { allowed: false, used, limit, remaining: Math.max(0, limit - used) };
    }

    const updated = await tx.imageOperationCounter.update({
      where: { shop_period: { shop, period } },
      data: { count: { increment: n } },
    });

    return {
      allowed: true,
      used: updated.count,
      limit,
      remaining: Math.max(0, limit - updated.count),
    };
  });
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
