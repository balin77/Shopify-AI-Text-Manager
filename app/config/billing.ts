/**
 * Shopify App Billing Configuration
 *
 * Defines the subscription plans and pricing for the Shopify app.
 */

export type BillingPlan = 'free' | 'basic' | 'pro' | 'max';

export interface PlanConfig {
  name: string;
  price: number;
  currency: string;
  interval: 'EVERY_30_DAYS' | 'ANNUAL';
  trialDays?: number;
  test?: boolean;
}

export const BILLING_PLANS: Record<Exclude<BillingPlan, 'free'>, PlanConfig> = {
  basic: {
    name: 'Basic Plan',
    price: 9.90,
    currency: 'EUR',
    interval: 'EVERY_30_DAYS',
    trialDays: 7,
  },
  pro: {
    name: 'Pro Plan',
    price: 19.90,
    currency: 'EUR',
    interval: 'EVERY_30_DAYS',
    trialDays: 7,
  },
  max: {
    name: 'Max Plan',
    price: 59.90,
    currency: 'EUR',
    interval: 'EVERY_30_DAYS',
    trialDays: 7,
  },
};

/**
 * The MANAGED variant of each paid plan — PLAN_MANAGED_AI_KEY §7.
 *
 * The key source is a SECOND AXIS, not four more plans: `BillingPlan` stays
 * 4-valued and every `Record<Plan, …>` in the app keeps working. This is the
 * map `getPlanFromSubscription` consults beside the one above, and what it
 * returns alongside the plan is the MODE.
 *
 * **No price here may collide with any other product's price, current or
 * planned.** `getPlanFromSubscription` matches the subscription NAME first and
 * falls back to the first entry with a matching PRICE — and that fallback
 * exists precisely for renamed subscriptions, so it is not hypothetical. The
 * obvious "Basic + AI = 19.90" is exactly the collision: 19.90 is Pro's price,
 * so a renamed Basic+AI subscription would resolve to Pro, with managed mode
 * silently off and entitlements silently up. Hence 21.90.
 * `tests/unit/managed-ai-margin.test.ts` fails the build on a collision, and
 * checks the v2.0 table in PRICING_AND_LIMITS.md too.
 *
 * The NAME carries the mode as well, because the name match is tried first and
 * has to be unambiguous on its own.
 */
export const MANAGED_BILLING_PLANS: Record<Exclude<BillingPlan, 'free'>, PlanConfig> = {
  basic: {
    name: 'Basic Plan + AI',
    price: 21.90,
    currency: 'EUR',
    interval: 'EVERY_30_DAYS',
    trialDays: 7,
  },
  pro: {
    name: 'Pro Plan + AI',
    price: 39.90,
    currency: 'EUR',
    interval: 'EVERY_30_DAYS',
    trialDays: 7,
  },
  max: {
    name: 'Max Plan + AI',
    price: 99.90,
    currency: 'EUR',
    interval: 'EVERY_30_DAYS',
    trialDays: 7,
  },
};

/** Whose AI key a subscription entitles the shop to spend. */
export type BillingAiMode = 'byo' | 'managed';

/** Both halves of what a subscription grants. */
export interface ResolvedBillingPlan {
  plan: BillingPlan;
  aiMode: BillingAiMode;
}

/** The config for a (plan, mode) pair. */
export function planConfigFor(
  plan: Exclude<BillingPlan, 'free'>,
  aiMode: BillingAiMode,
): PlanConfig {
  return aiMode === 'managed' ? MANAGED_BILLING_PLANS[plan] : BILLING_PLANS[plan];
}

/**
 * Get plan configuration by plan name
 */
export function getPlanConfig(plan: Exclude<BillingPlan, 'free'>): PlanConfig {
  return BILLING_PLANS[plan];
}

/**
 * Check if a plan requires payment (not free)
 */
export function isPaidPlan(plan: BillingPlan): plan is Exclude<BillingPlan, 'free'> {
  return plan !== 'free';
}

/**
 * Get all available paid plans
 */
export function getAvailablePlans(): Array<{ id: BillingPlan; config: PlanConfig | null }> {
  return [
    { id: 'free', config: null },
    { id: 'basic', config: BILLING_PLANS.basic },
    { id: 'pro', config: BILLING_PLANS.pro },
    { id: 'max', config: BILLING_PLANS.max },
  ];
}
