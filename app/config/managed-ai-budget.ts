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
import type { AIProvider } from "../utils/api-key-validation";
import { priceCall } from "./ai-pricing";

/** Micro-euro, the unit the meter stores and the only unit enforced. */
export const MANAGED_BUDGET_MICROS: Record<BillingPlan, number> = {
  // A shop that pays nothing gets no PERIOD budget at all (§7a). What it does
  // get is the one-time TASTER below — a separate grant, under its own period
  // key, sized by the ladder rule rather than by this table.
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

// ─── The one-time taster (§10) ───────────────────────────────────────────────

/**
 * The taster is the acquisition fix: a managed grant an evaluating shop gets
 * BEFORE it buys anything, because every gate above it asks a merchant to pay
 * for a feature they have not seen.
 *
 * Two units, and which is which is the whole design. The grant is EXPRESSED in
 * AI actions, because that is the only unit a merchant can reason about, and
 * ENFORCED in micro-euro, because §7's one-unit rule says a budget is money or
 * it is nothing. The euro figure is DERIVED from the pinned model's price, so
 * a change of managed default model moves the COST and not the promise.
 *
 * Why not the "EUR 2 per month on Free" that was proposed: it out-grants paid
 * Basic (EUR 2 of provider cost is ~6,000 nano-class calls against Basic's
 * ~4,500), and it is ~18x what the Free plan's 50 products and 5 collections
 * can even consume — while scaling with INSTALLS rather than with customers,
 * which is the one cost line in this app a good App Store listing makes worse.
 */
export const MANAGED_AI_TASTER_ACTIONS = 350;

/**
 * The call the action figure is priced at — PROVISIONAL until the Phase 0
 * meter has a measured average (`npm run ai:usage`), and named as one constant
 * so replacing it re-derives everything below.
 *
 * It is sized from §10's own arithmetic: one full pass over everything the
 * Free plan entitles (50 products + 5 collections, a description each, into
 * five locales) is ~325 calls and ~EUR 0.11 at the default model, i.e. ~340
 * micro-euro a call. The app BATCHES fields and locales, so the same work may
 * be 30 calls of ten times the size — which moves the call count and not the
 * euro total, and the euro total is what is enforced.
 */
export const TASTER_REFERENCE_CALL = {
  inputTokens: 1_800,
  outputTokens: 700,
} as const;

/**
 * The hard ladder rule: the taster may never exceed a QUARTER of the smallest
 * PAID managed budget. It is what makes "let us make Free a bit more generous"
 * fail the build instead of quietly inverting the ladder — a free shop with
 * more AI than a merchant paying EUR 21.90 leaves no reason to ever leave Free
 * but the product limits.
 */
export const TASTER_LADDER_SHARE = 0.25;

/**
 * The ledger period key of the taster — PREFIXLESS on purpose.
 *
 * The other two schemes are `m:<month>` and `b:<period end>`, so this can
 * never be read as either, and it never rolls over: the grant is once per shop
 * EVER, and "ever" is expressed by a key that has no next value. That is also
 * what makes the ledger itself the enforcement — a shop that spent its taster
 * on Free gets nothing extra during the paid trial it later starts (§7 rule 1)
 * and nothing extra as a dev store (§7a), because the row is still there.
 */
export const TASTER_PERIOD = "taster";

const PAID_PLANS = Object.keys(MANAGED_SURCHARGE_CENTS) as Exclude<BillingPlan, "free">[];

/** The smallest budget any PAID managed plan grants — the ladder's bottom rung. */
export function smallestPaidBudgetMicros(): number {
  return Math.min(...PAID_PLANS.map((plan) => MANAGED_BUDGET_MICROS[plan]));
}

/** The ladder ceiling the taster is capped at, whatever the model costs. */
export function tasterCeilingMicros(): number {
  return Math.floor(smallestPaidBudgetMicros() * TASTER_LADDER_SHARE);
}

/**
 * What ONE taster action costs at a given model, in micro-euro. Zero means the
 * model cannot be priced, which is not "free" but "we could not enforce this"
 * — every caller below turns it into a refusal rather than into a grant.
 */
export function tasterCallMicros(provider: AIProvider, model: string): number {
  const priced = priceCall(
    provider,
    model,
    TASTER_REFERENCE_CALL.inputTokens,
    TASTER_REFERENCE_CALL.outputTokens,
  );
  return priced.unpriced ? 0 : priced.costMicros;
}

/**
 * The taster budget for a deployment running `model` as its managed default.
 *
 * The SMALLER of the action count and the ladder ceiling, which is the rule
 * that decides what a costlier future default model does: it shrinks the
 * ACTIONS (see `tasterActionsFor`) rather than bending the ladder.
 */
export function tasterBudgetMicros(provider: AIProvider, model: string): number {
  const perCall = tasterCallMicros(provider, model);
  if (perCall <= 0) return 0;
  return Math.min(perCall * MANAGED_AI_TASTER_ACTIONS, tasterCeilingMicros());
}

/**
 * How many actions the taster really buys at this model — the number the
 * Settings card shows, and the visible half of the rule above: at the default
 * model it is exactly `MANAGED_AI_TASTER_ACTIONS`, and at a dearer one it is
 * however many the ceiling pays for.
 */
export function tasterActionsFor(provider: AIProvider, model: string): number {
  const perCall = tasterCallMicros(provider, model);
  if (perCall <= 0) return 0;
  return Math.min(MANAGED_AI_TASTER_ACTIONS, Math.floor(tasterCeilingMicros() / perCall));
}
