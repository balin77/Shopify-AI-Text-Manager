/**
 * How much PROVIDER COST a managed shop may spend in one period —
 * PLAN_MANAGED_AI_KEY §7 and §7a.
 *
 * Client-safe: the Settings usage card renders the same limit the server
 * enforces, and two numbers for one budget is how a merchant comes to see
 * "84 % used" over a cap that is not the one refusing them.
 *
 * **This column is provider COST, not merchant price.** It is what we are
 * willing to spend on a shop's behalf, and the margin guard
 * (`tests/unit/managed-ai-margin.test.ts`) is what keeps it below what the
 * surcharge can carry. Raising a budget or cutting a price without touching
 * the other fails that test, which is the mechanical form of the one
 * requirement this whole plan exists to satisfy: *the merchant must pay more
 * than we pay*.
 *
 * Every number here is PROVISIONAL until the Phase 0 meter has measured a real
 * average call (`npm run ai:usage`). The table is built so replacing one
 * measured constant updates it.
 */

import type { BillingPlan } from "./billing";

/** Micro-euro, the unit the meter stores and the only unit enforced. */
export const MANAGED_BUDGET_MICROS: Record<BillingPlan, number> = {
  // A shop that pays nothing gets no PERIOD budget at all (§7a). The one-time
  // taster (§10) is a separate grant with its own counter and is not built
  // yet — until it is, zero is the honest answer rather than a placeholder
  // allowance nobody sized.
  free: 0,
  basic: 1_500_000, // EUR 1.50
  pro: 2_500_000, // EUR 2.50
  max: 5_000_000, // EUR 5.00
};

/**
 * The SURCHARGE each managed variant adds to its plan's price, in cents.
 * Phase 2 turns these into real Shopify subscription variants; they live here
 * now because the margin guard needs both sides of the inequality in one
 * place, and a guard that can only see one side is not a guard.
 */
export const MANAGED_SURCHARGE_CENTS: Record<Exclude<BillingPlan, "free">, number> = {
  basic: 1_200, // 9.90 -> 21.90
  pro: 2_000, // 19.90 -> 39.90
  max: 4_000, // 59.90 -> 99.90
};

/**
 * Shopify's revenue share, taken at its WORST case. It is 0 % below $1M/year
 * today, so this is deliberate pessimism rather than a current fact.
 */
export const REVENUE_SHARE = 0.15;

/**
 * The largest share of the net surcharge the provider cost may take.
 *
 * With the buffers below the effective ceiling is 0.20 / 1.25 = 16 %, which is
 * what the budgets above were derived FROM — they are not round numbers chosen
 * first. The plan's first draft put 1.50 / 3.00 / 6.00 against surcharges of
 * 10 / 20 / 40, read as a 17.6 % cost share and failed its own test; that is
 * the reason this is a test and not a habit.
 */
export const MAX_COST_SHARE = 0.2;

/**
 * Three separate risks, sized separately, multiplied by the guard — because a
 * single blended "1.25" is a rule with its failure mode hidden inside it.
 */
export const BUDGET_BUFFERS = {
  /** The provider bills USD and we are paid EUR (app/config/ai-pricing.ts). */
  fx: 1.1,
  /** A provider raises list prices mid-period; we cannot re-price until the next cycle. */
  listPrice: 1.08,
  /**
   * §6's overshoot bound: a call may START while remaining > 0, and its cost
   * is not knowable up front. Bounded by AI_QUEUE_CONCURRENCY x the worst-case
   * single call x the number of web instances — ONE in production, which is
   * what makes this a real number rather than a hope (RAILWAY-SETUP.md §0).
   */
  overshoot: 1.05,
} as const;

export const TOTAL_BUDGET_BUFFER =
  BUDGET_BUFFERS.fx * BUDGET_BUFFERS.listPrice * BUDGET_BUFFERS.overshoot;

/** Net surcharge in micro-euro after Shopify's share. */
export function surchargeNetMicros(plan: Exclude<BillingPlan, "free">): number {
  return Math.round(MANAGED_SURCHARGE_CENTS[plan] * 10_000 * (1 - REVENUE_SHARE));
}

export interface BudgetContext {
  /** A Shopify partner development store — three-valued, `null` = unknown. */
  partnerDevelopment?: boolean | null;
  /** The subscription carries `test: true`, i.e. it charges nothing. */
  testSubscription?: boolean;
  /** `resolveDevPlanMode(shop) !== null` — the signal the other two are blind to. */
  devPlanMode?: boolean;
  /** Shopify reports a trialing subscription as ACTIVE (§7 rule 1). */
  inTrial?: boolean;
}

/**
 * Does this shop pay nothing, whatever its plan says?
 *
 * THREE signals, and the third is the one that matters: `checkAndSyncSubscription`
 * consults `getDevForcedPlan` FIRST and returns early, so a `devForcedPlan`
 * shop has no subscription object at all and, on a real store, reports
 * `partnerDevelopment: false` — signals 1 and 2 are both blind to it.
 *
 * An UNKNOWN `partnerDevelopment` does NOT count as a dev store: the column is
 * written whenever the lookup succeeds, so "never determined" means no sync
 * with an admin client has run yet, and refusing a paying merchant's budget on
 * missing evidence is the expensive direction. The global pool (§9.3) is what
 * bounds what this cannot see.
 */
export function paysNothing(ctx: BudgetContext): boolean {
  return ctx.partnerDevelopment === true || ctx.testSubscription === true || ctx.devPlanMode === true;
}

/**
 * The period budget for one shop, in micro-euro.
 *
 * Zero is a real answer and means "no managed spend": a free plan, a shop that
 * pays nothing, and a shop inside its 7-day trial all get it. The trial case
 * is not stinginess — every paid tier carries `trialDays: 7` and Shopify
 * reports a trialing subscription as ACTIVE, so a period budget there is a
 * full allowance against revenue that has not arrived and may never.
 */
export function managedBudgetMicros(plan: BillingPlan, ctx: BudgetContext = {}): number {
  if (paysNothing(ctx)) return MANAGED_BUDGET_MICROS.free;
  if (ctx.inTrial) return MANAGED_BUDGET_MICROS.free;
  return MANAGED_BUDGET_MICROS[plan] ?? 0;
}
