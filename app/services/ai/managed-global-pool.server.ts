/**
 * The GLOBAL cap on managed AI spend — PLAN_MANAGED_AI_KEY §9.3.
 *
 * Per-shop budgets bound what one merchant can cost us. They do not bound what
 * a BUG can: a meter that under-counts, a model priced at a guessed ceiling, a
 * webhook storm across every shop at once. This is the outer ring, and its job
 * is to make the worst case one configured month's budget instead of an
 * unbounded invoice.
 *
 * **Two pools, not one.** A PAID pool sized from the subscriptions actually
 * sold, and a smaller TASTER pool. With a single pool, a listing spike of free
 * installs spending their tasters trips the cap on the 18th and answers 503 to
 * every paying merchant for the rest of the month — free shops are the least
 * accountable population this plan has, and they must not be able to refuse
 * the revenue that funds it.
 *
 * Both limits are read from the environment and default to ZERO-as-unlimited
 * rather than zero-as-blocked: an operator who has not configured a pool has
 * not asked for a cap, and a cap nobody set must not silently stop a paying
 * merchant's work. The provider-side spend cap (§9.5) is the independent
 * second failure this leans on.
 */

import { logger } from "../../utils/logger.server";
import { currentAiUsagePeriod } from "./usage-meter.server";

export type ManagedPool = "paid" | "taster";

/**
 * The period a POOL is counted in — a UTC calendar month, and deliberately
 * NOT the key the per-shop ledger uses.
 *
 * That difference is the whole point, and getting it wrong made the word
 * "global" false. The shop-side key is the SHOP's billing period (`b:<end>`),
 * which is a different string for every sign-up date, plus `taster` for every
 * shop with no period budget. Keying the pool on it sharded the counter into
 * one row per distinct billing-period-end in the install base — each row
 * getting the full limit, so 28 sign-up dates meant 28 times the ceiling the
 * operator configured — while the `taster` row never rolled over at all and
 * became a LIFETIME total, i.e. a cap that, once reached, would have refused
 * every free shop for good.
 *
 * It is computed INSIDE this module rather than passed in, because the reader
 * and the writer disagreeing about it is exactly what happened: both took a
 * `period` argument and both were handed the caller's shop-side one.
 */
export function globalPoolPeriod(now: Date = new Date()): string {
  return currentAiUsagePeriod(now);
}

