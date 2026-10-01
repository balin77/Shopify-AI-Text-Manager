/**
 * CHARACTERISATION (docs/plans/PLAN_TRANSLATION_WRITE_UNIFICATION.md, Phase B+C).
 *
 * Pins what `saveTranslations`, `deleteAllTranslationsForKeys` and their three
 * single-editor callers (updateContent's cleared-field branch, updateContent's
 * primary-change purge, saveImageAltTextTranslation) do, driven through a
 * mocked `admin.graphql` and a mocked db. Written BEFORE the verified rewrite so
 * the only diffs in the follow-up commit are the intended ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShopifyContentService } from '../../src/services/shopify-content.service';

vi.mock('~/utils/logger.server', () => ({
  loggers: { translation: vi.fn(), seo: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('~/utils/translation-save-lock.server', () => ({
  markTranslationSaved: vi.fn(),
  isTranslationRecentlySaved: vi.fn().mockReturnValue(false),
}));

const { policy } = vi.hoisted(() => ({
  policy: {
    purgeOnPrimaryChange: true,
    purgeUnreconciledSurfaces: true,
    autoTranslateExternalChanges: false,
    plan: 'max',
  },
}));

vi.mock('../../app/services/translations/translation-change-policy.server', () => ({
  loadTranslationChangePolicy: vi.fn(async () => policy),
  isPurgeOnPrimaryChangeEnabled: vi.fn(async () => policy.purgeUnreconciledSurfaces),
}));

vi.mock('../../app/services/shopify-api-gateway.service', () => ({
  ShopifyApiGateway: class {
    constructor(public admin: unknown, public shop: string) {}
  },
}));

// The market-override purge is its own, already-verified module: out of scope.
vi.mock('../../app/services/translations/market-layer-purge.server', () => ({
  purgeMarketOverrides: vi.fn(async () => undefined),
}));

vi.mock('../../app/services/translations/stale-translation-sync.server', () => ({
  IN_APP_RETRANSLATED_RESOURCE_TYPES: new Set(['Page', 'Article', 'Blog', 'ShopPolicy', 'Product', 'Collection']),
  contentTranslationMirror: vi.fn(() => ({})),
  featuredImageAltMirror: vi.fn(() => ({})),
  reconcileAfterPrimarySave: vi.fn(async () => ({ removed: 0, retranslating: 0 })),
}));

const shop = 'test.myshopify.com';
const rid = 'gid://shopify/Metafield/5';

/** Routes the documents these methods send. */
function routedAdmin(opts: {
  digests?: Array<{ key: string; digest: string | null }>;
  register?: any;
  remove?: any;
  /** What the single-locale removal re-read answers (key → value, global layer). */
  readBack?: Array<{ key: string; value: string | null }>;
}) {
  const calls: Array<{ kind: 'digest' | 'register' | 'remove' | 'reread'; variables: any }> = [];
  const graphql = vi.fn(async (query: string, options?: any) => {
    const variables = options?.variables;
    return {
      ok: true,
      json: async () => {
        if (query.includes('translationsRegister')) {
          calls.push({ kind: 'register', variables });
          return opts.register ?? { data: { translationsRegister: { userErrors: [], translations: [] } } };
        }
        if (query.includes('translationsRemove')) {
          calls.push({ kind: 'remove', variables });
          return opts.remove ?? { data: { translationsRemove: { userErrors: [], translations: [] } } };
        }
        if (query.includes('verifyTranslationRemoval')) {
          calls.push({ kind: 'reread', variables });
          return {
            data: {
              translatableResource: {
                translations: (opts.readBack ?? []).map((r) => ({ ...r, market: null })),
              },
            },
          };
        }
        calls.push({ kind: 'digest', variables });
        return {
          data: {
            translatableResource: {
              translatableContent: (opts.digests ?? [{ key: 'value', digest: 'dg-value' }]).map((d) => ({
                ...d,
                value: 'src',
                locale: 'de',
              })),
            },
          },
        };
      },
    };
  });
  return { graphql, calls };
}

