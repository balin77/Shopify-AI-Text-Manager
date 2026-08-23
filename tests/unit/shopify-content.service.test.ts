/**
 * Unit Tests for ShopifyContentService — Article SEO metafield persistence
 *
 * Closes a persistence gap: Article SEO title/description were only ever
 * written to the local DB cache, never to Shopify. Pages/Blogs already write
 * them as `global.title_tag` / `global.description_tag` metafields inline in
 * their update mutation — updateArticle() now mirrors that exactly.
 *
 * Focus:
 *   1. updateArticle() includes a `metafields` array (global.title_tag /
 *      global.description_tag) in the mutation variables when seoTitle/
 *      seoDescription are provided, and omits `metafields` entirely when
 *      neither is provided (so other fields are left untouched).
 *   2. updateContent()'s 'Article' branch (primary-locale save path used by
 *      the single-item editor) forwards updates.seoTitle/metaDescription
 *      into updateArticle() — this is the exact gap that was silently
 *      dropping SEO fields before.
 *
 * ✅ No real Shopify API needed (admin.graphql is mocked)
 * ✅ No real database needed (db is a plain mock object passed into updateContent)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShopifyContentService } from '../../src/services/shopify-content.service';

vi.mock('~/utils/logger.server', () => ({
  loggers: {
    translation: vi.fn(),
    seo: vi.fn(),
  },
}));

vi.mock('~/utils/translation-save-lock.server', () => ({
  markTranslationSaved: vi.fn(),
  isTranslationRecentlySaved: vi.fn().mockReturnValue(false),
}));

/**
 * The translation-change policy and the echo-verified removal the featured-alt
 * invalidation below rides on. Both are pulled in through a dynamic import
 * inside updateContent, so they are mocked by module id like every other
 * collaborator in this file.
 */
const { policy, removeAcrossLocales } = vi.hoisted(() => ({
  policy: {
    purgeOnPrimaryChange: true,
    purgeUnreconciledSurfaces: true,
    autoTranslateExternalChanges: false,
    plan: 'max',
  },
  removeAcrossLocales: {
    /** locale\u0000key pairs Shopify confirms. null = confirm everything asked for. */
    confirms: null as null | string[],
    calls: [] as Array<{ resourceId: string; keys: string[]; locales: string[] }>,
  },
}));

vi.mock('../../app/services/translations/translation-change-policy.server', () => ({
  loadTranslationChangePolicy: vi.fn(async () => policy),
  isPurgeOnPrimaryChangeEnabled: vi.fn(async (_s: string, _d: unknown, o: { reconciled?: boolean } = {}) =>
    o.reconciled ? policy.purgeOnPrimaryChange : policy.purgeUnreconciledSurfaces,
  ),
}));

vi.mock('../../app/services/bulk-editor/translations.server', () => ({
  LOCALE_KEY_SEP: '\u0000',
  removeAndVerifyAcrossLocales: vi.fn(
    async (_gw: unknown, resourceId: string, keys: string[], locales: string[]) => {
      removeAcrossLocales.calls.push({ resourceId, keys, locales });
      const pairs =
        removeAcrossLocales.confirms ??
        locales.flatMap((l) => keys.map((k) => `${l}\u0000${k}`));
      return { confirmedPairs: new Set(pairs), userErrors: [] };
    },
  ),
}));

vi.mock('../../app/services/shopify-api-gateway.service', () => ({
  ShopifyApiGateway: class {
    constructor(public admin: unknown, public shop: string) {}
  },
}));

const { retranslate } = vi.hoisted(() => ({
  retranslate: { calls: [] as Array<Record<string, unknown>> },
}));

vi.mock('../../app/services/translations/stale-translation-sync.server', () => ({
  IN_APP_RETRANSLATED_RESOURCE_TYPES: new Set(['Page', 'Article', 'Blog', 'ShopPolicy']),
  reconcileAfterPrimarySave: vi.fn(async (args: Record<string, unknown>) => {
    retranslate.calls.push(args);
    return { removed: 0, retranslating: 1 };
  }),
}));

const shop = 'test.myshopify.com';
const articleId = 'gid://shopify/Article/123';

function makeAdmin() {
  const graphql = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        articleUpdate: {
          article: { id: articleId, title: 'Updated title' },
          userErrors: [],
        },
      },
    }),
  });
  return { graphql };
}

