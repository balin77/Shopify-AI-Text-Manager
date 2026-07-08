/**
 * Unit tests for the app-embed naming helpers used by syncAllThemes.
 *
 * ONLINE_STORE_THEME_APP_EMBED resources are now grouped one-per-resource (one
 * nav entry per installed embed) instead of collapsing into a single "block"
 * bucket. The display name is derived from the theme's settings_data.json via
 * the app-block `type`. These helpers turn the raw key/type strings into the
 * blockId used for lookup and the human label shown in the item list.
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
}));
vi.mock('~/services/content-sync.service', () => ({ ContentSyncService: class {} }));

import { extractAppEmbedBlockId, appEmbedGroupId, prettifyAppEmbedType, isOwnAppEmbedType } from '~/services/background-sync.service';

describe('extractAppEmbedBlockId', () => {
  it('reads the blockId shared by an embed resource\'s keys', () => {
    const content = [
      { key: 'block.6631763587162098437.header_selector' },
      { key: 'block.6631763587162098437.footer_selector' },
    ];
    expect(extractAppEmbedBlockId(content)).toBe('6631763587162098437');
  });

  it('returns null when no key follows the block.<id>.* shape', () => {
    expect(extractAppEmbedBlockId([{ key: 'name' }, { key: 'title' }])).toBeNull();
    expect(extractAppEmbedBlockId([])).toBeNull();
  });
});

describe('appEmbedGroupId', () => {
  // The two blocks of one app share a resourceId tail (everything after "?"),
  // so keying the group by resourceId collapsed switcher + gallery into one
  // entry. Keying by blockId keeps them apart.
  it('keys by blockId so two blocks of the same app stay distinct', () => {
    const switcher = appEmbedGroupId(
      'gid://shopify/OnlineStoreThemeAppEmbed/123?12221302618087021987',
      '12221302618087021987'
    );
    const gallery = appEmbedGroupId(
      'gid://shopify/OnlineStoreThemeAppEmbed/123?8064757537981474425',
      '8064757537981474425'
    );
    expect(switcher).toBe('app_embed_12221302618087021987');
    expect(gallery).toBe('app_embed_8064757537981474425');
    expect(switcher).not.toBe(gallery);
  });

  it('falls back to the resourceId tail when no blockId is present', () => {
    expect(appEmbedGroupId('gid://shopify/OnlineStoreThemeAppEmbed/999?x', null))
      .toBe('app_embed_999');
  });
});

describe('prettifyAppEmbedType', () => {
  it('derives an "App – Block" label from an app-block type', () => {
    expect(
      prettifyAppEmbedType('shopify://apps/contentpilot-ai/blocks/language-currency/abcd1234')
    ).toBe('Contentpilot Ai – Language Currency');
  });

  it('title-cases underscore handles too', () => {
    expect(
      prettifyAppEmbedType('shopify://apps/contentpilot-ai/blocks/variant_image_gallery/ef56')
    ).toBe('Contentpilot Ai – Variant Image Gallery');
  });

  it('returns null for non-app-block types and non-strings', () => {
    expect(prettifyAppEmbedType('text')).toBeNull();
    expect(prettifyAppEmbedType('shopify://shop/...')).toBeNull();
    expect(prettifyAppEmbedType(undefined)).toBeNull();
    expect(prettifyAppEmbedType(42)).toBeNull();
  });
});

describe('isOwnAppEmbedType', () => {
  it('matches our own app-embed blocks (prod + dev handles)', () => {
    expect(isOwnAppEmbedType('shopify://apps/contentpilot-ai/blocks/locale-switcher/abcd')).toBe(true);
    expect(isOwnAppEmbedType('shopify://apps/contentpilot-ai-dev/blocks/variant-gallery/ef56')).toBe(true);
  });

  it('does NOT match other apps\' embeds (they stay editable)', () => {
    expect(isOwnAppEmbedType('shopify://apps/klaviyo/blocks/signup-form/1234')).toBe(false);
    expect(isOwnAppEmbedType('shopify://apps/judgeme-reviews/blocks/widget/9999')).toBe(false);
  });

  it('returns false for non-app-block types and non-strings', () => {
    expect(isOwnAppEmbedType('text')).toBe(false);
    expect(isOwnAppEmbedType('shopify://shop/...')).toBe(false);
    expect(isOwnAppEmbedType(undefined)).toBe(false);
    expect(isOwnAppEmbedType(42)).toBe(false);
  });
});
