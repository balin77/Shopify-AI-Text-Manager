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

  it('asks for every foreign locale, not only the ones the mirror knows', async () => {
    // An alt text translated in Shopify's own editor has no row here. Gating on
    // the mirror would leave exactly those live on the storefront describing an
    // alt text that no longer exists — the same reasoning the field path
    // follows, which has always removed blindly across the foreign locales.
    db.contentTranslation.findMany.mockResolvedValue([]);
    removeAcrossLocales.confirms = ['it\u0000alt']; // only `it` really had one
    await save();

    expect(removeAcrossLocales.calls[0].locales.sort()).toEqual(['fr', 'it']);
    // ...and only what Shopify confirmed is deleted locally.
    expect(db.contentTranslation.deleteMany.mock.calls.at(-1)[0].where.locale.in).toEqual(['it']);
  });

  it('writes no local delete when Shopify confirms nothing', async () => {
    removeAcrossLocales.confirms = [];
    await save();

    expect(removeAcrossLocales.calls).toHaveLength(1);
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
    // The keys are Shopify's, mapped through the ONE canonical field→key map,
    // and they name no resource of their own — a content type's keys live on
    // the resource being saved.
    const changed = retranslate.calls[0].changed as Array<{ key: string; resourceId?: string }>;
    expect(changed.map((c) => c.key).sort()).toEqual(['body_html', 'title']);
    expect(changed.every((c) => c.resourceId === undefined)).toBe(true);
  });

  it('does not read the primary values back itself', async () => {
    // The repair fetches the new text and its digest from Shopify, batched over
    // the whole group. A digest handed down from here would be the one the
    // caller's OWN write just invalidated.
    await savePage();

    expect(retranslate.calls[0].primaryContent).toBeUndefined();
    expect(
      admin.graphql.mock.calls.some((call: unknown[]) => String(call[0]).includes('getTranslatableContent')),
    ).toBe(false);
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


/**
 * updateContent() — the SINGLE editor's foreign-locale save, under the same
 * echo rule as translateAllContent's three tiers.
 *
 * This path judged a save from `userErrors: []` alone until now: it mirrored
 * every sent field into `ContentTranslation` and answered `{ success: true }`,
 * so Shopify accepting a call and storing nothing (the historic silent no-op
 * CLAUDE.md names) told one merchant editing one field that their translation
 * was live while the storefront kept serving the primary text — and left a
 * local row nothing would ever correct downwards.
 *
 * It is a BOTTOM tier: one call, one locale, nothing narrower behind it, so an
 * ABSENT echo counts as not stored exactly like the individual tier's.
 *
 * These also pin the second half — the mirror holds the value Shopify ECHOED,
 * not the one submitted — and the rule that must not be collapsed into it: a
 * field with no digest was never sent, is not a refusal, and still gets its DB
 * row.
 */
describe('ShopifyContentService.updateContent() — the foreign-locale save is judged by the echo', () => {
  const pageId = 'gid://shopify/Page/77';

  /**
   * The digest query answers for both fields; `register` decides what
   * `translationsRegister` says, which is the variable under test.
   */
  function makeAdmin(register: any | ((variables: any) => any)) {
    const registerCalls: any[] = [];
    const graphql = vi.fn().mockImplementation(async (document: string, options?: any) => {
      const variables = options?.variables;
      if (document.includes('translationsRegister')) registerCalls.push(variables);
      return {
        ok: true,
        json: async () => {
          if (document.includes('translationsRegister')) {
            return typeof register === 'function' ? register(variables) : register;
          }
          return {
            data: {
              translatableResource: {
                translatableContent: [
                  { key: 'title', value: 'Kumiko-Box', digest: 'digest-title' },
                  { key: 'handle', value: 'kumiko-box', digest: 'digest-handle' },
                ],
              },
            },
          };
        },
      };
    });
    return { graphql, registerCalls };
  }

  /** The upsert spy is shared with the transaction callback, so a test can ask
   *  what was mirrored — the DB half of the echo rule. */
  function makeDb() {
    const upsert = vi.fn();
    const deleteMany = vi.fn();
    return {
      $transaction: vi.fn(async (fn: any) => fn({ contentTranslation: { upsert, deleteMany } })),
      contentTranslation: { upsert, deleteMany },
    } as any;
  }

  /** translationKey → the value the mirror row was written with. */
  const mirrored = (db: any): Record<string, string> =>
    Object.fromEntries(
      db.contentTranslation.upsert.mock.calls.map((c: any[]) => [c[0].create.key, c[0].create.value]),
    );

  const save = (admin: any, db: any, updates: Record<string, string>) =>
    new ShopifyContentService(admin as any).updateContent({
      resourceId: pageId,
      resourceType: 'Page',
      locale: 'es',
      primaryLocale: 'de',
      updates,
      db,
      shop,
    } as any);

  /** Shopify's honest answer: it echoes back exactly what it stored. */
  const echoEverything = (variables: any) => ({
    data: {
      translationsRegister: {
        userErrors: [],
        translations: (variables.translations ?? []).map((t: any) => ({
          locale: t.locale, key: t.key, value: t.value,
        })),
      },
    },
  });

  it('reports an accepted-but-un-echoed write as a FAILED save and mirrors nothing', async () => {
    // No errors, no userErrors, and an empty echo — an ANSWER ("nothing was
    // stored"), which used to read as a clean success.
    const admin = makeAdmin({ data: { translationsRegister: { userErrors: [], translations: [] } } });
    const db = makeDb();

    const result = await save(admin, db, { title: 'Caja Kumiko' });

    expect(result.success).toBe(false);
    expect(String((result as any).error)).toContain('title');
    expect(mirrored(db)).toEqual({});
  });

  it('treats a response with NO echo the same way — there is no narrower re-send here', async () => {
    // The throttled shape: `data: null`, no userErrors, nothing echoed. In the
    // batch tiers of translateAllContent this means "ask again"; on this path
    // there is nothing narrower to ask, and the merchant is standing in front
    // of a form that still holds their text.
    const admin = makeAdmin({ data: null });
    const db = makeDb();

    const result = await save(admin, db, { title: 'Caja Kumiko' });

    expect(result.success).toBe(false);
    expect(mirrored(db)).toEqual({});
  });

  it('mirrors the echoed half of a partial save and reports the rest as a warning', async () => {
    // The confirmed field is live on the storefront; failing the whole save
    // over its neighbour would invite the merchant to re-type text that landed.
    const admin = makeAdmin((variables: any) => ({
      data: {
        translationsRegister: {
          userErrors: [],
          translations: (variables.translations ?? [])
            .filter((t: any) => t.key === 'title')
            .map((t: any) => ({ locale: t.locale, key: t.key, value: t.value })),
        },
      },
    }));
    const db = makeDb();

    const result = await save(admin, db, { title: 'Caja Kumiko', handle: 'caja-kumiko' });

    expect(result.success).toBe(true);
    expect(String((result as any).warning)).toContain('handle');
    expect(mirrored(db)).toEqual({ title: 'Caja Kumiko' });
  });

  it('mirrors the handle SHOPIFY stored, not the one submitted', async () => {
    // The redirect rule: the target is "the handle Shopify echoed back, not
    // the one submitted", and this row is what the translated-handle redirect
    // and `resolvePathsToResources` both read.
    const admin = makeAdmin((variables: any) => ({
      data: {
        translationsRegister: {
          userErrors: [],
          translations: (variables.translations ?? []).map((t: any) => ({
            locale: t.locale,
            key: t.key,
            value: t.key === 'handle' ? 'caja-kumiko' : t.value,
          })),
        },
      },
    }));
    const db = makeDb();

    const result = await save(admin, db, { handle: 'Caja Kumiko!' });

    expect(result.success).toBe(true);
    // Sent unchanged — the echo never edits what goes on the wire.
    expect(admin.registerCalls[0].translations[0].value).toBe('Caja Kumiko!');
    expect(mirrored(db)).toEqual({ handle: 'caja-kumiko' });
  });

  it('falls back to the sent value when the echo names the key but carries no value', async () => {
    // A present key with `value: null` confirms the WRITE and answers nothing
    // about the content — mirroring "" there would blank a live translation.
    const admin = makeAdmin((variables: any) => ({
      data: {
        translationsRegister: {
          userErrors: [],
          translations: (variables.translations ?? []).map((t: any) => ({
            locale: t.locale, key: t.key, value: null,
          })),
        },
      },
    }));
    const db = makeDb();

    const result = await save(admin, db, { title: 'Caja Kumiko' });

    expect(result.success).toBe(true);
    expect(mirrored(db)).toEqual({ title: 'Caja Kumiko' });
  });

  it('still writes the DB row for a field Shopify has no digest for', async () => {
    // CLAUDE.md: `translationsRegister` requires a digest, Prisma does not.
    // Nothing was refused because nothing was asked — that is a different case
    // from an un-echoed write and must not be collapsed into it.
    const admin = makeAdmin(echoEverything);
    admin.graphql.mockImplementation(async (document: string, options?: any) => ({
      ok: true,
      json: async () =>
        document.includes('translationsRegister')
          ? echoEverything(options?.variables)
          : { data: { translatableResource: { translatableContent: [{ key: 'title', value: 'Kumiko-Box', digest: 'digest-title' }] } } },
    }));
    const db = makeDb();

    const result = await save(admin, db, { seoTitle: 'Caja Kumiko | Tienda' });

    expect(result.success).toBe(true);
    expect(String((result as any).warning)).toContain('meta_title');
    expect(mirrored(db)).toEqual({ meta_title: 'Caja Kumiko | Tienda' });
    // Never sent: no digest, nothing to register.
    expect(admin.registerCalls).toHaveLength(0);
  });

  it('reports both halves when one field has no digest and another goes un-echoed', async () => {
    const admin = makeAdmin({ data: { translationsRegister: { userErrors: [], translations: [] } } });
    admin.graphql.mockImplementation(async (document: string) => ({
      ok: true,
      json: async () =>
        document.includes('translationsRegister')
          ? { data: { translationsRegister: { userErrors: [], translations: [] } } }
          : { data: { translatableResource: { translatableContent: [{ key: 'title', value: 'Kumiko-Box', digest: 'digest-title' }] } } },
    }));
    const db = makeDb();

    const result = await save(admin, db, { title: 'Caja Kumiko', seoTitle: 'Caja Kumiko | Tienda' });

    // The digest-less field is a genuine local write, so this is not a failed
    // save — but the un-echoed one must still be named.
    // Nothing reached Shopify, so the save is a failure — a digest-less local
    // row is the one write that deliberately never goes there and cannot make
    // it partial. Both halves are named in the message.
    expect(result.success).toBe(false);
    expect(String((result as any).error)).toContain('did not confirm storing (title)');
    expect(String((result as any).error)).toContain('meta_title');
    // The no-digest rule still holds: that row is written even so.
    expect(mirrored(db)).toEqual({ meta_title: 'Caja Kumiko | Tienda' });
  });
});

/**
 * translateAllContent() — a locale whose writes SHOPIFY refused must reach
 * `failedLocales`.
 *
 * The save stage used to discard `savePerLocaleBatch`'s `failed` list, so a run
 * where the AI succeeded and every `translationsRegister` came back with
 * `userErrors` was returned with `failedLocales: []` — the call sites in
 * translation.action.ts read that as `status: "completed"` and the merchant was
 * told it had worked. These pin the three answers the fix has to give:
 * refused ⇒ failed, saved ⇒ not failed, and a DELIBERATE skip ⇒ not failed.
 *
 * The ECHO block below is the second half of the same rule (CLAUDE.md: "A save
 * is only successful if Shopify echoes back the keys — `userErrors` alone is
 * not enough"). All three save tiers now read `translationsRegister.
 * translations`; these pin what each of them does with a full, a partial, an
 * empty and an ABSENT echo, and that only echoed entries are mirrored to the
 * DB.
 */
describe('ShopifyContentService.translateAllContent() — failure reporting', () => {
  const productId = 'gid://shopify/Product/42';

  /**
   * One admin mock for both documents the run uses: the digest query and the
   * register mutation. `register` decides what Shopify answers to the write,
   * which is the whole variable under test — either one fixed response or a
   * function of the variables actually sent, so a test can answer a batch
   * differently from the single-entry retry that follows it.
   */
  function makeTranslateAdmin(register: any | ((variables: any) => any)) {
    const registerCalls: any[] = [];
    const graphql = vi.fn().mockImplementation(async (document: string, options?: any) => {
      const variables = options?.variables;
      if (document.includes('translationsRegister')) registerCalls.push(variables);
      return {
        ok: true,
        json: async () => {
          if (document.includes('translationsRegister')) {
            return typeof register === 'function' ? register(variables) : register;
          }
          return {
            data: {
              translatableResource: {
                translatableContent: [
                  { key: 'body_html', digest: 'digest-body', value: 'Vase aus Ton' },
                  { key: 'title', digest: 'digest-title', value: 'Vase' },
                  // Present so the handle tests below reach Shopify at all —
                  // `prepareField` refuses a key with no digest.
                  { key: 'handle', digest: 'digest-handle', value: 'vase' },
                ],
              },
            },
          };
        },
      };
    });
    return { graphql, registerCalls };
  }

  /** Shopify's honest answer: it echoes back exactly what it stored. */
  const echoEverything = (variables: any) => ({
    data: {
      translationsRegister: {
        userErrors: [],
        translations: (variables.translations ?? []).map((t: any) => ({
          locale: t.locale, key: t.key, value: t.value,
        })),
      },
    },
  });

  /** The same, filtered — what an accepted call that stored only SOME of it
   *  looks like on the wire. */
  const echoOnly = (predicate: (t: any) => boolean) => (variables: any) => ({
    data: {
      translationsRegister: {
        userErrors: [],
        translations: (variables.translations ?? []).filter(predicate).map((t: any) => ({
          locale: t.locale, key: t.key, value: t.value,
        })),
      },
    },
  });

  /** One `upsert` spy shared with the transaction callback, so a test can ask
   *  what was mirrored — the DB half of the echo rule. */
  function makeDb() {
    const upsert = vi.fn();
    return {
      $transaction: vi.fn(async (fn: any) => fn({ contentTranslation: { upsert } })),
      contentTranslation: { upsert },
    } as any;
  }

  /** The locales the DB mirror was actually written for. */
  const mirroredLocales = (db: any): string[] =>
    db.contentTranslation.upsert.mock.calls.map((c: any[]) => c[0].create.locale).sort();

  /** The AI half always succeeds here — only the SAVE half varies. */
  const translationService = {
    translateProduct: vi.fn(async (fields: Record<string, string>, locales: string[]) => {
      const out: Record<string, Record<string, string>> = {};
      for (const locale of locales) out[locale] = { description: `[${locale}] ${fields.description}` };
      return out;
    }),
  };

  const params = (admin: any, db: any) => ({
    resourceId: productId,
    resourceType: 'Product',
    shop,
    fields: { description: 'Vase aus Ton' },
    translationService: translationService as any,
    db,
    targetLocales: ['fr', 'de'],
    sourceLocale: 'en',
  });

  beforeEach(() => {
    translationService.translateProduct.mockClear();
  });

  it('reports every locale Shopify refused, and reports the refused field', async () => {
    const admin = makeTranslateAdmin({
      data: { translationsRegister: { userErrors: [{ field: ['translations', '0'], message: 'Digest is stale' }], translations: [] } },
    });
    const service = new ShopifyContentService(admin as any);

    const result = await service.translateAllContent(params(admin, makeDb()) as any);

    expect(result.failedLocales.sort()).toEqual(['de', 'fr']);
    expect(result.rejectedFields.fr).toEqual(['description']);
    expect(result.rejectedFields.de).toEqual(['description']);
    // Nothing was stored, so nothing may be reported as translated.
    expect(result.translations.fr).toEqual({});
  });

  it('reports nothing when Shopify echoes every write back', async () => {
    const admin = makeTranslateAdmin(echoEverything);
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();

    const result = await service.translateAllContent(params(admin, db) as any);

    expect(result.failedLocales).toEqual([]);
    expect(result.rejectedFields).toEqual({});
    expect(result.translations.fr.description).toBe('[fr] Vase aus Ton');
    expect(result.translations.de.description).toBe('[de] Vase aus Ton');
    // One mega-batch call for both locales — a full echo needs no fallback.
    expect(admin.registerCalls).toHaveLength(1);
    expect(mirroredLocales(db)).toEqual(['de', 'fr']);
  });

  it('does not call a locale failed whose only field was DELIBERATELY skipped', async () => {
    // A handle equal to the primary one is skipped by design (a routing
    // conflict avoided, not a loss), so the locale saved nothing and failed at
    // nothing. Registering never happens — the run has nothing to send.
    const admin = makeTranslateAdmin({ data: { translationsRegister: { userErrors: [], translations: [] } } });
    const service = new ShopifyContentService(admin as any);
    const shortFieldService = {
      translateShortFieldsBatch: vi.fn(async (fields: Record<string, string>, _src: string, locales: string[]) => {
        const out: Record<string, Record<string, string>> = {};
        for (const locale of locales) out[locale] = { handle: fields.handle };
        return out;
      }),
      translateProduct: vi.fn(),
    };

    const result = await service.translateAllContent({
      ...params(admin, makeDb()),
      fields: { handle: 'kumiko-box' },
      translationService: shortFieldService as any,
    } as any);

    expect(result.failedLocales).toEqual([]);
    expect(result.skippedFields.fr).toEqual(['handle']);
  });

  // === The echo rule ===

  it('treats an accepted write Shopify did not echo back as NOT saved, and mirrors nothing', async () => {
    // The historic silent no-op: no userErrors, no errors — and an empty echo,
    // which is an ANSWER ("nothing was stored"), not a missing one.
    const admin = makeTranslateAdmin({ data: { translationsRegister: { userErrors: [], translations: [] } } });
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();

    const result = await service.translateAllContent(params(admin, db) as any);

    expect(result.failedLocales.sort()).toEqual(['de', 'fr']);
    expect(result.rejectedFields.fr).toEqual(['description']);
    expect(result.rejectedFields.de).toEqual(['description']);
    expect(result.translations.fr).toEqual({});
    expect(result.translations.de).toEqual({});
    // Nothing was stored on Shopify, so nothing may be stored here either.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(mirroredLocales(db)).toEqual([]);
  });

  it('splits a partially echoed batch — the echoed locale is saved, the other one fails', async () => {
    // fr comes back, de does not. Mega-batch ⇒ per-locale ⇒ individual, and
    // every tier keeps giving the same answer for de.
    const admin = makeTranslateAdmin(echoOnly((t: any) => t.locale === 'fr'));
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();

    const result = await service.translateAllContent(params(admin, db) as any);

    expect(result.failedLocales).toEqual(['de']);
    expect(result.rejectedFields.de).toEqual(['description']);
    expect(result.rejectedFields.fr).toBeUndefined();
    expect(result.translations.fr.description).toBe('[fr] Vase aus Ton');
    expect(result.translations.de).toEqual({});
    expect(mirroredLocales(db)).toEqual(['fr']);
  });

  it('reports a field the batch dropped but the individual retry got through as SAVED', async () => {
    // Trap 3: an entry refused by the per-locale batch and then stored by the
    // one-by-one retry must appear in `saved` only — never in both lists. The
    // mega-batch's own un-echoed entries must likewise leave no trace, since
    // the re-send goes on to save them.
    const admin = makeTranslateAdmin((variables: any) =>
      // A batch stores the title only; a single-entry call stores what it got.
      (variables.translations.length > 1
        ? echoOnly((t: any) => t.key === 'title')
        : echoEverything)(variables),
    );
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();
    const bothFieldsService = {
      translateShortFieldsBatch: vi.fn(async (fields: Record<string, string>, _src: string, locales: string[]) => {
        const out: Record<string, Record<string, string>> = {};
        for (const locale of locales) out[locale] = { title: `[${locale}] ${fields.title}` };
        return out;
      }),
      translateProduct: vi.fn(async (fields: Record<string, string>, locales: string[]) => {
        const out: Record<string, Record<string, string>> = {};
        for (const locale of locales) out[locale] = { description: `[${locale}] ${fields.description}` };
        return out;
      }),
    };

    const result = await service.translateAllContent({
      ...params(admin, db),
      fields: { title: 'Vase', description: 'Vase aus Ton' },
      translationService: bothFieldsService as any,
      targetLocales: ['fr'],
    } as any);

    expect(result.failedLocales).toEqual([]);
    expect(result.rejectedFields).toEqual({});
    expect(result.translations.fr.title).toBe('[fr] Vase');
    expect(result.translations.fr.description).toBe('[fr] Vase aus Ton');
    expect(mirroredLocales(db)).toEqual(['fr', 'fr']);
  });

  it('re-asks one entry at a time when a batch answers with NO echo, and believes the answer it then gets', async () => {
    // Trap 1: an absent echo is "we do not know", not "nothing was stored" —
    // a throttled or truncated body looks exactly like this. The batch tiers
    // treat it as a reason to ask again, never as a refusal.
    const admin = makeTranslateAdmin((variables: any) =>
      variables.translations.length > 1
        ? { data: { translationsRegister: { userErrors: [] } } } // no `translations` at all
        : echoEverything(variables),
    );
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();

    const result = await service.translateAllContent(params(admin, db) as any);

    expect(result.failedLocales).toEqual([]);
    expect(result.rejectedFields).toEqual({});
    expect(result.translations.fr.description).toBe('[fr] Vase aus Ton');
    expect(mirroredLocales(db)).toEqual(['de', 'fr']);
  });

  it('counts an entry as NOT saved when even the individual write answers with no echo', async () => {
    // Trap 1, bottom tier: there is no narrower re-send left, so "we do not
    // know" is recorded as not saved. A false alarm costs a re-run of an
    // idempotent write; the other direction is a DB row for a translation the
    // storefront never got.
    const admin = makeTranslateAdmin({ data: { translationsRegister: { userErrors: [] } } });
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();

    const result = await service.translateAllContent(params(admin, db) as any);

    expect(result.failedLocales.sort()).toEqual(['de', 'fr']);
    expect(result.rejectedFields.fr).toEqual(['description']);
    expect(result.rejectedFields.de).toEqual(['description']);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('accepts an echo whose regional code differs only in CASE', async () => {
    // Shopify is inconsistent about the case of a regional code and the target
    // locales come from client form data, so `pt-br` written and `pt-BR`
    // echoed is the same translation — reading it as a miss would report a
    // locale as refused while the storefront serves it.
    const admin = makeTranslateAdmin((variables: any) => ({
      data: {
        translationsRegister: {
          userErrors: [],
          translations: variables.translations.map((t: any) => ({
            locale: t.locale.toUpperCase(), key: t.key, value: t.value,
          })),
        },
      },
    }));
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();

    const result = await service.translateAllContent({
      ...params(admin, db),
      targetLocales: ['pt-br'],
    } as any);

    expect(result.failedLocales).toEqual([]);
    expect(result.rejectedFields).toEqual({});
    expect(result.translations['pt-br'].description).toBe('[pt-br] Vase aus Ton');
    expect(mirroredLocales(db)).toEqual(['pt-br']);
  });

  it('does not trust a `data: null` response that carries no userErrors', async () => {
    // The throttled shape the video-schema writer already refuses to read as a
    // success: no data, no userErrors, nothing echoed.
    const admin = makeTranslateAdmin({ data: null });
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();

    const result = await service.translateAllContent(params(admin, db) as any);

    expect(result.failedLocales.sort()).toEqual(['de', 'fr']);
    expect(mirroredLocales(db)).toEqual([]);
  });

  // === The echoed VALUE ===
  //
  // The echo says WHAT Shopify stored, and the mirror has to hold that rather
  // than what was sent. `handle` is where it bites: nothing on this path
  // slug-sanitises one (the AI writes it and `prepareField` only refuses one
  // identical to the primary handle), and `ContentTranslation` is the table
  // `resolvePathsToResources` resolves foreign-locale URLs through and the one
  // a translated-handle redirect is built from.

  /** An AI that writes a handle, so the normalisation has something to bite on. */
  const handleService = {
    translateShortFieldsBatch: vi.fn(async (_f: Record<string, string>, _src: string, locales: string[]) => {
      const out: Record<string, Record<string, string>> = {};
      for (const locale of locales) out[locale] = { handle: 'Caja Kumiko!' };
      return out;
    }),
    translateProduct: vi.fn(),
  };

  /** key → value of every mirror row written. */
  const mirroredValues = (db: any): Record<string, string> =>
    Object.fromEntries(
      db.contentTranslation.upsert.mock.calls.map((c: any[]) => [c[0].create.key, c[0].create.value]),
    );

  it('mirrors and returns the handle Shopify STORED, not the one that was sent', async () => {
    const admin = makeTranslateAdmin((variables: any) => ({
      data: {
        translationsRegister: {
          userErrors: [],
          translations: (variables.translations ?? []).map((t: any) => ({
            locale: t.locale,
            key: t.key,
            // What Shopify does to a slug it was handed raw.
            value: t.key === 'handle' ? 'caja-kumiko' : t.value,
          })),
        },
      },
    }));
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();

    const result = await service.translateAllContent({
      ...params(admin, db),
      fields: { handle: 'kumiko-box' },
      translationService: handleService as any,
      targetLocales: ['fr'],
    } as any);

    expect(result.failedLocales).toEqual([]);
    // What the merchant now sees in the field after a translate-all: Shopify's
    // spelling, which is the one the storefront serves.
    expect(result.translations.fr.handle).toBe('caja-kumiko');
    expect(mirroredValues(db)).toEqual({ handle: 'caja-kumiko' });
    // Nothing about what goes ON THE WIRE changed.
    expect(admin.registerCalls[0].translations[0].value).toBe('Caja Kumiko!');
  });

  it('carries the stored value through the per-locale tier as well', async () => {
    // The first call (the mega-batch) answers without an echo, so the re-send
    // is what confirms — and the value has to survive that hop too.
    let calls = 0;
    const admin = makeTranslateAdmin((variables: any) => {
      calls += 1;
      if (calls === 1) return { data: { translationsRegister: { userErrors: [] } } };
      return {
        data: {
          translationsRegister: {
            userErrors: [],
            translations: (variables.translations ?? []).map((t: any) => ({
              locale: t.locale, key: t.key, value: t.key === 'handle' ? 'caja-kumiko' : t.value,
            })),
          },
        },
      };
    });
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();

    const result = await service.translateAllContent({
      ...params(admin, db),
      fields: { handle: 'kumiko-box' },
      translationService: handleService as any,
      targetLocales: ['fr'],
    } as any);

    expect(calls).toBeGreaterThan(1);
    expect(result.failedLocales).toEqual([]);
    expect(result.translations.fr.handle).toBe('caja-kumiko');
    expect(mirroredValues(db)).toEqual({ handle: 'caja-kumiko' });
  });

  it('keeps the SENT value when the echo names the key but carries no value', async () => {
    // A present key with `value: null` is a confirmed write and no answer at
    // all about its content — reading it as an empty value would mirror `""`
    // over a translation that is live.
    const admin = makeTranslateAdmin((variables: any) => ({
      data: {
        translationsRegister: {
          userErrors: [],
          translations: (variables.translations ?? []).map((t: any) => ({
            locale: t.locale, key: t.key, value: null,
          })),
        },
      },
    }));
    const service = new ShopifyContentService(admin as any);
    const db = makeDb();

    const result = await service.translateAllContent({
      ...params(admin, db),
      targetLocales: ['fr'],
    } as any);

    expect(result.failedLocales).toEqual([]);
    expect(result.translations.fr.description).toBe('[fr] Vase aus Ton');
    expect(mirroredValues(db)).toEqual({ body_html: '[fr] Vase aus Ton' });
  });
});
