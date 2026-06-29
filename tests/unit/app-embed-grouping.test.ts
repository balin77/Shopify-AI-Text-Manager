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

import { extractAppEmbedBlockId, prettifyAppEmbedType } from '~/services/background-sync.service';

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