describe('ShopifyContentService.updateArticle()', () => {
  let admin: ReturnType<typeof makeAdmin>;
  let service: ShopifyContentService;

  beforeEach(() => {
    admin = makeAdmin();
    service = new ShopifyContentService(admin);
  });

  it('includes global.title_tag/description_tag metafields when seoTitle/seoDescription are set', async () => {
    await service.updateArticle(articleId, {
      title: 'Hello',
      seoTitle: 'SEO Title',
      seoDescription: 'SEO Description',
    });

    expect(admin.graphql).toHaveBeenCalledTimes(1);
    const [, options] = admin.graphql.mock.calls[0];
    expect(options.variables.article).toEqual({
      title: 'Hello',
      metafields: [
        { namespace: 'global', key: 'title_tag', value: 'SEO Title', type: 'single_line_text_field' },
        { namespace: 'global', key: 'description_tag', value: 'SEO Description', type: 'single_line_text_field' },
      ],
    });
  });

  it('omits metafields entirely when seoTitle/seoDescription are not provided', async () => {
    await service.updateArticle(articleId, { title: 'Hello', body: 'Body text' });

    const [, options] = admin.graphql.mock.calls[0];
    expect(options.variables.article).toEqual({ title: 'Hello', body: 'Body text' });
    expect(options.variables.article.metafields).toBeUndefined();
  });

  it('supports setting only seoTitle without touching seoDescription', async () => {
    await service.updateArticle(articleId, { seoTitle: 'Only Title' });

    const [, options] = admin.graphql.mock.calls[0];
    expect(options.variables.article.metafields).toEqual([
      { namespace: 'global', key: 'title_tag', value: 'Only Title', type: 'single_line_text_field' },
    ]);
  });
});

describe('ShopifyContentService.updateContent() — Article primary-locale branch', () => {
  let admin: ReturnType<typeof makeAdmin>;
  let service: ShopifyContentService;
  let db: any;

  beforeEach(() => {
    admin = makeAdmin();
    service = new ShopifyContentService(admin);
    db = {
      article: { update: vi.fn().mockResolvedValue({}) },
    };
  });

  it('forwards seoTitle/metaDescription to updateArticle() (Shopify) as well as the DB cache', async () => {
    const result = await service.updateContent({
      resourceId: articleId,
      resourceType: 'Article',
      locale: 'en',
      primaryLocale: 'en',
      updates: {
        title: 'New title',
        body: 'New body',
        seoTitle: 'New SEO title',
        metaDescription: 'New SEO description',
      },
      db,
      shop,
    });

    expect(result.success).toBe(true);

    // Shopify write: updateArticle() called with seoTitle/seoDescription mapped through
    expect(admin.graphql).toHaveBeenCalledTimes(1);
    const [, options] = admin.graphql.mock.calls[0];
    expect(options.variables.article.metafields).toEqual([
      { namespace: 'global', key: 'title_tag', value: 'New SEO title', type: 'single_line_text_field' },
      { namespace: 'global', key: 'description_tag', value: 'New SEO description', type: 'single_line_text_field' },
    ]);

    // DB cache write: still updated as before
    expect(db.article.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          seoTitle: 'New SEO title',
          seoDescription: 'New SEO description',
        }),
      }),
    );
  });

  it('does not send a metafields array when SEO fields are absent from the update', async () => {
    await service.updateContent({
      resourceId: articleId,
      resourceType: 'Article',
      locale: 'en',
      primaryLocale: 'en',
      updates: { title: 'Only title change' },
      db,
      shop,
    });

    const [, options] = admin.graphql.mock.calls[0];
    expect(options.variables.article.metafields).toBeUndefined();
  });
});


/**
 * §6.6 for the FEATURED-IMAGE ALT of a Collection / Article — the third
 * translation shape (CLAUDE.md): Shopify stores it as key `alt` on the image's
 * OWN CollectionImage/ArticleImage GID, while the mirror row sits on the PARENT
 * under `image_alt_text`, and `imageAltText` is in no field→key map at all.
 * Neither half of the generic field purge can reach it, so a changed primary
 * alt used to leave every foreign alt translation live for good — in the single
 * editor only; the bulk editor has run this pass since Phase 4b.
 */
