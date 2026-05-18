/**
 * Unit Tests for app/utils/planUtils.ts — sync scope helpers
 *
 * Covers the review fixes that made the sync plan-aware:
 *  - getSyncScope(plan): per-phase enabled flags + numeric caps, derived purely
 *    from config/plans.ts (single source of truth for "what may a plan sync").
 *  - planGrantsMore(prev, next): the auto-resync trigger predicate (newly
 *    entitled phase OR higher cap on a still-enabled phase).
 *
 * Pure functions — no mocks, no DB, no Shopify.
 */

import { describe, it, expect } from 'vitest';
import { getSyncScope, planGrantsMore } from '~/utils/planUtils';
import { PLAN_CONFIG, type Plan } from '~/config/plans';

const ALL_PLANS: Plan[] = ['free', 'basic', 'pro', 'max'];

describe('getSyncScope', () => {
  it('free: only products + collections enabled; everything webhook-less disabled', () => {
    const s = getSyncScope('free');
    expect(s.products.enabled).toBe(true);
    expect(s.collections.enabled).toBe(true);

    // The whole point of R1/R5: free is NOT entitled to these.
    expect(s.articles.enabled).toBe(false);
    expect(s.pages.enabled).toBe(false);
    expect(s.policies.enabled).toBe(false);
    expect(s.themes.enabled).toBe(false);
    expect(s.metaobjects.enabled).toBe(false);
    expect(s.menus.enabled).toBe(false);
  });

  it('basic: products/collections/pages/policies enabled; articles/themes/metaobjects/menus disabled', () => {
    const s = getSyncScope('basic');
    expect(s.products.enabled).toBe(true);
    expect(s.collections.enabled).toBe(true);
    expect(s.pages.enabled).toBe(true);
    expect(s.policies.enabled).toBe(true);

    expect(s.articles.enabled).toBe(false); // maxArticles 0
    expect(s.themes.enabled).toBe(false); // maxThemeTranslations 0
    expect(s.metaobjects.enabled).toBe(false); // not in contentTypes
    expect(s.menus.enabled).toBe(false); // not in contentTypes
  });

  it.each(['pro', 'max'] as const)(
    '%s: every phase enabled, including metaobjects + menus',
    (plan) => {
      const s = getSyncScope(plan);
      expect(s.products.enabled).toBe(true);
      expect(s.collections.enabled).toBe(true);
      expect(s.articles.enabled).toBe(true);
      expect(s.pages.enabled).toBe(true);
      expect(s.policies.enabled).toBe(true);
      expect(s.themes.enabled).toBe(true);
      expect(s.metaobjects.enabled).toBe(true);
      expect(s.menus.enabled).toBe(true);
    },
  );

  it.each(ALL_PLANS)(
    '%s: numeric caps mirror PLAN_CONFIG exactly',
    (plan) => {
      const s = getSyncScope(plan);
      const c = PLAN_CONFIG[plan];
      expect(s.products.max).toBe(c.maxProducts);
      expect(s.collections.max).toBe(c.maxCollections);
      expect(s.articles.max).toBe(c.maxArticles);
      expect(s.pages.max).toBe(c.maxPages);
      // policies/themes/metaobjects/menus carry no per-item cap param.
      expect(s.policies.max).toBeUndefined();
      expect(s.themes.max).toBeUndefined();
      expect(s.metaobjects.max).toBeUndefined();
      expect(s.menus.max).toBeUndefined();
    },
  );

  it('themes entitlement is derived (cacheEnabled.themes && maxThemeTranslations>0), not from contentTypes', () => {
    // pro/max have themes cache + a positive cap; basic has cache off + 0 cap.
    expect(getSyncScope('pro').themes.enabled).toBe(true);
    expect(getSyncScope('max').themes.enabled).toBe(true);
    expect(getSyncScope('basic').themes.enabled).toBe(false);
    expect(getSyncScope('free').themes.enabled).toBe(false);
  });
});

describe('planGrantsMore', () => {
  it('upgrade free → pro grants more (newly entitled phases)', () => {
    expect(planGrantsMore('free', 'pro')).toBe(true);
  });

  it('upgrade basic → pro grants more (articles/metaobjects/menus newly entitled + higher caps)', () => {
    expect(planGrantsMore('basic', 'pro')).toBe(true);
  });

  it('upgrade pro → max grants more (higher product/collection/article caps)', () => {
    expect(planGrantsMore('pro', 'max')).toBe(true);
  });

  it('downgrade pro → free does NOT grant more', () => {
    expect(planGrantsMore('pro', 'free')).toBe(false);
  });

  it('downgrade max → pro does NOT grant more', () => {
    expect(planGrantsMore('max', 'pro')).toBe(false);
  });

  it.each(ALL_PLANS)('lateral move %s → %s (same plan) does NOT grant more', (plan) => {
    expect(planGrantsMore(plan, plan)).toBe(false);
  });

  it('a pure cap increase on a still-enabled phase counts as "more" (basic → pro maxProducts 75 → 150)', () => {
    // Sanity-check the precondition so this test stays honest if config changes.
    expect(PLAN_CONFIG.pro.maxProducts).toBeGreaterThan(PLAN_CONFIG.basic.maxProducts);
    expect(getSyncScope('basic').products.enabled).toBe(true);
    expect(getSyncScope('pro').products.enabled).toBe(true);
    expect(planGrantsMore('basic', 'pro')).toBe(true);
  });
});
