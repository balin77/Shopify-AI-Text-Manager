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
import { BILLING_PLANS, MANAGED_BILLING_PLANS, type BillingPlan } from '~/config/billing';
import { resolveSubscription } from '~/services/billing.server';
import { managedBudgetPeriod } from '~/services/ai/usage-meter.server';

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

describe('a subscription resolves to a plan AND a mode', () => {
  it('matches the managed variant by NAME', () => {
    for (const plan of PAID) {
      const resolved = resolveSubscription({
        name: MANAGED_BILLING_PLANS[plan].name,
        lineItems: [],
      } as never);
      expect(resolved).toEqual({ plan, aiMode: 'managed' });
    }
  });

  it('matches the BYO variant by name, and does not read it as managed', () => {
    for (const plan of PAID) {
      expect(
        resolveSubscription({ name: BILLING_PLANS[plan].name, lineItems: [] } as never),
      ).toEqual({ plan, aiMode: 'byo' });
    }
  });

  it('falls back to the PRICE, and the price still identifies the mode', () => {
    // This fallback exists for renamed subscriptions, which is why no two
    // products may share a price — see the collision test above.
    for (const plan of PAID) {
      const managedPrice = BILLING_PLANS[plan].price + MANAGED_SURCHARGE_CENTS[plan] / 100;
      const resolved = resolveSubscription({
        name: 'Something the merchant renamed',
        lineItems: [
          { plan: { pricingDetails: { __typename: 'AppRecurringPricing', price: { amount: String(managedPrice), currencyCode: 'EUR' } } } },
        ],
      } as never);
      expect(resolved).toEqual({ plan, aiMode: 'managed' });
    }
  });

  it('never GUESSES — an unknown subscription is free and BYO', () => {
    expect(
      resolveSubscription({ name: 'Mystery Plan', lineItems: [] } as never),
    ).toEqual({ plan: 'free', aiMode: 'byo' });
    expect(resolveSubscription(null)).toEqual({ plan: 'free', aiMode: 'byo' });
  });

  it('the managed name of one plan is never the name of another', () => {
    const names = new Set<string>();
    for (const plan of PAID) {
      for (const cfg of [BILLING_PLANS[plan], MANAGED_BILLING_PLANS[plan]]) {
        expect(names.has(cfg.name.toLowerCase())).toBe(false);
        names.add(cfg.name.toLowerCase());
      }
    }
  });
});

describe('the budget period is the BILLING period (§7 rule 3)', () => {
  it('keys on the period END, so a mid-period upgrade mints no second budget', () => {
    const end = new Date('2026-10-14T00:00:00Z');
    const early = managedBudgetPeriod(end, new Date('2026-09-20T00:00:00Z'));
    const late = managedBudgetPeriod(end, new Date('2026-10-13T23:00:00Z'));
    expect(early).toBe('b:2026-10-14');
    expect(late).toBe(early);
  });

  it('a sign-up on the 31st does NOT get two budgets', () => {
    // The whole reason for the rule: under a calendar key, 31 Aug and 1 Sep
    // are two budgets inside one billing period.
    const end = new Date('2026-09-30T00:00:00Z');
    expect(managedBudgetPeriod(end, new Date('2026-08-31T12:00:00Z'))).toBe(
      managedBudgetPeriod(end, new Date('2026-09-01T12:00:00Z')),
    );
  });

  it('walks a STALE mirror forward rather than keying on an expired period', () => {
    // A late webhook can leave the period end in the past. Keying on it would
    // let the shop keep spending against a budget that has already reset.
    const stale = new Date('2026-01-10T00:00:00Z');
    const key = managedBudgetPeriod(stale, new Date('2026-03-01T00:00:00Z'));
    expect(key).toBe('b:2026-03-11');
  });

  it('falls back to the calendar month when the period is unknown', () => {
    expect(managedBudgetPeriod(null, new Date('2026-09-20T00:00:00Z'))).toBe('m:2026-09');
    expect(managedBudgetPeriod(new Date('nonsense'), new Date('2026-09-20T00:00:00Z'))).toBe('m:2026-09');
  });

  it('the two schemes can never be read as one another', () => {
    expect(managedBudgetPeriod(new Date('2026-10-14'))).toMatch(/^b:/);
    expect(managedBudgetPeriod(null)).toMatch(/^m:/);
  });
});