describe('ShopifyContentService.updateContent() — featured-image alt invalidation', () => {
  const collectionId = 'gid://shopify/Collection/77';
  const imageId = 'gid://shopify/CollectionImage/990';
  let admin: { graphql: ReturnType<typeof vi.fn> };
  let service: ShopifyContentService;
  let db: any;

  function makeCollectionAdmin() {
    const graphql = vi.fn(async (query: string) => ({
      ok: true,
      json: async () => {
        if (query.includes('getFeaturedImageId')) {
          return { data: { collection: { image: { id: imageId } } } };
        }
        if (query.includes('getShopLocales')) {
          return {
            data: {
              shopLocales: [
                { locale: 'de', primary: true, published: true },
                { locale: 'fr', primary: false, published: true },
                { locale: 'it', primary: false, published: true },
                { locale: 'es', primary: false, published: false },
              ],
            },
          };
        }
        return {
          data: { collectionUpdate: { collection: { id: collectionId, title: 'C' }, userErrors: [] } },
        };
      },
    }));
    return { graphql };
  }

  beforeEach(() => {
    policy.purgeOnPrimaryChange = true;
    policy.purgeUnreconciledSurfaces = true;
    policy.autoTranslateExternalChanges = false;
    removeAcrossLocales.calls = [];
    removeAcrossLocales.confirms = null;
    admin = makeCollectionAdmin();
    service = new ShopifyContentService(admin as never);
    db = {
      collection: { update: vi.fn().mockResolvedValue({}) },
      contentTranslation: {
        findMany: vi.fn().mockResolvedValue([{ locale: 'fr' }, { locale: 'it' }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
  });

  const save = (over: Record<string, unknown> = {}) =>
    service.updateContent({
      resourceId: collectionId,
      resourceType: 'Collection',
      locale: 'de',
      primaryLocale: 'de',
      updates: { title: 'C', imageAltText: 'Neuer Alt-Text' },
      changedAltTextIndices: [0],
      db,
      shop,
      ...over,
    });

  it('removes the alt translation on the IMAGE resource, not on the parent', async () => {
    await save();

    expect(removeAcrossLocales.calls).toHaveLength(1);
    expect(removeAcrossLocales.calls[0]).toMatchObject({
      resourceId: imageId,
      keys: ['alt'],
    });
    expect(removeAcrossLocales.calls[0].locales.sort()).toEqual(['fr', 'it']);
  });

  it('deletes the mirror row on the PARENT under image_alt_text', async () => {
    await save();

    const where = db.contentTranslation.deleteMany.mock.calls.at(-1)[0].where;
    expect(where).toMatchObject({
      resourceId: collectionId,
      resourceType: 'Collection',
      key: 'image_alt_text',
      marketId: '',
    });
    expect(where.locale.in.sort()).toEqual(['fr', 'it']);
  });

  it('keeps the local row for a locale Shopify did NOT confirm', async () => {
    removeAcrossLocales.confirms = ['fr\u0000alt']; // it silently no-ops
    await save();

    const where = db.contentTranslation.deleteMany.mock.calls.at(-1)[0].where;
    expect(where.locale.in).toEqual(['fr']);
  });

  it('talks to Shopify only when a translation actually exists', async () => {
    db.contentTranslation.findMany.mockResolvedValue([]);
    await save();

    expect(removeAcrossLocales.calls).toEqual([]);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('does nothing when the merchant switched the deletion off', async () => {
    policy.purgeUnreconciledSurfaces = false;
    await save();

    expect(removeAcrossLocales.calls).toEqual([]);
  });

  it('is UNRECONCILED — auto-translate does not stand its deletion down', async () => {
    // No sync and no re-translation in this app ever looks at a CollectionImage,
    // so suppressing the removal here would leave the old alt live for good.
    policy.autoTranslateExternalChanges = true;
    policy.purgeOnPrimaryChange = false;
    await save();

    expect(removeAcrossLocales.calls).toHaveLength(1);
  });

  it('leaves the alt alone when it did not change', async () => {
    await save({ updates: { title: 'C' } });

    expect(removeAcrossLocales.calls).toEqual([]);
  });

  it('ignores a primary save that carries an alt the MERCHANT did not change', async () => {
    // The accept-and-translate flow writes the accepted FOREIGN alt, then
    // submits its own primary save carrying `imageAltTexts` — with no
    // `changedAltTextIndices`, because no merchant touched the primary field.
    // Purging on that would delete the very translation the flow just created
    // and the ones its translate-to-all-locales step is about to write.
    await save({ changedAltTextIndices: undefined });

    expect(removeAcrossLocales.calls).toEqual([]);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('never fails the save when the invalidation throws', async () => {
    db.contentTranslation.findMany.mockRejectedValue(new Error('db down'));
    const result = await save();

    expect(result.success).toBe(true);
  });
});


/**
 * A page / article / blog / policy has NO Shopify webhook, so the save that
 * changed the primary text is the only event that will ever notice. Before
 * `reconcileAfterPrimarySave` existed, a Max shop with auto-translate on got
 * the new text on a product (webhook + sync) and a DELETED translation on a
 * page — the same edit, two opposite outcomes.
 */
describe('ShopifyContentService.updateContent() — re-translation on the webhook-less types', () => {
  const pageId = 'gid://shopify/Page/7';
  let admin: { graphql: ReturnType<typeof vi.fn> };
  let service: ShopifyContentService;
  let db: any;
  let removedFromShopify: Array<{ keys: string[]; locales: string[] }>;

  beforeEach(() => {
    policy.purgeOnPrimaryChange = false; // what the policy module resolves to with auto-translate on
    policy.purgeUnreconciledSurfaces = true; // the merchant's own stored choice, untouched
    policy.autoTranslateExternalChanges = true;
    retranslate.calls = [];
    removedFromShopify = [];

    admin = {
      graphql: vi.fn(async (query: string, opts?: any) => ({
        ok: true,
        json: async () => {
          if (query.includes('getShopLocales')) {
            return {
              data: {
                shopLocales: [
                  { locale: 'de', primary: true, published: true },
                  { locale: 'fr', primary: false, published: true },
                ],
              },
            };
          }
          if (query.includes('getTranslatableContent')) {
            return {
              data: {
                translatableResource: {
                  translatableContent: [
                    { key: 'title', value: 'Neuer Titel', digest: 'd-new', locale: 'de' },
                    { key: 'body_html', value: '<p>Neu</p>', digest: 'b-new', locale: 'de' },
                  ],
                },
              },
            };
          }
          if (query.includes('translationsRemove')) {
            removedFromShopify.push({
              keys: opts?.variables?.translationKeys,
              locales: opts?.variables?.locales,
            });
            return { data: { translationsRemove: { userErrors: [] } } };
          }
          return { data: { pageUpdate: { page: { id: pageId, title: 'Neuer Titel' }, userErrors: [] } } };
        },
      })),
    };
    service = new ShopifyContentService(admin as never);
    db = {
      page: { update: vi.fn().mockResolvedValue({}) },
      contentTranslation: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
  });

  const savePage = (over: Record<string, unknown> = {}) =>
    service.updateContent({
      resourceId: pageId,
      resourceType: 'Page',
      locale: 'de',
      primaryLocale: 'de',
      updates: { title: 'Neuer Titel', body: '<p>Neu</p>' },
      changedFields: ['title', 'body'],
      db,
      shop,
      ...over,
    });

  it('hands the change to the re-translation instead of deleting it', async () => {
    await savePage();

    expect(removedFromShopify).toEqual([]);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
    expect(retranslate.calls).toHaveLength(1);
    expect(retranslate.calls[0]).toMatchObject({
      resourceId: pageId,
      resourceType: 'Page',
      contentKind: 'page',
      foreignLocales: ['fr'],
    });
    // The keys are Shopify's, mapped through the ONE canonical field→key map.
    expect((retranslate.calls[0].changedKeys as string[]).sort()).toEqual(['body_html', 'title']);
  });

  it('passes the NEW primary values and their NEW digests', async () => {
    // A re-registration needs both: the text to translate and the digest
    // `translationsRegister` refuses to work without.
    await savePage();

    expect(retranslate.calls[0].primaryContent).toEqual({
      title: { value: 'Neuer Titel', digest: 'd-new' },
      body_html: { value: '<p>Neu</p>', digest: 'b-new' },
    });
  });

  it('deletes as before when auto-translate is off', async () => {
    policy.autoTranslateExternalChanges = false;
    policy.purgeOnPrimaryChange = true;
    await savePage();

    expect(retranslate.calls).toEqual([]);
    expect(removedFromShopify).toHaveLength(1);
    expect(removedFromShopify[0].keys.sort()).toEqual(['body_html', 'title']);
    expect(removedFromShopify[0].locales).toEqual(['fr']);
    expect(db.contentTranslation.deleteMany).toHaveBeenCalled();
  });

  it('leaves a Collection to its webhook rather than starting a second run', async () => {
    // collections/update already runs the sync-side reconciliation; a run
    // started here would queue a duplicate AI run behind a repair that has
    // already happened.
    await service.updateContent({
      resourceId: 'gid://shopify/Collection/3',
      resourceType: 'Collection',
      locale: 'de',
      primaryLocale: 'de',
      updates: { title: 'C' },
      changedFields: ['title'],
      db: { ...db, collection: { update: vi.fn().mockResolvedValue({}) } },
      shop,
    });

    expect(retranslate.calls).toEqual([]);
    expect(removedFromShopify).toEqual([]); // purgeOnPrimaryChange is false under auto-translate
  });

  it('never fails the save when the re-translation throws', async () => {
    const mod = await import('../../app/services/translations/stale-translation-sync.server');
    vi.mocked(mod.reconcileAfterPrimarySave).mockRejectedValueOnce(new Error('provider down'));

    const result = await savePage();
    expect(result.success).toBe(true);
  });
});
