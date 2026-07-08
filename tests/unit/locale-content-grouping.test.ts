/**
 * Unit tests for the LOCALE_CONTENT (Theme-Standardinhalte) key→group mapping.
 *
 * `getGroupIdForKey` drives how the ~4000+ ONLINE_STORE_THEME_LOCALE_CONTENT
 * keys are split into the left-hand navigation groups. The matcher is
 * ORDER-SENSITIVE: more specific patterns (e.g. `shopify.checkout.*`,
 * `templates.404.*`, `section.product.*`) MUST win over the generic prefix
 * they share (`shopify.*`, `templates.*`, `section.*`). A reordering or a
 * missing anchor silently dumps thousands of keys into the wrong / catch-all
 * group, so these are exactly the regressions worth pinning.
 *
 * Pure logic — the heavy module deps are mocked only so the import resolves.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Mocks: only to let background-sync.service import cleanly ─────────────────
vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('~/services/shopify-api-gateway.service', () => ({
  ShopifyApiGateway: class { graphql = vi.fn(); },
}));
vi.mock('~/db.server', () => ({ db: {} }));
vi.mock('~/services/sync-utils', () => ({
  fetchShopLocales: vi.fn(), fetchAllTranslations: vi.fn(),
  fetchShopMarkets: vi.fn().mockResolvedValue([]),
  // Pure helpers — mirror the real implementations so market-aware code paths
  // behave exactly like production with zero markets.
  marketLayersForLocale: (markets: { id: string; localeCodes: string[] }[], locale: string) =>
    ['', ...markets.filter((m) => m.localeCodes.length === 0 || m.localeCodes.includes(locale)).map((m) => m.id)],
  fetchedMarketLayers: (markets: { id: string }[]) => ['', ...markets.map((m) => m.id)],
}));
vi.mock('~/services/content-sync.service', () => ({ ContentSyncService: class {} }));

import { getGroupIdForKey, THEME_KEY_PATTERNS } from '~/services/background-sync.service';

describe('getGroupIdForKey — LOCALE_CONTENT prefix grouping', () => {
  // ── The documented LOCALE_CONTENT top-level prefixes (Theme-Standardinhalte) ──
  const topLevelPrefixes: Array<[string, string]> = [
    ['accessibility.skip_to_content', 'accessibility'],
    ['accounts.login.title', 'accounts'],
    ['announcement_bar.message', 'announcement_bar'],
    ['blogs.article.read_more', 'blogs_theme'],
    ['customer_accounts.profile.title', 'customer_accounts'],
    ['customer.order.title', 'customer'],
    ['general.search.placeholder', 'general'],
    ['gift_cards.issued.subtext', 'gift_cards'],
    ['localization.country_label', 'localization'],
    ['newsletter.label', 'newsletter'],
    ['onboarding.product_title', 'onboarding'],
    ['products.product.add_to_cart', 'products_theme'],
    ['recipient.email_label', 'recipient'],
    ['sections.cart.title', 'sections_theme'],
    ['templates.contact.form', 'templates_theme'],
  ];

  it.each(topLevelPrefixes)('maps %s → %s', (key, expected) => {
    expect(getGroupIdForKey(key)).toBe(expected);
  });

  // ── Singular/plural tolerance ──
  it('accepts both gift_card.* and gift_cards.*', () => {
    expect(getGroupIdForKey('gift_card.recipient.label')).toBe('gift_cards');
    expect(getGroupIdForKey('gift_cards.issued.subtext')).toBe('gift_cards');
  });

  // ── shopify.* namespace: specific sub-namespaces win over the catch-all ──
  const shopifyCases: Array<[string, string]> = [
    ['shopify.checkout.general.page_title', 'shopify_checkout'],
    ['shopify.customer_accounts.order.title', 'shopify_customer_accounts'],
    ['shopify.email_marketing.subject', 'shopify_email_marketing'],
    ['shopify.subscriptions.manage', 'shopify_subscriptions'],
    ['shopify.sentence.connector', 'shopify_sentence'],
    ['shopify.something_else.key', 'shopify_other'], // falls through to catch-all
  ];
  it.each(shopifyCases)('routes %s → %s (specific beats shopify.*)', (key, expected) => {
    expect(getGroupIdForKey(key)).toBe(expected);
  });

  it('shopify.customer_accounts.* is NOT swallowed by the theme customer_accounts.* prefix', () => {
    // theme `customer_accounts.` exists too — ordering must keep the shopify.* hit first
    expect(getGroupIdForKey('shopify.customer_accounts.order.title')).toBe('shopify_customer_accounts');
    expect(getGroupIdForKey('customer_accounts.profile.title')).toBe('customer_accounts');
  });

  // ── section.* / templates.* ordering: specific anchors before the generic ──
  it('routes specific section.* templates before any generic fallback', () => {
    expect(getGroupIdForKey('section.article.byline')).toBe('article');
    expect(getGroupIdForKey('section.product.price')).toBe('product');
    expect(getGroupIdForKey('section.index.hero')).toBe('index');
  });

  it('templates.404.* and templates.list-collections.* win over templates.*', () => {
    expect(getGroupIdForKey('templates.404.title')).toBe('tpl_404');
    expect(getGroupIdForKey('templates.list-collections.heading')).toBe('tpl_list_coll');
    expect(getGroupIdForKey('templates.contact.form')).toBe('templates_theme'); // generic
  });

  // ── extractSubgroup: section.page.<name>.* → page_<name> ──
  it('extracts the page name into its own subgroup', () => {
    expect(getGroupIdForKey('section.page.about.heading')).toBe('page_about');
    expect(getGroupIdForKey('section.page.contact.form_title')).toBe('page_contact');
  });

  // ── Unmatched fallbacks ──
  it('falls back to misc_section_<name> for unknown section.* keys', () => {
    expect(getGroupIdForKey('section.unknown_widget.label')).toBe('misc_section_unknown_widget');
  });
  it('falls back to misc_<prefix> for unknown dotted keys', () => {
    expect(getGroupIdForKey('mystery.deep.key')).toBe('misc_mystery');
  });
  it('falls back to misc_<token> for keyless/single tokens', () => {
    expect(getGroupIdForKey('Settings Categories: Colors')).toBe('settings'); // matched pattern
    expect(getGroupIdForKey('loneword')).toBe('misc_loneword');
    expect(getGroupIdForKey('colon:separated')).toBe('misc_colon');
  });
});

describe('THEME_KEY_PATTERNS integrity', () => {
  it('every pattern carries a non-empty name, groupId and icon', () => {
    for (const p of THEME_KEY_PATTERNS) {
      expect(p.name.length, `name for ${p.groupId}`).toBeGreaterThan(0);
      expect(p.groupId.length, `groupId for ${p.name}`).toBeGreaterThan(0);
      expect(p.icon.length, `icon for ${p.groupId}`).toBeGreaterThan(0);
    }
  });

  it('groupIds are unique (no two patterns collapse into the same nav group by accident)', () => {
    const ids = THEME_KEY_PATTERNS.map((p) => p.groupId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the generic shopify.* catch-all is ordered AFTER its specific sub-namespaces', () => {
    const idx = (gid: string) => THEME_KEY_PATTERNS.findIndex((p) => p.groupId === gid);
    const generic = idx('shopify_other');
    for (const specific of ['shopify_checkout', 'shopify_customer_accounts', 'shopify_email_marketing', 'shopify_subscriptions', 'shopify_sentence']) {
      expect(idx(specific), `${specific} must precede shopify_other`).toBeLessThan(generic);
    }
  });

  it('the generic templates.* is ordered AFTER templates.404 / list-collections', () => {
    const idx = (gid: string) => THEME_KEY_PATTERNS.findIndex((p) => p.groupId === gid);
    const generic = idx('templates_theme');
    expect(idx('tpl_404')).toBeLessThan(generic);
    expect(idx('tpl_list_coll')).toBeLessThan(generic);
  });
});
