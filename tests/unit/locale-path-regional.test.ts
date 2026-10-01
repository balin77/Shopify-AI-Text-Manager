/**
 * The locale-prefix rule has to survive a REGIONAL locale.
 *
 * CLAUDE.md: "Every path rule must survive a locale prefix" — a rule anchored
 * at `/cart` silently applies to the primary locale only unless the prefix is
 * stripped first. That was fixed for `/it/cart`, but the segment pattern still
 * refused a numeric region, so `/es-419/cart` and `/es-419/account` went
 * unstripped: crawled and reported, on exactly the PII-adjacent paths the
 * denylist exists for. Same for a script subtag (`/zh-hans/…`).
 */
import { describe, it, expect } from 'vitest';
import {
  LOCALE_SEGMENT_RE,
  stripLocalePrefix,
  localeVariants,
} from '~/services/seo/locale-path.shared';

describe('LOCALE_SEGMENT_RE', () => {
  it('matches the locale segments Shopify serves', () => {
    for (const seg of ['de', 'en', 'fil', 'en-us', 'pt-br', 'pt-BR', 'zh-hans', 'zh-Hant', 'es-419']) {
      expect(LOCALE_SEGMENT_RE.test(seg)).toBe(true);
    }
  });

  it('does not swallow a storefront content segment', () => {
    for (const seg of ['products', 'collections', 'pages', 'blogs', 'policies', 'cart', 'account', 'search', '419']) {
      expect(LOCALE_SEGMENT_RE.test(seg)).toBe(false);
    }
  });
});

describe('stripLocalePrefix', () => {
  it('strips a regional prefix, so a /cart rule still matches', () => {
    expect(stripLocalePrefix('/es-419/cart')).toBe('/cart');
    expect(stripLocalePrefix('/es-419/account/login')).toBe('/account/login');
    expect(stripLocalePrefix('/zh-hans/policies/refund-policy')).toBe('/policies/refund-policy');
  });

  it('still strips the shapes it always did, and leaves the rest alone', () => {
    expect(stripLocalePrefix('/it/cart')).toBe('/cart');
    expect(stripLocalePrefix('/pt-br/cart')).toBe('/cart');
    expect(stripLocalePrefix('/cart')).toBe('/cart');
    expect(stripLocalePrefix('/products/kumiko-box')).toBe('/products/kumiko-box');
  });
});

describe('localeVariants', () => {
  it('reports both forms for a regional URL', () => {
    const { lower, withoutLocale } = localeVariants('https://shop.example/es-419/cart?x=1');
    expect(lower).toBe('/es-419/cart?x=1');
    expect(withoutLocale).toBe('/cart?x=1');
  });
});