/** Micro-euro ceiling for a pool, or `null` for "no cap configured". */
export function poolLimitMicros(pool: ManagedPool): number | null {
  const raw =
    pool === "taster"
      ? process.env.MANAGED_AI_TASTER_POOL_MICROS
      : process.env.MANAGED_AI_POOL_MICROS;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export interface GlobalPoolStatus {
  pool: ManagedPool;
  period: string;
  spentMicros: number;
  limitMicros: number | null;
  /** May a managed call START? Unlimited when no cap is configured. */
  allowed: boolean;
}

/**
 * Has this pool anything left?
 *
 * Read-only and cheap: one indexed lookup. Never throws — a failed read
 * ALLOWS, which is the opposite of the per-shop budget's rule and deliberate.
 * The per-shop budget refusing on unread evidence protects our money against
 * one shop; this refusing on unread evidence would stop every managed shop in
 * the app because one query timed out, and the per-shop budgets are still
 * enforcing underneath.
 */
export async function globalPoolStatus(
  pool: ManagedPool,
  period: string = globalPoolPeriod(),
): Promise<GlobalPoolStatus> {
  const limitMicros = poolLimitMicros(pool);
  if (limitMicros === null) {
    return { pool, period, spentMicros: 0, limitMicros: null, allowed: true };
  }

  try {
    const { db } = await import("../../db.server");
    const row = await db.managedAiGlobalCounter.findUnique({
      where: { period_pool: { period, pool } },
      select: { costMicros: true },
    });
    const spentMicros = Number(row?.costMicros ?? 0);
    return { pool, period, spentMicros, limitMicros, allowed: spentMicros < limitMicros };
  } catch (error) {
    logger.error(
      `[ManagedAI] Global pool read failed (${pool}/${period}): ${
        error instanceof Error ? error.message : String(error)
      } — allowing, per-shop budgets still apply`,
    );
    return { pool, period, spentMicros: 0, limitMicros, allowed: true };
  }
}

/**
 * Add one call's cost to a pool. Never throws — this runs after a call that
 * has already been made and paid for.
 *
 * `failoverMicros` is the part we ABSORB: the gap between what the provider
 * charged and what the merchant's budget was debited. It is the number §3a
 * rule 4's failover budget is measured against, and keeping it apart from the
 * total is what makes "how much did the outage cost us" answerable at all.
 */
export async function addGlobalPoolSpend(
  pool: ManagedPool,
  costMicros: number,
  failoverMicros = 0,
  period: string = globalPoolPeriod(),
): Promise<void> {
  if (costMicros <= 0 && failoverMicros <= 0) return;
  try {
    const { db } = await import("../../db.server");
    await db.managedAiGlobalCounter.upsert({
      where: { period_pool: { period, pool } },
      create: {
        period,
        pool,
        costMicros: BigInt(Math.max(0, costMicros)),
        failoverMicros: BigInt(Math.max(0, failoverMicros)),
      },
      update: {
        costMicros: { increment: BigInt(Math.max(0, costMicros)) },
        failoverMicros: { increment: BigInt(Math.max(0, failoverMicros)) },
      },
    });
  } catch (error) {
    logger.error(
      `[ManagedAI] Global pool write failed (${pool}/${period}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * The GLOBAL failover budget — §3a rule 4, and the one number the margin
 * guard deliberately cannot see.
 *
 * The fallback is ~14x the default and the merchant is billed at the default
 * price whatever ran (rule 1), so every failover-served call is a gap WE
 * absorb. `failoverMicros` is the sum of those gaps; this is the ceiling on
 * it. Spent, the failover stops and the primary's own error reaches the
 * caller — which on a detached repair is still an ABORT, because a managed
 * refusal is what the caller is handed, never "the AI could not deliver".
 *
 * Same zero-as-unlimited reading as the pools above: an operator who set no
 * budget did not ask for a cap.
 */
export function failoverBudgetMicros(): number | null {
  const raw = process.env.MANAGED_AI_FAILOVER_POOL_MICROS;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Has the global failover budget been spent?
 *
 * Never throws, and a failed read ALLOWS — the same rule as the pool it sits
 * beside and for the same reason: the per-shop failover CEILING refuses on
 * unread evidence and is what bounds the exploit, while refusing here on a
 * query timeout would take the outage response away from every shop at once.
 */
export async function failoverBudgetExhausted(
  period: string = globalPoolPeriod(),
): Promise<boolean> {
  const limit = failoverBudgetMicros();
  if (limit === null) return false;
  try {
    const { db } = await import("../../db.server");
    const rows = await db.managedAiGlobalCounter.findMany({
      where: { period },
      select: { failoverMicros: true },
    });
    const spent = rows.reduce((n, row) => n + Number(row.failoverMicros ?? 0), 0);
    if (spent >= limit) {
      logger.error(
        `[ManagedAI] The global failover budget for ${period} is spent ` +
          `(${(spent / 1e6).toFixed(2)} of ${(limit / 1e6).toFixed(2)} EUR). ` +
          `Managed calls now fail on their own provider's error instead of paying 14x.`,
      );
      return true;
    }
    return false;
  } catch (error) {
    logger.error(
      `[ManagedAI] Failover budget read failed (${period}): ${
        error instanceof Error ? error.message : String(error)
      } — allowing, the per-shop ceiling still applies`,
    );
    return false;
  }
}

/** Warn once per process per pool+period when a pool crosses its alert line. */
const alerted = new Set<string>();
export const POOL_ALERT_THRESHOLD = 0.5;

export function alertIfPoolLow(status: GlobalPoolStatus): void {
  if (status.limitMicros === null) return;
  const share = status.spentMicros / status.limitMicros;
  if (share < POOL_ALERT_THRESHOLD) return;
  const key = `${status.pool}:${status.period}`;
  if (alerted.has(key)) return;
  alerted.add(key);
  logger.error(
    `[ManagedAI] The ${status.pool} pool for ${status.period} is ${Math.round(share * 100)}% spent ` +
      `(${(status.spentMicros / 1e6).toFixed(2)} of ${(status.limitMicros / 1e6).toFixed(2)} EUR). ` +
      `At 100% every managed shop in this pool answers 503 for the rest of the month.`,
  );
}
