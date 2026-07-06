/**
 * Unit Tests for app/utils/theme-id.ts — theme-id extraction/normalisation.
 *
 * Covers the Theme-Auswahl scoping primitive: pulling the theme_id out of a
 * translatable resourceId GID and normalising it to the canonical Theme-GID so
 * it is comparable with GET_THEMES ids. Pure functions — no mocks, no DB.
 */

import { describe, it, expect } from 'vitest';
import { extractThemeIdFromResourceId, normalizeThemeGid } from '~/utils/theme-id';

const GID = (n: string | number) => `gid://shopify/OnlineStoreTheme/${n}`;

describe('normalizeThemeGid', () => {
  it('normalises a bare numeric id to the canonical Theme-GID', () => {
    expect(normalizeThemeGid('123456')).toBe(GID(123456));
  });

  it('returns an already-canonical Theme-GID unchanged', () => {
    expect(normalizeThemeGid(GID(987))).toBe(GID(987));
  });

  it('takes the trailing numeric id from any other GID form', () => {
    expect(normalizeThemeGid('gid://shopify/Theme/555')).toBe(GID(555));
  });

  it('decodes URL-encoded values', () => {
    expect(normalizeThemeGid('gid%3A%2F%2Fshopify%2FOnlineStoreTheme%2F42')).toBe(GID(42));
  });

  it('returns null for empty/garbage', () => {
    expect(normalizeThemeGid(null)).toBeNull();
    expect(normalizeThemeGid(undefined)).toBeNull();
    expect(normalizeThemeGid('')).toBeNull();
    expect(normalizeThemeGid('not-a-theme')).toBeNull();
  });

  it('does not throw on malformed percent-encoding (falls back to raw)', () => {
    // decodeURIComponent("%") throws URIError — the helper must swallow it so a
    // single bad resourceId can never abort a sync/write.
    expect(() => normalizeThemeGid('100%')).not.toThrow();
    expect(normalizeThemeGid('100%')).toBeNull();
    expect(() => extractThemeIdFromResourceId('gid://x?theme_id=50%')).not.toThrow();
  });
});

describe('extractThemeIdFromResourceId', () => {
  it('extracts theme_id from a Settings-Category resourceId', () => {
    const rid =
      'gid://shopify/OnlineStoreThemeSettingsCategory/Brand+information?theme_id=123456&first_setting_id=brand_headline';
    expect(extractThemeIdFromResourceId(rid)).toBe(GID(123456));
  });

  it('extracts theme_id regardless of parameter position', () => {
    const rid = 'gid://shopify/OnlineStoreThemeJsonTemplate/index?first=x&theme_id=777';
    expect(extractThemeIdFromResourceId(rid)).toBe(GID(777));
  });

  it('handles a JSON template resourceId with only theme_id', () => {
    const rid = 'gid://shopify/OnlineStoreThemeJsonTemplate/product?theme_id=42';
    expect(extractThemeIdFromResourceId(rid)).toBe(GID(42));
  });

  it('returns null when no theme_id is embedded (fallback path)', () => {
    expect(extractThemeIdFromResourceId('gid://shopify/OnlineStoreTheme/1')).toBeNull();
    expect(extractThemeIdFromResourceId('gid://shopify/Product/1?foo=bar')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractThemeIdFromResourceId(null)).toBeNull();
    expect(extractThemeIdFromResourceId('')).toBeNull();
  });
});
