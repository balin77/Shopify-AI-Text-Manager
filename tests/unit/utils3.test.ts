/**
 * Unit Tests — FormData Utils + Validation Utils (Task 50 coverage increase)
 *
 * Covers:
 * - form-data.utils.ts (getFormString, getFormStringOrNull, getFormInt, getFormJSON)
 * - validation.ts (parseFormData, safeJsonParse, isValidShopDomain, isValidLocale, isValidShopifyGID)
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// ============================================================
// form-data.utils.ts
// ============================================================
import { getFormString, getFormStringOrNull, getFormInt, getFormJSON } from '~/utils/form-data.utils';

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    fd.append(k, v);
  }
  return fd;
}

describe('getFormString', () => {
  it('returns the value when key exists', () => {
    const fd = makeFormData({ name: 'Alice' });
    expect(getFormString(fd, 'name')).toBe('Alice');
  });

  it('returns empty string when key is missing', () => {
    const fd = makeFormData({});
    expect(getFormString(fd, 'missing')).toBe('');
  });
});

describe('getFormStringOrNull', () => {
  it('returns the value when key exists', () => {
    const fd = makeFormData({ title: 'My Title' });
    expect(getFormStringOrNull(fd, 'title')).toBe('My Title');
  });

  it('returns null when key is missing', () => {
    const fd = makeFormData({});
    expect(getFormStringOrNull(fd, 'missing')).toBeNull();
  });
});

describe('getFormInt', () => {
  it('parses a valid integer', () => {
    const fd = makeFormData({ count: '42' });
    expect(getFormInt(fd, 'count')).toBe(42);
  });

  it('returns null for non-numeric string', () => {
    const fd = makeFormData({ count: 'abc' });
    expect(getFormInt(fd, 'count')).toBeNull();
  });

  it('returns null when key is missing', () => {
    const fd = makeFormData({});
    expect(getFormInt(fd, 'missing')).toBeNull();
  });

  it('handles negative integers', () => {
    const fd = makeFormData({ offset: '-5' });
    expect(getFormInt(fd, 'offset')).toBe(-5);
  });
});

describe('getFormJSON', () => {
  it('parses valid JSON', () => {
    const fd = makeFormData({ data: '{"foo":"bar"}' });
    expect(getFormJSON(fd, 'data')).toEqual({ foo: 'bar' });
  });

  it('returns null for invalid JSON', () => {
    const fd = makeFormData({ data: 'not-json' });
    expect(getFormJSON(fd, 'data')).toBeNull();
  });

  it('returns null when key is missing', () => {
    const fd = makeFormData({});
    expect(getFormJSON(fd, 'missing')).toBeNull();
  });

  it('parses JSON arrays', () => {
    const fd = makeFormData({ list: '[1,2,3]' });
    expect(getFormJSON<number[]>(fd, 'list')).toEqual([1, 2, 3]);
  });
});

// ============================================================
// validation.ts — pure helper functions (no Shopify/DB deps)
// ============================================================
import { safeJsonParse, isValidShopDomain, isValidLocale, isValidShopifyGID, parseFormData } from '~/utils/validation';

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });

  it('returns fallback for invalid JSON', () => {
    expect(safeJsonParse('not-json', { default: true })).toEqual({ default: true });
  });

  it('returns fallback for null', () => {
    expect(safeJsonParse(null, 'fallback')).toBe('fallback');
  });

  it('returns fallback for undefined', () => {
    expect(safeJsonParse(undefined, 42)).toBe(42);
  });
});

describe('isValidShopDomain', () => {
  it('accepts valid .myshopify.com domains', () => {
    expect(isValidShopDomain('my-shop.myshopify.com')).toBe(true);
    expect(isValidShopDomain('test123.myshopify.com')).toBe(true);
  });

  it('rejects domains without .myshopify.com', () => {
    expect(isValidShopDomain('myshop.shopify.com')).toBe(false);
    expect(isValidShopDomain('myshop.com')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidShopDomain('')).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(isValidShopDomain('MyShop.myshopify.com')).toBe(false);
  });
});

describe('isValidLocale', () => {
  it('accepts 2-letter locale codes', () => {
    expect(isValidLocale('de')).toBe(true);
    expect(isValidLocale('en')).toBe(true);
    expect(isValidLocale('fr')).toBe(true);
  });

  it('accepts locale codes with region', () => {
    expect(isValidLocale('en-US')).toBe(true);
    expect(isValidLocale('de-DE')).toBe(true);
    expect(isValidLocale('zh-CN')).toBe(true);
  });

  it('rejects invalid formats', () => {
    expect(isValidLocale('')).toBe(false);
    expect(isValidLocale('DE')).toBe(false);
    expect(isValidLocale('eng')).toBe(false);
    expect(isValidLocale('en-us')).toBe(false); // lowercase region
  });
});

describe('isValidShopifyGID', () => {
  it('accepts valid Shopify GIDs', () => {
    expect(isValidShopifyGID('gid://shopify/Product/123')).toBe(true);
    expect(isValidShopifyGID('gid://shopify/Collection/456')).toBe(true);
    expect(isValidShopifyGID('gid://shopify/MediaImage/789')).toBe(true);
  });

  it('rejects malformed GIDs', () => {
    expect(isValidShopifyGID('shopify://Product/123')).toBe(false);
    expect(isValidShopifyGID('gid://shopify/product/123')).toBe(false); // lowercase type
    expect(isValidShopifyGID('gid://shopify/Product/abc')).toBe(false); // non-numeric ID
    expect(isValidShopifyGID('')).toBe(false);
  });
});

describe('parseFormData', () => {
  const TestSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
  });

  it('returns success for valid data', () => {
    const fd = makeFormData({ name: 'Alice', email: 'alice@example.com' });
    const result = parseFormData(fd, TestSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Alice');
    }
  });

  it('returns failure with error message for invalid data', () => {
    const fd = makeFormData({ name: '', email: 'not-an-email' });
    const result = parseFormData(fd, TestSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Validation failed');
    }
  });

  it('parses numeric fields correctly via heuristic', () => {
    const NumSchema = z.object({
      hfMaxTokensPerMinute: z.number().optional(),
    });
    const fd = makeFormData({ hfMaxTokensPerMinute: '5000' });
    const result = parseFormData(fd, NumSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hfMaxTokensPerMinute).toBe(5000);
    }
  });
});
