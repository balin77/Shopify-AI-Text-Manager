/**
 * The margin guard — PLAN_MANAGED_AI_KEY §7.
 *
 * This is the mechanical form of the one requirement the whole managed-AI plan
 * exists to satisfy: **the merchant must pay more than we pay.** Raising a
 * budget or cutting a surcharge without touching the other fails the build
 * here rather than showing up on an invoice.
 *
 * It is a test over CONSTANTS and it can never see runtime cost — which is
 * exactly why §3a's failover carries its 14x exposure explicitly, in its own
 * per-shop ceiling and global pool, instead of leaving it to these buffers.
 */

import { describe, it, expect } from 'vitest';
import {
  MANAGED_BUDGET_MICROS,
  MANAGED_SURCHARGE_CENTS,
  MAX_COST_SHARE,
  TOTAL_BUDGET_BUFFER,
  BUDGET_BUFFERS,
  REVENUE_SHARE,
  surchargeNetMicros,
  managedBudgetMicros,
  paysNothing,
} from '~/config/managed-ai-budget';
import { BILLING_PLANS, type BillingPlan } from '~/config/billing';

const PAID: Exclude<BillingPlan, 'free'>[] = ['basic', 'pro', 'max'];

describe('the budget a plan grants is below what its surcharge can carry', () => {
  it.each(PAID)('%s: budget x buffer <= net surcharge x max cost share', (plan) => {
    const exposed = MANAGED_BUDGET_MICROS[plan] * TOTAL_BUDGET_BUFFER;
    const allowed = surchargeNetMicros(plan) * MAX_COST_SHARE;

    expect(
      exposed,
      `${plan}: EUR ${(exposed / 1e6).toFixed(2)} of exposure against EUR ${(allowed / 1e6).toFixed(2)} allowed`,
    ).toBeLessThanOrEqual(allowed);
  });

  it('the first draft of these numbers FAILS the guard — the reason it is a test', () => {
    // 1.50 / 3.00 / 6.00 against surcharges of 10 / 20 / 40 reads as a 17.6 %
    // cost share, which "feels below 20 %" and is not: the buffer multiplies
    // the budget. Pinned so the argument survives the numbers changing.
    const draftBudget = 6_000_000;
    const draftSurchargeNet = 4_000 * 10_000 * (1 - REVENUE_SHARE);
    expect(draftBudget * TOTAL_BUDGET_BUFFER).toBeGreaterThan(draftSurchargeNet * MAX_COST_SHARE);
  });
});

describe('the buffers are three risks, not one number', () => {
  it('each is stated separately and the guard multiplies them', () => {
    const product =
      BUDGET_BUFFERS.fx * BUDGET_BUFFERS.listPrice * BUDGET_BUFFERS.overshoot;
    expect(TOTAL_BUDGET_BUFFER).toBeCloseTo(product, 10);
    for (const [name, value] of Object.entries(BUDGET_BUFFERS)) {
      expect(value, `${name} must be a real buffer, not a no-op`).toBeGreaterThan(1);
    }
  });
});

describe('no two products may share a price', () => {
  it('a renamed managed subscription cannot resolve to another plan', () => {
    // getPlanFromSubscription matches the subscription NAME first and falls
    // back to the first entry with a matching PRICE — and that fallback exists
    // precisely for renamed subscriptions. "Basic + AI = 19.90" is exactly the
    // collision: 19.90 is Pro's price today, so a renamed Basic+AI would
    // resolve to Pro, with managed mode silently off and entitlements silently
    // up. Hence 21.90.
    const prices = new Set<number>();
    for (const plan of PAID) {
      const base = BILLING_PLANS[plan].price;
      const managed = base + MANAGED_SURCHARGE_CENTS[plan] / 100;
      for (const price of [base, managed]) {
        expect(prices.has(price), `price ${price} is used by more than one product`).toBe(false);
        prices.add(price);
      }
    }
  });

  it('and not with the v2.0 price table in PRICING_AND_LIMITS.md either', () => {
    const planned = [14.9, 29.9, 79.9];
    const inUse = PAID.flatMap((plan) => [
      BILLING_PLANS[plan].price,
      BILLING_PLANS[plan].price + MANAGED_SURCHARGE_CENTS[plan] / 100,
    ]);
    for (const price of planned) {
      expect(inUse, `the v2.0 price ${price} collides with a live one`).not.toContain(price);
    }
  });
});

describe('who gets no period budget at all (§7a)', () => {
  it('a partner development store', () => {
    expect(paysNothing({ partnerDevelopment: true })).toBe(true);
    expect(managedBudgetMicros('max', { partnerDevelopment: true })).toBe(0);
  });

  it('a subscription that charges nothing', () => {
    expect(managedBudgetMicros('max', { testSubscription: true })).toBe(0);
  });

  it('a shop on a forced dev plan — the signal the other two are blind to', () => {
    // checkAndSyncSubscription returns early on getDevForcedPlan, so such a
    // shop has no subscription object and, on a real store, reports
    // partnerDevelopment: false.
    expect(managedBudgetMicros('max', { devPlanMode: true, partnerDevelopment: false })).toBe(0);
  });

  it('a shop inside its 7-day trial, which Shopify reports as ACTIVE', () => {
    expect(managedBudgetMicros('pro', { inTrial: true })).toBe(0);
  });

  it('the free plan', () => {
    expect(managedBudgetMicros('free')).toBe(0);
  });

  it('but an UNKNOWN dev-store answer does not cost a paying merchant their budget', () => {
    // The column is written whenever the lookup succeeds, so null means no
    // sync with an admin client has run yet. Refusing on missing evidence is
    // the expensive direction; the global pool bounds what this cannot see.
    expect(paysNothing({ partnerDevelopment: null })).toBe(false);
    expect(managedBudgetMicros('pro', { partnerDevelopment: null })).toBe(
      MANAGED_BUDGET_MICROS.pro,
    );
  });

  it('a normal paying shop gets its plan budget', () => {
    expect(managedBudgetMicros('basic', { partnerDevelopment: false })).toBe(
      MANAGED_BUDGET_MICROS.basic,
    );
  });
});
