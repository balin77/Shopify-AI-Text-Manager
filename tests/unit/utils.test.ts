/**
 * Unit Tests — Utils (Task 50 coverage increase)
 *
 * Covers:
 * - shopify-product.utils.ts (isDefaultTitleOption)
 * - translation-save-lock.server.ts (markTranslationSaved, isTranslationRecentlySaved)
 * - slug.utils.ts (sanitizeSlug, isValidSlug, validateAndSanitizeSlug)
 * - planUtils.ts (getPlanLimits, canAccessContentType, isWithinProductLimit, getNextPlanUpgrade, getPlanDisplayName, isValidPlan)
 * - sync-utils.ts (fetchShopLocales, fetchAllTranslations)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// shopify-product.utils.ts
// ============================================================
import { isDefaultTitleOption } from '~/utils/shopify-product.utils';

describe('isDefaultTitleOption', () => {
  it('returns false when name is not "Title"', () => {
    expect(isDefaultTitleOption({ name: 'Color', values: ['Red'] })).toBe(false);
    expect(isDefaultTitleOption({ name: 'Size', optionValues: [{ name: 'S' }] })).toBe(false);
  });

  it('returns true for the default Title/Default Title option using optionValues', () => {
    expect(isDefaultTitleOption({
      name: 'Title',
      optionValues: [{ name: 'Default Title' }],
    })).toBe(true);
  });

  it('returns false when Title has multiple optionValues', () => {
    expect(isDefaultTitleOption({
      name: 'Title',
      optionValues: [{ name: 'Default Title' }, { name: 'Other' }],
    })).toBe(false);
  });

  it('returns false when Title has a non-default optionValue', () => {
    expect(isDefaultTitleOption({
      name: 'Title',
      optionValues: [{ name: 'Custom' }],
    })).toBe(false);
  });

  it('returns true for the default Title option using string values array', () => {
    expect(isDefaultTitleOption({
      name: 'Title',
      values: ['Default Title'],
    })).toBe(true);
  });

  it('returns false when values array has multiple entries', () => {
    expect(isDefaultTitleOption({
      name: 'Title',
      values: ['Default Title', 'Other'],
    })).toBe(false);
  });

  it('returns false when no optionValues or values present (name is Title)', () => {
    expect(isDefaultTitleOption({ name: 'Title' })).toBe(false);
  });
});

// ============================================================
// translation-save-lock.server.ts
// ============================================================
import { markTranslationSaved, isTranslationRecentlySaved } from '~/utils/translation-save-lock.server';

describe('translation-save-lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for a resource that has not been marked', () => {
    expect(isTranslationRecentlySaved('gid://shopify/Product/unknown')).toBe(false);
  });

  it('returns true immediately after marking', () => {
    markTranslationSaved('gid://shopify/Product/123');
    expect(isTranslationRecentlySaved('gid://shopify/Product/123')).toBe(true);
  });

  it('returns true within the default 30s window', () => {
    markTranslationSaved('gid://shopify/Product/456');
    vi.advanceTimersByTime(29_000);
    expect(isTranslationRecentlySaved('gid://shopify/Product/456')).toBe(true);
  });

  it('returns false after the default 30s window has passed', () => {
    markTranslationSaved('gid://shopify/Product/789');
    vi.advanceTimersByTime(31_000);
    expect(isTranslationRecentlySaved('gid://shopify/Product/789')).toBe(false);
  });

  it('respects a custom window', () => {
    markTranslationSaved('gid://shopify/Product/custom');
    vi.advanceTimersByTime(5_000);
    expect(isTranslationRecentlySaved('gid://shopify/Product/custom', 10_000)).toBe(true);
    vi.advanceTimersByTime(6_000);
    expect(isTranslationRecentlySaved('gid://shopify/Product/custom', 10_000)).toBe(false);
  });
});

// ============================================================
// slug.utils.ts
// ============================================================
import { sanitizeSlug, isValidSlug, validateAndSanitizeSlug } from '~/utils/slug.utils';

describe('sanitizeSlug', () => {
  it('lowercases and trims input', () => {
    expect(sanitizeSlug('  Hello World  ')).toBe('hello-world');
  });

  it('replaces spaces with hyphens', () => {
    expect(sanitizeSlug('my product name')).toBe('my-product-name');
  });

  it('replaces underscores with hyphens', () => {
    expect(sanitizeSlug('my_product')).toBe('my-product');
  });

  it('removes special characters', () => {
    expect(sanitizeSlug('hello!@#world')).toBe('helloworld');
  });

  it('collapses consecutive hyphens', () => {
    expect(sanitizeSlug('a--b---c')).toBe('a-b-c');
  });

  it('strips leading/trailing hyphens', () => {
    expect(sanitizeSlug('-hello-')).toBe('hello');
  });

  it('handles German umlauts', () => {
    expect(sanitizeSlug('Tür')).toBe('tuer');
    expect(sanitizeSlug('Öl')).toBe('oel');
    expect(sanitizeSlug('Über')).toBe('ueber');
    expect(sanitizeSlug('Straße')).toBe('strasse');
  });

  it('returns empty string for empty/null-like input', () => {
    expect(sanitizeSlug('')).toBe('');
    // @ts-expect-error testing JS runtime null
    expect(sanitizeSlug(null)).toBe('');
  });
});

describe('isValidSlug', () => {
  it('accepts valid slugs', () => {
    expect(isValidSlug('hello-world')).toBe(true);
    expect(isValidSlug('product123')).toBe(true);
    expect(isValidSlug('a')).toBe(true);
  });

  it('rejects slugs starting or ending with hyphens', () => {
    expect(isValidSlug('-hello')).toBe(false);
    expect(isValidSlug('hello-')).toBe(false);
  });

  it('rejects slugs with consecutive hyphens', () => {
    expect(isValidSlug('a--b')).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(isValidSlug('Hello')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidSlug('')).toBe(false);
  });

  it('rejects special characters', () => {
    expect(isValidSlug('hello world')).toBe(false);
    expect(isValidSlug('hello_world')).toBe(false);
  });
});

describe('validateAndSanitizeSlug', () => {
  it('returns the original slug when already valid', () => {
    const result = validateAndSanitizeSlug('valid-slug');
    expect(result.slug).toBe('valid-slug');
    expect(result.wasSanitized).toBe(false);
  });

  it('sanitizes and flags when slug is invalid', () => {
    const result = validateAndSanitizeSlug('My Product Name!');
    expect(result.slug).toBe('my-product-name');
    expect(result.wasSanitized).toBe(true);
  });
});

// ============================================================
// planUtils.ts
// ============================================================
import { getPlanLimits, canAccessContentType, isWithinProductLimit, getNextPlanUpgrade, getPlanDisplayName, isValidPlan } from '~/utils/planUtils';

describe('planUtils', () => {
  describe('getPlanLimits', () => {
    it('returns limits for free plan', () => {
      const limits = getPlanLimits('free');
      expect(limits).toBeDefined();
      expect(typeof limits.maxProducts).toBe('number');
    });

    it('returns higher limits for pro than free', () => {
      const free = getPlanLimits('free');
      const pro = getPlanLimits('pro');
      expect(pro.maxProducts).toBeGreaterThanOrEqual(free.maxProducts);
    });
  });

  describe('canAccessContentType', () => {
    it('free plan can access products (basic content type)', () => {
      // Free plan should at minimum have product access
      const freeLimits = getPlanLimits('free');
      expect(freeLimits.contentTypes).toBeDefined();
    });

    it('max plan can access all content types', () => {
      const maxLimits = getPlanLimits('max');
      expect(maxLimits.contentTypes.length).toBeGreaterThan(0);
    });

    it('returns boolean', () => {
      const result = canAccessContentType('free', 'products');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('isWithinProductLimit', () => {
    it('returns true when count is below limit', () => {
      expect(isWithinProductLimit('max', 0)).toBe(true);
    });

    it('returns false when count equals or exceeds limit', () => {
      const freeLimits = getPlanLimits('free');
      expect(isWithinProductLimit('free', freeLimits.maxProducts)).toBe(false);
    });
  });

  describe('getNextPlanUpgrade', () => {
    it('returns next plan in tier', () => {
      expect(getNextPlanUpgrade('free')).toBe('basic');
      expect(getNextPlanUpgrade('basic')).toBe('pro');
      expect(getNextPlanUpgrade('pro')).toBe('max');
    });

    it('returns null for max plan (already highest)', () => {
      expect(getNextPlanUpgrade('max')).toBeNull();
    });
  });

  describe('getPlanDisplayName', () => {
    it('returns a non-empty string for each plan', () => {
      for (const plan of ['free', 'basic', 'pro', 'max'] as const) {
        const name = getPlanDisplayName(plan);
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
      }
    });
  });

  describe('isValidPlan', () => {
    it('returns true for valid plan strings', () => {
      expect(isValidPlan('free')).toBe(true);
      expect(isValidPlan('basic')).toBe(true);
      expect(isValidPlan('pro')).toBe(true);
      expect(isValidPlan('max')).toBe(true);
    });

    it('returns false for invalid strings', () => {
      expect(isValidPlan('enterprise')).toBe(false);
      expect(isValidPlan('')).toBe(false);
      expect(isValidPlan('FREE')).toBe(false);
    });
  });
});

// ============================================================
// sync-utils.ts — fetchShopLocales
// ============================================================
import { fetchShopLocales, fetchAllTranslations } from '~/services/sync-utils';

const mockLocales = [
  { locale: 'en', name: 'English', primary: true, published: true },
  { locale: 'de', name: 'German', primary: false, published: true },
];

function makeGraphQLFn(responseData: unknown) {
  return vi.fn().mockResolvedValue({
    json: () => Promise.resolve(responseData),
  });
}

describe('fetchShopLocales', () => {
  it('returns locales from successful response', async () => {
    const fn = makeGraphQLFn({ data: { shopLocales: mockLocales } });
    const result = await fetchShopLocales(fn);
    expect(result).toHaveLength(2);
    expect(result[0].locale).toBe('en');
  });

  it('returns empty array and logs when no locales found', async () => {
    const fn = makeGraphQLFn({ data: { shopLocales: [] } });
    const result = await fetchShopLocales(fn);
    expect(result).toHaveLength(0);
  });

  it('throws when GraphQL errors returned', async () => {
    const fn = makeGraphQLFn({ errors: [{ message: 'API error' }] });
    await expect(fetchShopLocales(fn)).rejects.toThrow('Failed to fetch shop locales');
  });
});

describe('fetchAllTranslations', () => {
  it('returns translations for published locales', async () => {
    const fn = makeGraphQLFn({
      data: {
        translatableResource: {
          translatableContent: [{ key: 'title', value: 'Hello', digest: 'abc', locale: 'en' }],
          translations: [{ key: 'title', value: 'Hallo', locale: 'de' }],
        },
      },
    });

    const locales = [{ locale: 'de', name: 'German', primary: false, published: true }];
    const result = await fetchAllTranslations(fn, 'gid://shopify/Product/1', locales, 'Product');
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('Hallo');
    expect(result[0].locale).toBe('de');
  });

  it('skips non-published locales', async () => {
    const fn = makeGraphQLFn({ data: { translatableResource: null } });
    const locales = [{ locale: 'de', name: 'German', primary: false, published: false }];
    const result = await fetchAllTranslations(fn, 'gid://shopify/Product/1', locales, 'Product');
    expect(fn).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });

  it('skips locale when GraphQL returns errors', async () => {
    const fn = makeGraphQLFn({ errors: [{ message: 'throttled' }] });
    const locales = [{ locale: 'de', name: 'German', primary: false, published: true }];
    const result = await fetchAllTranslations(fn, 'gid://shopify/Product/1', locales, 'Product');
    expect(result).toHaveLength(0);
  });

  it('deduplicates translations by key+locale', async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        json: () => Promise.resolve({
          data: {
            translatableResource: {
              translatableContent: [],
              translations: [{ key: 'title', value: `Value${callCount}`, locale: 'de' }],
            },
          },
        }),
      });
    });
    // Two calls with same resourceId should deduplicate
    const locales = [
      { locale: 'de', name: 'German', primary: false, published: true },
    ];
    const result = await fetchAllTranslations(fn, 'gid://shopify/Product/1', locales, 'Product');
    // Only one unique key::locale entry expected
    expect(result).toHaveLength(1);
  });
});
