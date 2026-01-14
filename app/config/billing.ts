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
    price: 49.90,
    currency: 'EUR',
    interval: 'EVERY_30_DAYS',
    trialDays: 7,
  },
};

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
