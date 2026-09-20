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
  TASTER_PERIOD,
  type BudgetContext,
} from "../../config/managed-ai-budget";
import { resolveDevPlanMode } from "../dev-plan-override.server";
import { boughtManagedAi } from "./managed-ai.shared";
import { managedBudgetPeriod } from "./usage-meter.server";
import { logger } from "../../utils/logger.server";

export interface ManagedBudgetStatus {
  usedMicros: number;
  limitMicros: number;
  remainingMicros: number;
  /** May a call START? The §6 rule: `remaining > 0`, never "will it fit". */
  allowed: boolean;
  period: string;
  /**
   * WHICH budget this is. A period budget resets; the taster (§10) does not,
   * and the two are refused with different sentences because "used up for this
   * period" is a lie to a shop whose grant was once per shop ever.
   */
  kind: "period" | "taster";
  /**
   * The refusal is OURS to fix, not a volume the merchant ran out of — a
   * plan column that contradicts the verified entitlement. It answers
   * `managedUnavailable`, because telling a paying merchant their volume is
   * used up would send them to buy more of something we are not serving.
   */
  unavailable?: boolean;
}

/**
 * The §7a signals this layer can see.
 *
 * All three of §7a's signals, and the third is the one that matters: a shop
 * on a forced dev plan has no subscription object at all and, on a real
 * store, reports `partnerDevelopment: false`.
 *
 * `testSubscription` reads a MIRRORED column rather than the live
 * subscription, because this runs per AI request on detached paths that hold
 * no admin client. Three-valued at the source: `null` (no sync has
 * established it) counts as NOT a test subscription, since refusing a paying
 * merchant's budget on missing evidence is the expensive direction and the
 * global pool bounds what this cannot see.
 */
