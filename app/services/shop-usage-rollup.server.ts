/**
 * Hourly rollup of per-shop task statistics into ShopUsageDay
 * (PLAN_ADMIN_SHOP_OVERVIEW 3.2). Tasks live 3 days (runDatabaseCleanup deletes
 * them), a 7- or 30-day window on /admin cannot come from them, so the numbers
 * are copied into the durable per-day row BEFORE the tasks are deleted.
 *
 *  - Window: today, yesterday and the day before (UTC). A task of the day before
 *    yesterday is still there during all of today (3 day retention), so the last
 *    copy of a day always sees the whole day.
 *  - Idempotent and monotone: every column is `GREATEST(stored, recomputed)`, so
 *    a re-run changes nothing and a later run that sees fewer tasks (some were
 *    already deleted) can never lower a figure.
 *  - NEVER touches `activeSlots` / `actions`: those belong to the activity
 *    tracker (separate columns, absent from the UPDATE list).
 *  - Only for known shops (a ShopInstallState row or a Session): a rollup right
 *    after a redact must not re-create the rows redactShopData just removed.
 *    Rows that slip through (a race) disappear with the 90-day retention.
 *  - AI cost/tokens are the sums the TASKS recorded (Task.costMicros, input +
 *    output tokens); AI calls made outside a task are not in there. BigInt in
 *    the database, converted to Number only at the boundaries that display it.
 *
 * The window is bound as an ISO string cast to `timestamp`, the column type
 *    (timestamp(3), no zone), so it is right whatever the DB session TimeZone is.
 *
 * Never throws (returns 0 / the error is logged).
 */

import { logger } from "~/utils/logger.server";
import { utcDay } from "./shop-activity.shared";

export const SHOP_USAGE_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

type RawClient = {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
  shopUsageDay: { deleteMany: (args: { where: { day: { lt: Date } } }) => Promise<{ count: number }> };
};

/** Copy the tasks of the last three UTC days into ShopUsageDay. Returns the number of rows written. */
export async function rollupTaskUsage(db: RawClient, now: Date = new Date()): Promise<number> {
  try {
    const from = utcDay(now.getTime() - 2 * DAY_MS);
    return await db.$executeRaw`
      INSERT INTO "ShopUsageDay" ("id", "shop", "day", "tasksStarted", "tasksFailed", "aiCostMicros", "aiTokens", "updatedAt")
      SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text || t."shop" || t."d"::text), 1, 24),
             t."shop", t."d", t."started", t."failed", t."cost", t."tokens", NOW()
      FROM (
        SELECT "shop",
               "startedAt"::date AS "d",
               COUNT(*)::int AS "started",
               (COUNT(*) FILTER (WHERE "status" = 'failed'))::int AS "failed",
               COALESCE(SUM("costMicros"::bigint), 0)::bigint AS "cost",
               COALESCE(SUM("inputTokens"::bigint + "outputTokens"::bigint), 0)::bigint AS "tokens"
        FROM "Task"
        WHERE "startedAt" >= ${from.toISOString()}::timestamp
        GROUP BY "shop", "startedAt"::date
      ) t
      WHERE t."shop" IN (SELECT "shop" FROM "ShopInstallState" UNION SELECT "shop" FROM "Session")
      ON CONFLICT ("shop", "day") DO UPDATE SET
        "tasksStarted" = GREATEST("ShopUsageDay"."tasksStarted", EXCLUDED."tasksStarted"),
        "tasksFailed" = GREATEST("ShopUsageDay"."tasksFailed", EXCLUDED."tasksFailed"),
        "aiCostMicros" = GREATEST("ShopUsageDay"."aiCostMicros", EXCLUDED."aiCostMicros"),
        "aiTokens" = GREATEST("ShopUsageDay"."aiTokens", EXCLUDED."aiTokens"),
        "updatedAt" = NOW()`;
  } catch (error) {
    logger.warn(`[UsageRollup] task rollup failed: ${error instanceof Error ? error.name : "error"}`);
    return 0;
  }
}

/** Delete usage rows older than the retention. Returns how many went. */
export async function pruneShopUsage(db: RawClient, now: Date = new Date()): Promise<number> {
  try {
    const cutoff = utcDay(now.getTime() - SHOP_USAGE_RETENTION_DAYS * DAY_MS);
    const res = await db.shopUsageDay.deleteMany({ where: { day: { lt: cutoff } } });
    return res.count;
  } catch (error) {
    logger.warn(`[UsageRollup] retention failed: ${error instanceof Error ? error.name : "error"}`);
    return 0;
  }
}