describe('saveTranslations', () => {
  it('sends the digest (and the market when one is given)', async () => {
    const admin = routedAdmin({
      register: {
        data: { translationsRegister: { userErrors: [], translations: [{ key: 'value', locale: 'fr', value: 'Rouge' }] } },
      },
    });
    await new ShopifyContentService(admin as never).saveTranslations(
      rid,
      [{ key: 'value', value: 'Rouge', locale: 'fr' }],
      'gid://shopify/Market/9',
    );

    const register = admin.calls.find((c) => c.kind === 'register')!;
    expect(register.variables.translations).toEqual([
      {
        key: 'value',
        value: 'Rouge',
        locale: 'fr',
        translatableContentDigest: 'dg-value',
        marketId: 'gid://shopify/Market/9',
      },
    ]);
  });

  it('sends nothing at all when no key has a digest', async () => {
    const admin = routedAdmin({ digests: [{ key: 'value', digest: null }] });
    await new ShopifyContentService(admin as never).saveTranslations(rid, [
      { key: 'value', value: 'Rouge', locale: 'fr' },
    ]);
    expect(admin.calls.some((c) => c.kind === 'register')).toBe(false);
  });

  it('THROWS on a top-level GraphQL error', async () => {
    const admin = routedAdmin({ register: { errors: [{ message: 'Throttled' }] } });
    await expect(
      new ShopifyContentService(admin as never).saveTranslations(rid, [{ key: 'value', value: 'x', locale: 'fr' }]),
    ).rejects.toThrow('Throttled');
  });

  it('(current contract) THROWS on userErrors', async () => {
    const admin = routedAdmin({
      register: { data: { translationsRegister: { userErrors: [{ message: 'Value cannot be blank' }], translations: [] } } },
    });
    await expect(
      new ShopifyContentService(admin as never).saveTranslations(rid, [{ key: 'value', value: 'x', locale: 'fr' }]),
    ).rejects.toThrow('Value cannot be blank');
  });

  it('(current contract) returns the echoed translations array, empty when nothing was echoed', async () => {
    const echoed = routedAdmin({
      register: {
        data: { translationsRegister: { userErrors: [], translations: [{ key: 'value', locale: 'fr', value: 'Rouge' }] } },
      },
    });
    expect(
      await new ShopifyContentService(echoed as never).saveTranslations(rid, [{ key: 'value', value: 'Rouge', locale: 'fr' }]),
    ).toEqual([{ key: 'value', locale: 'fr', value: 'Rouge' }]);

    const silent = routedAdmin({});
    expect(
      await new ShopifyContentService(silent as never).saveTranslations(rid, [{ key: 'value', value: 'x', locale: 'fr' }]),
    ).toEqual([]);
  });
});