export function budgetContextFor(shop: string, settings: AISettings | null): BudgetContext {
  return {
    partnerDevelopment: settings?.partnerDevelopment ?? null,
    // §7a signal 2, mirrored by `syncSubscriptionToDatabase`. It was
    // documented here as "deliberately absent, Phase 2 can mirror it" and
    // Phase 2 did not: a `test: true` subscription carries the managed
    // variant's own name and price, so it resolves to managed and grants a
    // full period budget against zero revenue wherever signals 1 and 3 miss.
    testSubscription: settings?.subscriptionIsTest === true,
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
 * Derived from `trialConsumedAt` — a one-way null→now transition written at
 * the first Shopify-VERIFIED sync of the first trial subscription, so it is
 * genuinely the trial START and not a per-sync stamp.
 *
 * It is coarse, and the case it gets WRONG is named rather than waved at: a
 * shop that cancels on trial day 2 and re-subscribes on day 3 is no longer
 * trial-eligible and is charged immediately, yet this refuses its whole budget
 * until day 8. Same for an upgrade to a managed plan inside the original
 * seven days. That is a paying merchant meeting a 402 — narrow, but a support
 * ticket on a money path, and the reason Phase 2 replaces this with the exact
 * trial end from the subscription rather than keeping it as "good enough".
 *
 * It is kept meanwhile because the error it makes cannot cost money, and the
 * opposite error — a full allowance for a week of revenue that may never
 * arrive — can.
 */
function isWithinTrialWindow(settings: AISettings): boolean {
  const consumed = settings.trialConsumedAt;
  if (!consumed) return false;
  const TRIAL_DAYS = 7;
  const ageMs = Date.now() - new Date(consumed).getTime();
  return ageMs < TRIAL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The PERIOD budget this shop is entitled to, in micro-euro — zero when it has
 * none.
 *
 * `managedAiActive` is asked HERE and nowhere upstream any more, and that move
 * is what §10 costs. Before the taster, the verified subscription gated the
 * MODE: a merchant who posted `aiKeySource=managed` without buying resolved to
 * no managed credential at all. The taster has to reach exactly that shop, so
 * the mode is now the merchant's stored choice alone — and the verified half
 * moved down here, to the only thing it ever really protected. A shop that did
 * not buy the AI-included variant gets the taster and nothing more, whatever
 * its plan column says and whatever it posts.
 */
export function periodBudgetMicros(
  shop: string,
  settings: AISettings | null,
  plan: BillingPlan,
): number {
  if (settings?.managedAiActive !== true) return 0;
  return managedBudgetMicros(plan, budgetContextFor(shop, settings));
}

/**
 * The ledger key a managed call is counted under — the BILLING period for a
 * shop with a period budget, the taster key for everyone else.
 *
 * ONE function, called by the meter's side (`configFor`) and by the budget's
 * side below, because the two must agree: written under `b:2026-10-14` and
 * read back under `taster`, the used figure is always zero and the cap never
 * fires. That failure mode is not hypothetical — it is the one the
 * `usagePeriod` field was added to prevent.
 */
export function managedPeriodKey(
  shop: string,
  settings: AISettings | null,
  plan: BillingPlan,
): string {
  return periodBudgetMicros(shop, settings, plan) > 0
    ? managedBudgetPeriod(settings?.managedAiPeriodEnd ?? null)
    : TASTER_PERIOD;
}

/**
 * Which GLOBAL pool (§9.3) a managed call draws from — derived from the SAME
 * question as the period key, so a shop can never spend from the taster budget
 * against the paying merchants' cap. Free shops, dev stores, trialing shops
 * and anyone who has not bought the variant are the least accountable
 * population on the shared key; their spend must not be able to trip the ring
 * every paying merchant runs against.
 */
export function managedPoolFor(
  shop: string,
  settings: AISettings | null,
  plan: BillingPlan,
): "paid" | "taster" {
  // Asked of the PURCHASE, not of the period budget — and the difference is
  // one real case. A shop inside its 7-day trial of an AI-included plan has
  // no period budget (§7 rule 1: Shopify reports a trialing subscription as
  // ACTIVE and the revenue has not arrived) and therefore spends the taster,
  // but it is a paying customer in waiting and must not be able to exhaust
  // the ring that exists to keep free installs off the paid one.
  void shop;
  void plan;
  return boughtManagedAi(settings) ? "paid" : "taster";
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
  // The BILLING period, not the calendar month (§7 rule 3) — the calendar key
  // hands a sign-up on the 31st two full budgets inside one billing period.
  const periodLimit = periodBudgetMicros(shop, settings, plan);

  // A shop cannot have BOUGHT the AI-included variant of the free plan — no
  // such product exists — so this pair is a stale or half-written plan
  // column, not a state to hand a grant to. It stays a PERIOD budget of zero
  // rather than falling to the taster: the taster is a one-time grant, and
  // spending it on our own bookkeeping error is the one way to lose it that
  // the merchant can neither see nor undo. (The billing sync no longer writes
  // `free` over a verified managed plan, which is where this came from; this
  // is the second rail.)
  if (boughtManagedAi(settings) && plan === "free") {
    logger.error(
      `[ManagedAI] ${shop} holds a verified managed entitlement on the free plan — refusing rather than spending the taster on a contradictory plan column.`,
    );
    return {
      usedMicros: 0,
      limitMicros: 0,
      remainingMicros: 0,
      allowed: false,
      period: managedBudgetPeriod(settings?.managedAiPeriodEnd ?? null),
      kind: "period",
      unavailable: true,
    };
  }

  const kind: "period" | "taster" = periodLimit > 0 ? "period" : "taster";
  const period =
    kind === "period" ? managedBudgetPeriod(settings?.managedAiPeriodEnd ?? null) : TASTER_PERIOD;

  // The taster's size is a question about the CREDENTIAL — it is derived from
  // the price of the model this deployment actually runs — so it is read
  // through the one module allowed to know what that credential is. The import
  // is dynamic because that module imports this one: a static edge in both
  // directions is a cycle, and the dynamic one resolves after both are
  // evaluated.
  let limitMicros = periodLimit;
  if (kind === "taster") {
    try {
      // FROZEN once the grant has started. The limit is derived from the price
      // of the managed default model and the used figure never resets, so
      // re-deriving it on every read made "once, ever" false in both
      // directions: a move to a dearer model silently handed a second taster
      // to every shop that had spent its first, and a move to a cheaper one
      // retroactively exhausted shops mid-grant.
      const frozen = settings?.managedAiTasterMicros ?? null;
      if (frozen !== null && frozen > 0) {
        limitMicros = frozen;
      } else {
        const { managedTasterLimitMicros } = await import("./ai-credentials.server");
        limitMicros = managedTasterLimitMicros();
      }
    } catch (error) {
      logger.error(
        `[ManagedAI] Taster limit unreadable for ${shop}: ${
          error instanceof Error ? error.message : String(error)
        } — refusing rather than spending on unread evidence`,
      );
      limitMicros = 0;
    }
  }

  // No limit means nothing to measure against — and a zero budget is a real
  // answer (§7a, and a deployment whose managed model cannot be priced), not a
  // missing one.
  if (limitMicros <= 0) {
    return { usedMicros: 0, limitMicros: 0, remainingMicros: 0, allowed: false, period, kind };
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
    return {
      usedMicros,
      limitMicros,
      remainingMicros,
      allowed: remainingMicros > 0,
      period,
      kind,
    };
  } catch (error) {
    logger.error(
      `[ManagedAI] Budget read failed for ${shop}: ${
        error instanceof Error ? error.message : String(error)
      } — refusing rather than spending on unread evidence`,
    );
    return { usedMicros: 0, limitMicros, remainingMicros: 0, allowed: false, period, kind };
  }
}

/** The share used, 0-1, for the "80 % warning before a wall" (§6). */
export function budgetUsedFraction(status: ManagedBudgetStatus): number {
  if (status.limitMicros <= 0) return 1;
  return Math.min(1, status.usedMicros / status.limitMicros);
}

export const BUDGET_WARNING_THRESHOLD = 0.8;
