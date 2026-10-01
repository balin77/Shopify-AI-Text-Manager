/**
 * Phase B+C (docs/plans/PLAN_TRANSLATION_WRITE_UNIFICATION.md) -- started as a
 * characterisation of the pre-rewrite behaviour; the cases that described the
 * unverified gaps now pin the verified behaviour. Pins what `saveTranslations`, `deleteAllTranslationsForKeys` and their three
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

  it('does NOT throw on userErrors: they come back, and the key is unconfirmed', async () => {
    const admin = routedAdmin({
      register: { data: { translationsRegister: { userErrors: [{ message: 'Value cannot be blank' }], translations: [] } } },
    });
    const result = await new ShopifyContentService(admin as never).saveTranslations(rid, [{ key: 'value', value: 'x', locale: 'fr' }]);
    expect(result.userErrors).toEqual([{ message: 'Value cannot be blank' }]);
    expect(result.unconfirmedKeys).toEqual(['value']);
    expect([...result.confirmedKeys]).toEqual([]);
  });

  it('returns the VERIFIED result: confirmed keys, the stored value and the digest used', async () => {
    const echoed = routedAdmin({
      register: {
        data: { translationsRegister: { userErrors: [], translations: [{ key: 'value', locale: 'fr', value: 'Rouge!' }] } },
      },
    });
    const result = await new ShopifyContentService(echoed as never).saveTranslations(rid, [{ key: 'value', value: 'Rouge', locale: 'fr' }]);
    expect([...result.confirmedKeys]).toEqual(['value']);
    expect(result.confirmedValues.get('value')).toBe('Rouge!');
    expect(result.digests.get('value')).toBe('dg-value');
    expect(result.unconfirmedKeys).toEqual([]);
    expect(result.noDigest).toEqual([]);
  });

  it('an accepted write Shopify did not echo is unconfirmed, not saved', async () => {
    const silent = routedAdmin({});
    const result = await new ShopifyContentService(silent as never).saveTranslations(rid, [{ key: 'value', value: 'x', locale: 'fr' }]);
    expect(result.unconfirmedKeys).toEqual(['value']);
    expect([...result.confirmedKeys]).toEqual([]);
  });

  it('reports a key with no digest in noDigest (never sent)', async () => {
    const admin = routedAdmin({ digests: [{ key: 'value', digest: null }] });
    const result = await new ShopifyContentService(admin as never).saveTranslations(rid, [{ key: 'value', value: 'x', locale: 'fr' }]);
    expect(result.noDigest).toEqual(['value']);
    expect(admin.calls.some((c) => c.kind === 'register')).toBe(false);
  });

  it('refuses a call that mixes locales (the result is keyed by key)', async () => {
    const admin = routedAdmin({});
    await expect(
      new ShopifyContentService(admin as never).saveTranslations(rid, [
        { key: 'value', value: 'x', locale: 'fr' },
        { key: 'value', value: 'y', locale: 'it' },
      ]),
    ).rejects.toThrow('ONE locale');
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

  it('does NOT throw on userErrors: unconfirmed unless the re-read finds the key gone', async () => {
    const refused = routedAdmin({
      remove: { data: { translationsRemove: { userErrors: [{ message: 'nope' }], translations: [] } } },
      readBack: [{ key: 'value', value: 'Rouge' }],
    });
    const stuck = await new ShopifyContentService(refused as never).deleteAllTranslationsForKeys({
      resourceId: rid, translationKeys: ['value'], foreignLocales: ['fr'],
    });
    expect(stuck.success).toBe(false);
    expect(stuck.userErrors).toEqual([{ message: 'nope' }]);
    expect(stuck.unconfirmedPairs).toEqual(['fr\u0000value']);
  });

  it('an unechoed removal is CONFIRMED by the re-read when the key carries nothing (a DB-only row)', async () => {
    const admin = routedAdmin({ readBack: [] });
    const result = await new ShopifyContentService(admin as never).deleteAllTranslationsForKeys({
      resourceId: rid, translationKeys: ['value'], foreignLocales: ['fr'],
    });
    expect(result.success).toBe(true);
    expect([...result.confirmedPairs]).toEqual(['fr\u0000value']);
    expect(admin.calls.filter((c) => c.kind === 'reread')).toHaveLength(1);
  });

  it('an unechoed removal of a key Shopify STILL holds stays unconfirmed', async () => {
    const admin = routedAdmin({ readBack: [{ key: 'value', value: 'Rouge' }] });
    const result = await new ShopifyContentService(admin as never).deleteAllTranslationsForKeys({
      resourceId: rid, translationKeys: ['value'], foreignLocales: ['fr'],
    });
    expect(result.success).toBe(false);
    expect([...result.confirmedPairs]).toEqual([]);
  });

  it('several locales: ONE sweep, then the re-read only for the gap locale that has a local row', async () => {
    const admin = routedAdmin({
      remove: { data: { translationsRemove: { userErrors: [], translations: [{ key: 'value', locale: 'fr' }] } } },
      readBack: [],
    });
    const result = await new ShopifyContentService(admin as never).deleteAllTranslationsForKeys({
      resourceId: rid,
      translationKeys: ['value'],
      foreignLocales: ['fr', 'it', 'es'],
      localPairs: new Set(['it\u0000value']),
    });
    // fr echoed; it has a gap AND a row -> re-read (absent -> confirmed); es has a gap but no row -> left alone.
    const rereads = admin.calls.filter((c) => c.kind === 'reread');
    expect(rereads).toHaveLength(1);
    expect(rereads[0].variables.locale).toBe('it');
    expect([...result.confirmedPairs].sort()).toEqual(['fr\u0000value', 'it\u0000value']);
    expect(result.unconfirmedPairs).toEqual([]);
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

  it('a DB-only row (Shopify never held the key) IS cleared: the re-read confirms it gone', async () => {
    const admin = routedAdmin({ digests: [{ key: 'title', digest: 'dg-title' }], readBack: [] });
    const db = makeDb();
    expect(await clear(admin, db)).toEqual({ success: true });
    expect(admin.calls.filter((c) => c.kind === 'reread')).toHaveLength(1);
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('an unconfirmed removal KEEPS the local row and says so', async () => {
    const admin = routedAdmin({
      digests: [{ key: 'title', digest: 'dg-title' }],
      readBack: [{ key: 'title', value: 'Titulo' }],
    });
    const db = makeDb();
    const result: any = await clear(admin, db);
    expect(result.success).toBe(false);
    expect(result.error).toContain('title');
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('a removal Shopify rejected (userErrors) keeps the row, names the reason, and does not throw', async () => {
    const admin = routedAdmin({
      digests: [{ key: 'title', digest: 'dg-title' }],
      remove: { data: { translationsRemove: { userErrors: [{ message: 'refused' }], translations: [] } } },
      readBack: [{ key: 'title', value: 'Titulo' }],
    });
    const db = makeDb();
    const result: any = await clear(admin, db);
    expect(result.success).toBe(false);
    expect(result.error).toContain('refused');
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('a clear that is confirmed alongside an unconfirmed one is a warning, and only the confirmed row goes', async () => {
    const admin = routedAdmin({
      digests: [{ key: 'title', digest: 'dg-title' }, { key: 'body_html', digest: 'dg-body' }],
      remove: { data: { translationsRemove: { userErrors: [], translations: [{ key: 'title', locale: 'es' }] } } },
      readBack: [{ key: 'body_html', value: '<p>x</p>' }],
    });
    const db = makeDb();
    const result: any = await clear(admin, db, { updates: { title: '', body: '' } });
    expect(result.success).toBe(true);
    expect(result.warning).toContain('body_html');
    // The FIELD key (not the Shopify key) whose clear was not confirmed, so the
    // page keeps that field dirty instead of caching it as saved-empty.
    expect(result.unconfirmedClearedFields).toEqual(['body']);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where.key).toEqual({ in: ['title'] });
  });
});

describe('updateContent — primary-change purge (Page, merchant purge switch on)', () => {
  const pageId = 'gid://shopify/Page/42';
  beforeEach(() => {
    policy.purgeOnPrimaryChange = true;
    policy.purgeUnreconciledSurfaces = true;
    policy.autoTranslateExternalChanges = false;
  });

  function makePurgeAdmin(remove?: any, readBack: Array<{ key: string; value: string | null }> = []) {
    const removals: any[] = [];
    const rereads: any[] = [];
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
        if (query.includes('verifyTranslationRemoval')) {
          rereads.push(options?.variables);
          return { data: { translatableResource: { translations: readBack.map((r) => ({ ...r, market: null })) } } };
        }
        return { data: { pageUpdate: { page: { id: pageId, title: 'T' }, userErrors: [] } } };
      },
    }));
    return { graphql, removals, rereads };
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

  it('deletes NOTHING locally when Shopify confirmed nothing and still holds the translation', async () => {
    const admin = makePurgeAdmin(undefined, [{ key: 'title', value: 'Titre' }]);
    const db = makeDb([{ locale: 'fr', key: 'title' }, { locale: 'it', key: 'title' }]);
    await savePage(admin, db);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('a gap locale gets the re-read only for THAT locale, and only the confirmed pairs are deleted', async () => {
    // fr echoed; it has a local row and a gap (Shopify still holds it); es is not a shop locale here.
    const admin = makePurgeAdmin(
      { data: { translationsRemove: { userErrors: [], translations: [{ key: 'title', locale: 'fr' }] } } },
      [{ key: 'title', value: 'Titolo' }],
    );
    const db = makeDb([{ locale: 'fr', key: 'title' }, { locale: 'it', key: 'title' }]);
    await savePage(admin, db);

    expect(admin.rereads).toHaveLength(1);
    expect(admin.rereads[0].locale).toBe('it');
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledWith({
      where: { shop, resourceId: pageId, resourceType: 'Page', marketId: '', OR: [{ locale: 'fr', key: { in: ['title'] } }] },
    });
  });

  it('a DB-only row (digest null, never held by Shopify) IS cleared: the re-read confirms it gone', async () => {
    const admin = makePurgeAdmin(undefined, []);
    const db = makeDb([{ locale: 'it', key: 'title' }]);
    await savePage(admin, db);

    expect(admin.rereads).toHaveLength(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({
      shop, marketId: '', OR: [{ locale: 'it', key: { in: ['title'] } }],
    });
  });

  it('a locale with a gap and NO local row costs no re-read and deletes nothing', async () => {
    const admin = makePurgeAdmin();
    const db = makeDb([]);
    await savePage(admin, db);
    expect(admin.rereads).toHaveLength(0);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('a transport error in the purge does NOT fail the primary write: rows kept, warning added', async () => {
    const inner = makePurgeAdmin();
    const admin = {
      graphql: vi.fn(async (query: string, options?: any) => {
        if (query.includes('translationsRemove')) throw new Error('socket hang up');
        return inner.graphql(query, options);
      }),
    };
    const db = makeDb([{ locale: 'fr', key: 'title' }]);
    const result: any = await savePage(admin, db);
    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/could not be removed/);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('userErrors no longer throw out of the save; the rows stay', async () => {
    const admin = makePurgeAdmin(
      { data: { translationsRemove: { userErrors: [{ message: 'refused' }], translations: [] } } },
      [{ key: 'title', value: 'Titre' }],
    );
    const db = makeDb([{ locale: 'fr', key: 'title' }]);
    await expect(savePage(admin, db)).resolves.toMatchObject({ success: true });
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

  it('clear: a DB-only row (Shopify holds nothing) IS cleared by the re-read', async () => {
    const admin = makeAltAdmin({});
    const db = makeDb();
    expect(await run(admin, db, '')).toEqual({ saved: true });
    expect(admin.calls.filter((c) => c.kind === 'reread')).toHaveLength(1);
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('clear: a Shopify refusal is reported as a failure and keeps the row', async () => {
    const admin = makeAltAdmin({
      remove: { data: { translationsRemove: { userErrors: [{ message: 'refused' }], translations: [] } } },
      readBack: [{ key: 'alt', value: 'Rouge', market: null }],
    });
    const db = makeDb();
    const result = await run(admin, db, '');
    expect(result).toEqual({ saved: false, reason: 'shopify-error' });
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('clear: an unechoed removal of a translation Shopify still holds keeps the row', async () => {
    const admin = makeAltAdmin({ readBack: [{ key: 'alt', value: 'Rouge', market: null }] });
    const db = makeDb();
    expect(await run(admin, db, '')).toEqual({ saved: false, reason: 'shopify-error' });
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

  it('register: a write Shopify accepted but did NOT echo is a failure and is not mirrored', async () => {
    const admin = makeAltAdmin({});
    const db = makeDb();
    expect(await run(admin, db, 'Rot')).toEqual({ saved: false, reason: 'shopify-error' });
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it('register: mirrors the value Shopify STORED, with the digest', async () => {
    const admin = makeAltAdmin({
      register: { data: { translationsRegister: { userErrors: [], translations: [{ key: 'alt', locale: 'fr', value: 'Rot (normalised)' }] } } },
    });
    const db = makeDb();
    expect(await run(admin, db, 'Rot')).toEqual({ saved: true });
    expect(db.contentTranslation.upsert.mock.calls[0][0].create).toMatchObject({ value: 'Rot (normalised)', digest: 'dg-alt' });
  });
});

describe('updateContent -- foreign save of a featured image alt', () => {
  const collectionId = 'gid://shopify/Collection/61';
  const imageId = 'gid://shopify/CollectionImage/62';
  function makeAdmin(register: any) {
    const graphql = vi.fn(async (query: string) => ({
      ok: true,
      json: async () => {
        if (query.includes('getFeaturedImageId')) return { data: { collection: { image: { id: imageId } } } };
        if (query.includes('translationsRegister')) return register;
        return { data: { translatableResource: { translatableContent: [{ key: 'alt', value: 'Alt', digest: 'dg-alt', locale: 'de' }] } } };
      },
    }));
    return { graphql };
  }
  const makeDb = () =>
    ({
      $transaction: vi.fn(async (fn: any) => fn({ contentTranslation: { upsert: vi.fn(), deleteMany: vi.fn() } })),
      contentTranslation: { upsert: vi.fn().mockResolvedValue({}), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    }) as any;
  const save = (admin: any, db: any) =>
    new ShopifyContentService(admin as never).updateContent({
      resourceId: collectionId, resourceType: 'Collection', locale: 'fr', primaryLocale: 'de',
      updates: { imageAltText: 'Chaise' }, db, shop,
    } as any);

  it('an alt register Shopify did not echo is a WARNING on the save, not a silent success', async () => {
    const admin = makeAdmin({ data: { translationsRegister: { userErrors: [], translations: [] } } });
    const db = makeDb();
    const result: any = await save(admin, db);
    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/alt text translation was NOT saved/);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it('an echoed alt register adds no warning', async () => {
    const admin = makeAdmin({ data: { translationsRegister: { userErrors: [], translations: [{ key: 'alt', locale: 'fr', value: 'Chaise' }] } } });
    const result: any = await save(admin, makeDb());
    expect(result).toEqual({ success: true });
  });
});