describe('deleteAllTranslationsForKeys', () => {
  it('does nothing for an empty key or locale list', async () => {
    const admin = routedAdmin({});
    const service = new ShopifyContentService(admin as never);
    await service.deleteAllTranslationsForKeys({ resourceId: rid, translationKeys: [], foreignLocales: ['fr'] });
    await service.deleteAllTranslationsForKeys({ resourceId: rid, translationKeys: ['value'], foreignLocales: [] });
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it('sends marketIds null for the global layer and [market] for an override', async () => {
    const admin = routedAdmin({
      remove: { data: { translationsRemove: { userErrors: [], translations: [{ key: 'value', locale: 'fr' }, { key: 'value', locale: 'it' }] } } },
    });
    const service = new ShopifyContentService(admin as never);
    await service.deleteAllTranslationsForKeys({ resourceId: rid, translationKeys: ['value'], foreignLocales: ['fr', 'it'] });
    await service.deleteAllTranslationsForKeys({
      resourceId: rid, translationKeys: ['value'], foreignLocales: ['fr'], marketId: 'gid://shopify/Market/9',
    });
    const [globalCall, marketCall] = admin.calls.filter((c) => c.kind === 'remove');
    expect(globalCall.variables).toMatchObject({ locales: ['fr', 'it'], marketIds: null });
    expect(marketCall.variables).toMatchObject({ locales: ['fr'], marketIds: ['gid://shopify/Market/9'] });
  });

  it('(current contract) THROWS on userErrors', async () => {
    const admin = routedAdmin({
      remove: { data: { translationsRemove: { userErrors: [{ message: 'nope' }], translations: [] } } },
    });
    await expect(
      new ShopifyContentService(admin as never).deleteAllTranslationsForKeys({
        resourceId: rid, translationKeys: ['value'], foreignLocales: ['fr'],
      }),
    ).rejects.toThrow('nope');
  });

  it('(current contract) reports success when Shopify echoes NOTHING back', async () => {
    const admin = routedAdmin({});
    const result = await new ShopifyContentService(admin as never).deleteAllTranslationsForKeys({
      resourceId: rid, translationKeys: ['value'], foreignLocales: ['fr'],
    });
    expect(result).toMatchObject({ success: true });
  });
});

describe('updateContent — foreign locale, a CLEARED field', () => {
  const pageId = 'gid://shopify/Page/41';
  function makeDb() {
    const upsert = vi.fn();
    const deleteMany = vi.fn();
    return {
      $transaction: vi.fn(async (fn: any) => fn({ contentTranslation: { upsert, deleteMany } })),
      contentTranslation: { upsert, deleteMany },
    } as any;
  }
  const clear = (admin: any, db: any, over: Record<string, unknown> = {}) =>
    new ShopifyContentService(admin as never).updateContent({
      resourceId: pageId, resourceType: 'Page', locale: 'es', primaryLocale: 'de',
      updates: { title: '' }, db, shop, ...over,
    } as any);

  it('removes the key for that one locale and deletes the local row when Shopify echoes it', async () => {
    const admin = routedAdmin({
      digests: [{ key: 'title', digest: 'dg-title' }],
      remove: { data: { translationsRemove: { userErrors: [], translations: [{ key: 'title', locale: 'es' }] } } },
    });
    const db = makeDb();
    const result = await clear(admin, db);

    const removal = admin.calls.find((c) => c.kind === 'remove')!;
    expect(removal.variables).toMatchObject({ translationKeys: ['title'], locales: ['es'], marketIds: null });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledWith({
      where: { shop, resourceId: pageId, resourceType: 'Page', locale: 'es', marketId: '', key: { in: ['title'] } },
    });
    expect(result).toEqual({ success: true });
  });

  it('scopes the removal AND the local delete to the selected market', async () => {
    const admin = routedAdmin({
      digests: [{ key: 'title', digest: 'dg-title' }],
      remove: { data: { translationsRemove: { userErrors: [], translations: [{ key: 'title', locale: 'es' }] } } },
    });
    const db = makeDb();
    await clear(admin, db, { marketId: 'gid://shopify/Market/9' });

    expect(admin.calls.find((c) => c.kind === 'remove')!.variables.marketIds).toEqual(['gid://shopify/Market/9']);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where.marketId).toBe('gid://shopify/Market/9');
  });

  it('(current) deletes the local row even when Shopify echoed NOTHING', async () => {
    const admin = routedAdmin({ digests: [{ key: 'title', digest: 'dg-title' }] });
    const db = makeDb();
    expect(await clear(admin, db)).toEqual({ success: true });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('(current) rejects on userErrors and touches no local row', async () => {
    const admin = routedAdmin({
      digests: [{ key: 'title', digest: 'dg-title' }],
      remove: { data: { translationsRemove: { userErrors: [{ message: 'refused' }], translations: [] } } },
    });
    const db = makeDb();
    await expect(clear(admin, db)).rejects.toThrow('refused');
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });
});

describe('updateContent — primary-change purge (Page, merchant purge switch on)', () => {
  const pageId = 'gid://shopify/Page/42';
  beforeEach(() => {
    policy.purgeOnPrimaryChange = true;
    policy.purgeUnreconciledSurfaces = true;
    policy.autoTranslateExternalChanges = false;
  });

  function makePurgeAdmin(remove?: any) {
    const removals: any[] = [];
    const graphql = vi.fn(async (query: string, options?: any) => ({
      ok: true,
      json: async () => {
        if (query.includes('getShopLocales')) {
          return {
            data: {
              shopLocales: [
                { locale: 'de', primary: true, published: true },
                { locale: 'fr', primary: false, published: true },
                { locale: 'it', primary: false, published: true },
              ],
            },
          };
        }
        if (query.includes('translationsRemove')) {
          removals.push(options?.variables);
          return remove ?? { data: { translationsRemove: { userErrors: [], translations: [] } } };
        }
        return { data: { pageUpdate: { page: { id: pageId, title: 'T' }, userErrors: [] } } };
      },
    }));
    return { graphql, removals };
  }
  const makeDb = (localRows: Array<{ locale: string; key: string }> = []) =>
    ({
      page: { update: vi.fn().mockResolvedValue({}) },
      contentTranslation: {
        findMany: vi.fn().mockResolvedValue(localRows),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    }) as any;
  const savePage = (admin: any, db: any) =>
    new ShopifyContentService(admin as never).updateContent({
      resourceId: pageId, resourceType: 'Page', locale: 'de', primaryLocale: 'de',
      updates: { title: 'Neu' }, changedFields: ['title'], db, shop,
    } as any);

  it('removes the changed keys in every foreign locale in ONE call and deletes the global local rows', async () => {
    const admin = makePurgeAdmin({
      data: { translationsRemove: { userErrors: [], translations: [{ key: 'title', locale: 'fr' }, { key: 'title', locale: 'it' }] } },
    });
    const db = makeDb();
    await savePage(admin, db);

    expect(admin.removals).toHaveLength(1);
    expect(admin.removals[0]).toMatchObject({ resourceId: pageId, translationKeys: ['title'], locales: ['fr', 'it'], marketIds: null });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledWith({
      where: {
        shop, resourceId: pageId, resourceType: 'Page', marketId: '',
        key: { in: ['title'] }, locale: { in: ['fr', 'it'] },
      },
    });
  });

  it('(current) deletes the local rows even when Shopify echoed NOTHING', async () => {
    const admin = makePurgeAdmin();
    const db = makeDb();
    await savePage(admin, db);
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('(current) rejects on userErrors before any local delete', async () => {
    const admin = makePurgeAdmin({ data: { translationsRemove: { userErrors: [{ message: 'refused' }], translations: [] } } });
    const db = makeDb();
    await expect(savePage(admin, db)).rejects.toThrow('refused');
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });
});

describe('saveImageAltTextTranslation', () => {
  const collectionId = 'gid://shopify/Collection/51';
  const imageId = 'gid://shopify/CollectionImage/52';

  function makeAltAdmin(opts: { altDigest?: string | null; register?: any; remove?: any; readBack?: any[] }) {
    const calls: Array<{ kind: string; variables: any }> = [];
    const graphql = vi.fn(async (query: string, options?: any) => ({
      ok: true,
      json: async () => {
        const variables = options?.variables;
        if (query.includes('getFeaturedImageId')) return { data: { collection: { image: { id: imageId } } } };
        if (query.includes('translationsRegister')) {
          calls.push({ kind: 'register', variables });
          return opts.register ?? { data: { translationsRegister: { userErrors: [], translations: [] } } };
        }
        if (query.includes('translationsRemove')) {
          calls.push({ kind: 'remove', variables });
          return opts.remove ?? { data: { translationsRemove: { userErrors: [], translations: [] } } };
        }
        if (query.includes('verifyTranslationRemoval')) {
          calls.push({ kind: 'reread', variables });
          return { data: { translatableResource: { translations: opts.readBack ?? [] } } };
        }
        return {
          data: {
            translatableResource: {
              translatableContent:
                opts.altDigest === null ? [] : [{ key: 'alt', value: 'Alt', digest: opts.altDigest ?? 'dg-alt', locale: 'de' }],
            },
          },
        };
      },
    }));
    return { graphql, calls };
  }
  const makeDb = () =>
    ({
      contentTranslation: { upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }) as any;
  const run = (admin: any, db: any, altText: string) =>
    new ShopifyContentService(admin as never).saveImageAltTextTranslation({
      resourceId: collectionId, resourceType: 'Collection', locale: 'fr', altText, shop, db,
    });
  const echoRemoved = { data: { translationsRemove: { userErrors: [], translations: [{ key: 'alt', locale: 'fr' }] } } };

  it('clear: removes the alt on the IMAGE resource and deletes the parent row when Shopify echoes it', async () => {
    const admin = makeAltAdmin({ remove: echoRemoved });
    const db = makeDb();
    const result = await run(admin, db, '  ');

    expect(admin.calls.find((c) => c.kind === 'remove')!.variables).toMatchObject({
      resourceId: imageId, translationKeys: ['alt'], locales: ['fr'],
    });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledWith({
      where: { shop, resourceId: collectionId, resourceType: 'Collection', key: 'image_alt_text', locale: 'fr', marketId: '' },
    });
    expect(result).toEqual({ saved: true });
  });

  it('clear: with no alt digest nothing is sent to Shopify, the row is still deleted', async () => {
    const admin = makeAltAdmin({ altDigest: null });
    const db = makeDb();
    const result = await run(admin, db, '');
    expect(admin.calls.some((c) => c.kind === 'remove')).toBe(false);
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ saved: true });
  });

  it('(current) clear: deletes the row even when Shopify echoed nothing', async () => {
    const admin = makeAltAdmin({});
    const db = makeDb();
    expect(await run(admin, db, '')).toEqual({ saved: true });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('clear: a Shopify error is reported as a failure and keeps the row', async () => {
    const admin = makeAltAdmin({ remove: { data: { translationsRemove: { userErrors: [{ message: 'refused' }], translations: [] } } } });
    const db = makeDb();
    const result = await run(admin, db, '');
    expect(result).toEqual({ saved: false, reason: 'error' });
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('register: userErrors fail the save and write nothing locally', async () => {
    const admin = makeAltAdmin({ register: { data: { translationsRegister: { userErrors: [{ message: 'no' }], translations: [] } } } });
    const db = makeDb();
    expect(await run(admin, db, 'Rot')).toEqual({ saved: false, reason: 'shopify-error' });
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it('register: with no alt digest nothing is sent and nothing is written (no local write without a digest)', async () => {
    const admin = makeAltAdmin({ altDigest: null });
    const db = makeDb();
    expect(await run(admin, db, 'Rot')).toEqual({ saved: false, reason: 'no-digest' });
    expect(admin.calls.some((c) => c.kind === 'register')).toBe(false);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it('register: an echoed write is mirrored with its digest', async () => {
    const admin = makeAltAdmin({
      register: { data: { translationsRegister: { userErrors: [], translations: [{ key: 'alt', locale: 'fr', value: 'Rot' }] } } },
    });
    const db = makeDb();
    expect(await run(admin, db, 'Rot')).toEqual({ saved: true });
    expect(db.contentTranslation.upsert.mock.calls[0][0].create).toMatchObject({
      key: 'image_alt_text', value: 'Rot', digest: 'dg-alt', locale: 'fr',
    });
  });

  it('(current) register: a write Shopify accepted but did NOT echo is still reported saved and mirrored', async () => {
    const admin = makeAltAdmin({});
    const db = makeDb();
    expect(await run(admin, db, 'Rot')).toEqual({ saved: true });
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
  });
});
