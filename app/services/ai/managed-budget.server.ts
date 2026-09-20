/**
 * Has this shop any managed AI budget left? — PLAN_MANAGED_AI_KEY §6, §7, §7a.
 *
 * The LIMIT comes from the plan table (`app/config/managed-ai-budget.ts`, the
 * same numbers the Settings card renders); the USED figure comes from the
 * Phase 0 meter's `billedMicros`, which is what the merchant is charged rather
 * than what we paid — the two diverge on a failover and only one of them is
 * the merchant's business.
 *
 * **The reservation problem, stated rather than hidden.** A call's cost is not
 * knowable before it runs, so a hard cap cannot be exact. The rule is that a
 * call may START only while `remaining > 0`; the overshoot is bounded by
 * `AI_QUEUE_CONCURRENCY` x the worst-case single call x the number of web
 * instances — ONE in production (RAILWAY-SETUP.md §0), which is what makes
 * that a real bound. Reserving the worst case up front instead would refuse
 * the last 80 % of every budget, and checking only afterwards would have no
 * bound at all. §7's margin guard is what leaves headroom for the difference.
 */

import type { AISettings } from "@prisma/client";
import type { BillingPlan } from "../../config/billing";
import {
  managedBudgetMicros,
  type BudgetContext,
} from "../../config/managed-ai-budget";
import { resolveDevPlanMode } from "../dev-plan-override.server";
import { currentAiUsagePeriod } from "./usage-meter.server";
import { logger } from "../../utils/logger.server";

export interface ManagedBudgetStatus {
  usedMicros: number;
  limitMicros: number;
  remainingMicros: number;
  /** May a call START? The §6 rule: `remaining > 0`, never "will it fit". */
  allowed: boolean;
  period: string;
}

/**
 * The §7a signals this layer can see.
 *
 * `testSubscription` is deliberately absent: it is not mirrored to any column
 * yet, and in production a `test: true` subscription is only ever SEEN by a
 * shop that is already `partnerDevelopment` or on a forced dev plan — which is
 * the plan's own reading of why signal 2 earns its place (for
 * `DEV_PLAN_OVERRIDE_SHOPS` and for a shop whose dev lookup once failed).
 * Phase 2 reads the subscription here anyway and can mirror it then; until
 * `managedAiActive` can be true at all, nothing reaches this function.
 */
export function budgetContextFor(shop: string, settings: AISettings | null): BudgetContext {
  return {
    partnerDevelopment: settings?.partnerDevelopment ?? null,
    devPlanMode: resolveDevPlanMode(shop) !== null,
    // Every paid tier carries `trialDays: 7` and Shopify reports a trialing
    // subscription as ACTIVE, so without this a week of full allowance is
    // granted against revenue that has not arrived and may never.
    inTrial: settings?.trialConsumedAt != null && isWithinTrialWindow(settings),
  };
}

/**
 * Is the shop inside its 7-day trial?
 *
 * Derived from `trialConsumedAt`, the marker written at the Shopify-VERIFIED
 * point when a subscription was granted a trial. It is a coarse answer — the
 * exact trial end lives on the subscription — and it errs towards "in trial",
 * i.e. towards NO budget, which is the direction that cannot cost money.
 * Phase 2 reads the subscription here and replaces it with the exact date.
 */
function isWithinTrialWindow(settings: AISettings): boolean {
  const consumed = settings.trialConsumedAt;
  if (!consumed) return false;
  const TRIAL_DAYS = 7;
  const ageMs = Date.now() - new Date(consumed).getTime();
  return ageMs < TRIAL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Read the shop's managed spend for the current period and compare it with its
 * limit. Never throws: a DB failure answers "no budget", because the expensive
 * direction here is the one that spends the operator's money on evidence we
 * could not read.
 */
export async function managedBudgetStatus(
  shop: string,
  settings: AISettings | null,
  plan: BillingPlan,
): Promise<ManagedBudgetStatus> {
  const period = currentAiUsagePeriod();
  const limitMicros = managedBudgetMicros(plan, budgetContextFor(shop, settings));

  // No limit means nothing to measure against — and a zero budget is a real
  // answer (§7a), not a missing one.
  if (limitMicros <= 0) {
    return { usedMicros: 0, limitMicros: 0, remainingMicros: 0, allowed: false, period };
  }

  try {
    const { db } = await import("../../db.server");
    const agg = await db.aiUsageCounter.aggregate({
      where: { shop, period, source: "managed" },
      _sum: { billedMicros: true },
    });
    // BigInt from the ledger; Number at this boundary, like every other read of
    // those columns (2.1e9 is four orders of magnitude inside MAX_SAFE_INTEGER).
    const usedMicros = Number(agg._sum.billedMicros ?? 0);
    const remainingMicros = Math.max(0, limitMicros - usedMicros);
    return { usedMicros, limitMicros, remainingMicros, allowed: remainingMicros > 0, period };
  } catch (error) {
    logger.error(
      `[ManagedAI] Budget read failed for ${shop}: ${
        error instanceof Error ? error.message : String(error)
      } — refusing rather than spending on unread evidence`,
    );
    return { usedMicros: 0, limitMicros, remainingMicros: 0, allowed: false, period };
  }
}

/** The share used, 0-1, for the "80 % warning before a wall" (§6). */
export function budgetUsedFraction(status: ManagedBudgetStatus): number {
  if (status.limitMicros <= 0) return 1;
  return Math.min(1, status.usedMicros / status.limitMicros);
}

export const BUDGET_WARNING_THRESHOLD = 0.8;
