/**
 * docs/plans/PLAN_TRANSLATION_WRITE_UNIFICATION.md, Phase B+C -- the behaviour of
 * app/actions/content/sub-resources.action.ts: what the save / translate /
 * primary-change handlers do with Shopify's answers and the local mirror.
 *
 * The real ShopifyContentService runs over a mocked `admin.graphql`. Written as
 * a characterisation before the verified rewrite; the cases that described the
 * unverified gaps now pin the verified behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShopifyContentService } from '../../src/services/shopify-content.service';
import { markTranslationSaved } from '~/utils/translation-save-lock.server';
import { marketLayerLockId, subResourceLockId, subResourceSyncShieldId } from '~/services/translations/translation-locks.shared';

vi.mock('~/utils/logger.server', () => ({
  loggers: { translation: vi.fn(), seo: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('~/utils/translation-save-lock.server', () => ({
  markTranslationSaved: vi.fn(),
  isTranslationRecentlySaved: vi.fn().mockReturnValue(false),
}));

vi.mock('~/services/tasks/resource-title.server', () => ({
  taskTitleOrFallback: vi.fn(async () => 'Shirt'),
}));

const { world, ai, policy } = vi.hoisted(() => ({
  world: { admin: null as null | { graphql: (q: string, o?: any) => Promise<any> } },
  ai: {
    translateBatchValues: null as null | ((values: string[]) => Promise<string[]>),
    translateBatchValuesToLocales: null as null | ((values: string[], p: string, locales: string[]) => Promise<Record<string, string[]>>),
  },
  policy: {
    purgeOnPrimaryChange: true,
    purgeUnreconciledSurfaces: true,
    autoTranslateExternalChanges: false,
    plan: 'max',
  },
}));

vi.mock('../../src/services/ai.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ai.service')>();
  return {
    ...actual,
    AIService: class {
      translateBatchValues(values: string[]) {
        return ai.translateBatchValues!(values);
      }
      translateBatchValuesToLocales(values: string[], p: string, locales: string[]) {
        return ai.translateBatchValuesToLocales!(values, p, locales);
      }
    },
  };
});

// The handlers build a gateway around `admin`; it delegates to the same mock so
// every call lands in one recorder.
vi.mock('~/services/shopify-api-gateway.service', () => ({
  ShopifyApiGateway: class {
    constructor(public admin: any, public shop: string) {}
    graphql(query: string, options?: any) {
      return this.admin.graphql(query, options);
    }
  },
}));

vi.mock('~/services/translations/translation-change-policy.server', () => ({
  loadTranslationChangePolicy: vi.fn(async () => policy),
}));

const { marketFailed } = vi.hoisted(() => ({ marketFailed: [] as string[] }));
vi.mock('~/services/translations/market-layer-purge.server', () => ({
  purgeMarketOverrides: vi.fn(async (args: any) => {
    for (const key of marketFailed) args.outcome?.failedKeys.add(key);
    return 0;
  }),
}));

vi.mock('~/services/translations/stale-translation-sync.server', () => ({
  contentTranslationMirror: vi.fn(() => ({})),
  reconcileAfterPrimarySave: vi.fn(async () => ({})),
}));

vi.mock('~/services/product-options.server', () => ({
  applyOptionChange: vi.fn(async () => null),
  createOption: vi.fn(async () => null),
  deleteOption: vi.fn(async () => null),
  reorderOptions: vi.fn(async () => null),
}));

import { reconcileAfterPrimarySave } from '~/services/translations/stale-translation-sync.server';
import {
  handleLoadSubResourceTranslations,
  handleSaveSubResourceTranslations,
  handleSavePrimarySubResources,
  handleTranslateSubResources,
  handleTranslateSubResourceToAllLocales,
} from '../../app/actions/content/sub-resources.action';

const SHOP = 'test.myshopify.com';
const OPTION = 'gid://shopify/ProductOption/11';
const VALUE = 'gid://shopify/ProductOptionValue/12';
const METAFIELD = 'gid://shopify/Metafield/13';
const PRODUCT = 'gid://shopify/Product/10';

interface WorldConfig {
  digests?: Record<string, Array<{ key: string; digest: string | null }>>;
  /** Answer to translationsRegister; default = echo everything that was sent. */
  register?: (variables: any) => any;
  /** Answer to translationsRemove; default = echo every (key, locale) asked for. */
  remove?: (variables: any) => any;
  /** Answer to the removal re-read (verifyTranslationRemoval). */
  reread?: (variables: any) => any;
  /** Answer to the loadTranslations read-back (getTranslations). */
  readBack?: (variables: any) => any;
  locales?: Array<{ locale: string; primary: boolean; published: boolean }>;
}

function installAdmin(config: WorldConfig = {}) {
  const calls: Array<{ kind: string; variables: any }> = [];
  const locales = config.locales ?? [
    { locale: 'de', primary: true, published: true },
    { locale: 'fr', primary: false, published: true },
    { locale: 'it', primary: false, published: true },
  ];
  const graphql = vi.fn(async (query: string, options?: any) => {
    const variables = options?.variables;
    const answer = (body: unknown) => ({ ok: true, json: async () => body });
    if (query.includes('getShopLocales')) return answer({ data: { shopLocales: locales } });
    if (query.includes('translationsRegister')) {
      calls.push({ kind: 'register', variables });
      return answer(
        config.register
          ? config.register(variables)
          : {
              data: {
                translationsRegister: {
                  userErrors: [],
                  translations: (variables.translations ?? []).map((t: any) => ({
                    key: t.key, locale: t.locale, value: t.value, market: t.marketId ? { id: t.marketId } : null,
                  })),
                },
              },
            },
      );
    }
    if (query.includes('translationsRemove')) {
      calls.push({ kind: 'remove', variables });
      return answer(
        config.remove
          ? config.remove(variables)
          : {
              data: {
                translationsRemove: {
                  userErrors: [],
                  translations: (variables.locales as string[]).flatMap((locale) =>
                    (variables.translationKeys as string[]).map((key) => ({ key, locale })),
                  ),
                },
              },
            },
      );
    }
    if (query.includes('verifyTranslationRemoval')) {
      calls.push({ kind: 'reread', variables });
      return answer(config.reread ? config.reread(variables) : { data: { translatableResource: { translations: [] } } });
    }
    if (query.includes('getTranslations')) {
      calls.push({ kind: 'readBack', variables });
      return answer(config.readBack ? config.readBack(variables) : { data: { translatableResource: { translations: [] } } });
    }
    if (query.includes('getTranslatableContent') || query.includes('bulkEditorTranslatableContent')) {
      calls.push({ kind: 'digest', variables });
      const rows = config.digests?.[variables.resourceId] ?? [{ key: 'name', digest: 'dg-name' }, { key: 'value', digest: 'dg-value' }];
      return answer({
        data: { translatableResource: { resourceId: variables.resourceId, translatableContent: rows.map((r) => ({ ...r, value: 'src', locale: 'de' })) } },
      });
    }
    if (query.includes('metafieldsSet')) {
      calls.push({ kind: 'metafieldsSet', variables });
      return answer({ data: { metafieldsSet: { userErrors: [], metafields: [] } } });
    }
    if (query.includes('getMarkets')) return answer({ errors: [{ message: 'no markets in this test' }] });
    return answer({ data: {} });
  });
  const admin = { graphql };
  world.admin = admin;
  return { admin, calls, of: (kind: string) => calls.filter((c) => c.kind === kind) };
}

function makeDb() {
  return {
    contentTranslation: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    task: {
      create: vi.fn().mockResolvedValue({ id: 'task-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    productMetafield: { update: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    productOption: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(2) },
    product: { findFirst: vi.fn().mockResolvedValue({ title: 'Shirt' }) },
  } as any;
}

function makeCtx(admin: any, db: any) {
  return {
    admin,
    session: { shop: SHOP },
    db,
    contentConfig: { resourceType: 'Product' },
    itemId: PRODUCT,
    aiSettings: null,
    aiInstructions: null,
    translationMode: 'exact',
    seoLimits: {},
    shopifyContentService: new ShopifyContentService(admin),
    provider: 'claude',
    serviceConfig: {},
  } as any;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** `data()` from react-router wraps the body; unwrap either shape. */
const body = (r: any) => (r && typeof r === 'object' && 'data' in r && 'type' in r ? r.data : r);

beforeEach(() => {
  policy.purgeOnPrimaryChange = true;
  policy.purgeUnreconciledSurfaces = true;
  policy.autoTranslateExternalChanges = false;
  ai.translateBatchValues = null;
  ai.translateBatchValuesToLocales = null;
});

// ---------------------------------------------------------------------------
describe('handleSaveSubResourceTranslations', () => {
  const save = (db: any, admin: any, translationsData: any, resourceTypes: any, extra: Record<string, string> = {}) =>
    handleSaveSubResourceTranslations(
      makeCtx(admin, db),
      form({
        locale: 'fr',
        translationsData: JSON.stringify(translationsData),
        resourceTypes: JSON.stringify(resourceTypes),
        ...extra,
      }),
    );

  it('registers the key with its digest and mirrors the confirmed row WITH its digest', async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await save(db, w.admin, { [OPTION]: { name: 'Couleur' } }, { [OPTION]: 'ProductOption' }));

    expect(w.of('register')[0].variables).toMatchObject({
      resourceId: OPTION,
      translations: [{ key: 'name', value: 'Couleur', locale: 'fr', translatableContentDigest: 'dg-name' }],
    });
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
    const arg = db.contentTranslation.upsert.mock.calls[0][0];
    expect(arg.create).toMatchObject({ shop: SHOP, resourceId: OPTION, resourceType: 'ProductOption', key: 'name', value: 'Couleur', locale: 'fr', marketId: '' });
    expect(arg.create.digest).toBe('dg-name');
    expect(result).toMatchObject({ success: true, savedResources: [OPTION], failedResources: [] });
  });

  it('reports a resource Shopify refused (userErrors) as failed and mirrors nothing', async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [{ message: 'Name can\'t be blank' }], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [OPTION]: { name: 'Couleur' } }, { [OPTION]: 'ProductOption' }));

    expect(result.failedResources).toEqual([OPTION]);
    expect(result.savedResources).toEqual([]);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it('a cleared option value is REMOVED for that locale, and the local row is deleted when Shopify echoes it', async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await save(db, w.admin, { [VALUE]: { name: '' } }, { [VALUE]: 'ProductOptionValue' }));

    expect(w.of('register')).toHaveLength(0);
    expect(w.of('remove')[0].variables).toMatchObject({ resourceId: VALUE, translationKeys: ['name'], locales: ['fr'], marketIds: null });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({ shop: SHOP, resourceId: VALUE, key: { in: ['name'] }, locale: 'fr', marketId: '' });
    expect(result.savedResources).toEqual([VALUE]);
  });

  it('a removal Shopify rejected (userErrors) fails the resource and keeps the local row', async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [{ message: 'refused' }], translations: [] } } }),
      reread: () => ({ data: { translatableResource: { translations: [{ key: 'name', value: 'Rouge', market: null }] } } }),
    });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [VALUE]: { name: '' } }, { [VALUE]: 'ProductOptionValue' }));

    expect(result.failedResources).toEqual([VALUE]);
    expect(result.savedResources).toEqual([]);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('a market-scoped clear removes only that market\'s override', async () => {
    const w = installAdmin();
    const db = makeDb();
    await save(db, w.admin, { [METAFIELD]: { value: '' } }, { [METAFIELD]: 'Metafield' }, { marketId: 'gid://shopify/Market/9' });

    expect(w.of('remove')[0].variables.marketIds).toEqual(['gid://shopify/Market/9']);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where.marketId).toBe('gid://shopify/Market/9');
  });

  it('a GLOBAL metafield clear REMOVES the translation instead of registering ""', async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await save(db, w.admin, { [METAFIELD]: { value: '' } }, { [METAFIELD]: 'Metafield' }));

    expect(w.of('register')).toHaveLength(0);
    expect(w.of('remove')[0].variables).toMatchObject({ resourceId: METAFIELD, translationKeys: ['value'], locales: ['fr'], marketIds: null });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(result.savedResources).toEqual([METAFIELD]);
  });

  it('an accepted-but-un-echoed write is reported FAILED and mirrored NOWHERE', async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [OPTION]: { name: 'Couleur' } }, { [OPTION]: 'ProductOption' }));

    expect(result.failedResources).toEqual([OPTION]);
    expect(result.savedResources).toEqual([]);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it('a partial echo mirrors the echoed key only and fails the resource', async () => {
    const w = installAdmin({
      digests: { [OPTION]: [{ key: 'name', digest: 'dg-name' }, { key: 'value', digest: 'dg-value' }] },
      register: (v) => ({
        data: { translationsRegister: { userErrors: [], translations: [{ key: 'name', locale: 'fr', value: v.translations[0].value }] } },
      }),
    });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [OPTION]: { name: 'Couleur', value: 'Autre' } }, { [OPTION]: 'ProductOption' }));

    expect(result.failedResources).toEqual([OPTION]);
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.upsert.mock.calls[0][0].create.key).toBe('name');
  });

  it('a key with NO digest is never sent, never mirrored, and is `notTranslatable` -- not a failure', async () => {
    const w = installAdmin({ digests: { [OPTION]: [{ key: 'name', digest: null }] } });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [OPTION]: { name: 'Couleur' } }, { [OPTION]: 'ProductOption' }));

    expect(w.of('register')).toHaveLength(0);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
    expect(result.failedResources).toEqual([]);
    expect(result.savedResources).toEqual([]);
    expect(result.notTranslatable).toEqual([OPTION]);
  });

  it('a refused key beside a digest-less one still fails the resource (and names it as not translatable)', async () => {
    const w = installAdmin({
      digests: { [OPTION]: [{ key: 'name', digest: 'dg-name' }, { key: 'value', digest: null }] },
      register: () => ({ data: { translationsRegister: { userErrors: [{ message: 'no' }], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [OPTION]: { name: 'Couleur', value: 'x' } }, { [OPTION]: 'ProductOption' }));

    expect(result.failedResources).toEqual([OPTION]);
    expect(result.notTranslatable).toEqual([OPTION]);
  });

  it('a DB-only row (Shopify holds nothing, no echo) IS cleared by the re-read, and the delete is shop-scoped', async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [VALUE]: { name: '' } }, { [VALUE]: 'ProductOptionValue' }));

    expect(w.of('reread')).toHaveLength(1);
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({ shop: SHOP, resourceId: VALUE, key: { in: ['name'] }, locale: 'fr', marketId: '' });
    expect(result.savedResources).toEqual([VALUE]);
  });

  it('an unechoed removal of a translation Shopify STILL holds keeps the row and fails the resource', async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
      reread: () => ({ data: { translatableResource: { translations: [{ key: 'name', value: 'Rouge', market: null }] } } }),
    });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [VALUE]: { name: '' } }, { [VALUE]: 'ProductOptionValue' }));

    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
    expect(result.failedResources).toEqual([VALUE]);
  });

  it('"clear all" of a locale: option name, option value and metafield are each REMOVED on their own resource; only confirmed rows go locally', async () => {
    // The payload the product page's clear-all sends. The option VALUE's
    // removal is not echoed and Shopify still holds it: its row stays and it is
    // reported failed, while the other two are deleted locally.
    const w = installAdmin({
      remove: (v: any) => ({
        data: {
          translationsRemove: {
            userErrors: [],
            translations: v.resourceId === VALUE ? [] : (v.translationKeys as string[]).map((key) => ({ key, locale: 'fr' })),
          },
        },
      }),
      reread: () => ({ data: { translatableResource: { translations: [{ key: 'name', value: 'Rouge', market: null }] } } }),
    });
    const db = makeDb();
    const result = body(await save(
      db,
      w.admin,
      { [OPTION]: { name: '' }, [VALUE]: { name: '' }, [METAFIELD]: { value: '' } },
      { [OPTION]: 'ProductOption', [VALUE]: 'ProductOptionValue', [METAFIELD]: 'Metafield' },
    ));

    expect(w.of('register')).toHaveLength(0);
    expect(w.of('remove').map((c) => [c.variables.resourceId, c.variables.translationKeys, c.variables.locales])).toEqual([
      [OPTION, ['name'], ['fr']],
      [VALUE, ['name'], ['fr']],
      [METAFIELD, ['value'], ['fr']],
    ]);
    const deleted = db.contentTranslation.deleteMany.mock.calls.map((c: any) => c[0].where.resourceId);
    expect(deleted).toEqual([OPTION, METAFIELD]);
    expect(result.savedResources).toEqual([OPTION, METAFIELD]);
    expect(result.failedResources).toEqual([VALUE]);
  });

  it('"clear all" in a MARKET removes only that market\'s overrides of the sub-resources', async () => {
    const w = installAdmin({
      remove: (v: any) => ({
        data: { translationsRemove: { userErrors: [], translations: (v.translationKeys as string[]).map((key) => ({ key, locale: 'fr', market: { id: 'gid://shopify/Market/9' } })) } },
      }),
    });
    const db = makeDb();
    await save(
      db,
      w.admin,
      { [OPTION]: { name: '' }, [METAFIELD]: { value: '' } },
      { [OPTION]: 'ProductOption', [METAFIELD]: 'Metafield' },
      { marketId: 'gid://shopify/Market/9' },
    );

    for (const call of w.of('remove')) expect(call.variables.marketIds).toEqual(['gid://shopify/Market/9']);
    for (const call of db.contentTranslation.deleteMany.mock.calls) {
      expect(call[0].where).toMatchObject({ shop: SHOP, locale: 'fr', marketId: 'gid://shopify/Market/9' });
    }
  });
});

// ---------------------------------------------------------------------------
describe('handleTranslateSubResources', () => {
  const sourceData = [{ resourceId: METAFIELD, resourceType: 'Metafield', key: 'value', value: 'Red', label: 'Colour' }];
  const run = (db: any, admin: any) => {
    ai.translateBatchValues = async (values) => values.map(() => 'Rouge');
    return handleTranslateSubResources(
      makeCtx(admin, db),
      form({ targetLocale: 'fr', primaryLocale: 'de', sourceData: JSON.stringify(sourceData) }),
    );
  };
  const lastTaskUpdate = (db: any) => db.task.update.mock.calls.at(-1)[0].data;

  it('registers with the digest and mirrors the confirmed row WITH its digest', async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await run(db, w.admin));

    expect(w.of('register')[0].variables.translations).toEqual([
      { key: 'value', value: 'Rouge', locale: 'fr', translatableContentDigest: 'dg-value' },
    ]);
    expect(db.contentTranslation.upsert.mock.calls[0][0].create).toMatchObject({ key: 'value', value: 'Rouge', locale: 'fr', digest: 'dg-value' });
    expect(result.savedResources).toEqual([METAFIELD]);
    expect(result.translations).toEqual({ [METAFIELD]: { value: 'Rouge' } });
    expect(lastTaskUpdate(db).status).toBe('completed');
  });

  it('reports a refused resource in failedResources and mirrors nothing', async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [{ message: 'no' }], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await run(db, w.admin));

    expect(result.failedResources).toEqual([METAFIELD]);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it('a failed resource ends the Task as completed_with_errors, with the failure in the result', async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [{ message: 'no' }], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await run(db, w.admin));

    const data = lastTaskUpdate(db);
    expect(data.status).toBe('completed_with_errors');
    expect(JSON.parse(data.result)).toMatchObject({ failedCount: 1, failedResources: [METAFIELD], failedLocales: ['fr'] });
    // The page paints `translations` as saved: a refused one must not be in it.
    expect(result.translations).toEqual({});
  });

  it('an accepted-but-un-echoed write is failed, not saved', async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await run(db, w.admin));

    expect(result.failedResources).toEqual([METAFIELD]);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
  });

  it('a digest-less key is `notTranslatable`, not a failed resource, and the Task completes cleanly', async () => {
    const w = installAdmin({ digests: { [METAFIELD]: [{ key: 'value', digest: null }] } });
    const db = makeDb();
    const result = body(await run(db, w.admin));

    expect(result.notTranslatable).toEqual([METAFIELD]);
    expect(result.failedResources).toEqual([]);
    expect(result.failedLocales).toEqual([]);
    expect(result.translations).toEqual({});
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
    expect(lastTaskUpdate(db).status).toBe('completed');
  });

  it('a refused resource also reports failedLocales (the client names the locale)', async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [{ message: 'no' }], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await run(db, w.admin));
    expect(result.failedLocales).toEqual(['fr']);
  });
});

// ---------------------------------------------------------------------------
describe('handleTranslateSubResourceToAllLocales', () => {
  const sourceData = [{ resourceId: METAFIELD, resourceType: 'Metafield', key: 'value', value: 'Red', label: 'Colour' }];
  const run = (db: any, admin: any) => {
    ai.translateBatchValuesToLocales = async (_values, _p, locales) =>
      Object.fromEntries(locales.map((l) => [l, [`Rot-${l}`]]));
    return handleTranslateSubResourceToAllLocales(
      makeCtx(admin, db),
      form({ primaryLocale: 'de', sourceData: JSON.stringify(sourceData) }),
    );
  };
  const lastTaskUpdate = (db: any) => db.task.update.mock.calls.at(-1)[0].data;

  it('writes every foreign locale and mirrors the confirmed rows WITH their digest', async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await run(db, w.admin));

    expect(w.of('register').map((c) => c.variables.translations[0].locale).sort()).toEqual(['fr', 'it']);
    const created = db.contentTranslation.upsert.mock.calls.map((c: any[]) => c[0].create);
    expect(created.map((c: any) => c.locale).sort()).toEqual(['fr', 'it']);
    expect(created.every((c: any) => c.digest === 'dg-value')).toBe(true);
    expect(result.failedLocales).toEqual([]);
    expect(lastTaskUpdate(db).status).toBe('completed');
  });

  it('a locale Shopify refused is reported in failedLocales/failedResources, ends the Task completed_with_errors, and is not mirrored', async () => {
    const w = installAdmin({
      register: (variables) =>
        variables.translations[0].locale === 'it'
          ? { data: { translationsRegister: { userErrors: [{ message: 'no' }], translations: [] } } }
          : {
              data: {
                translationsRegister: {
                  userErrors: [],
                  translations: variables.translations.map((t: any) => ({ key: t.key, locale: t.locale, value: t.value })),
                },
              },
            },
    });
    const db = makeDb();
    const result = body(await run(db, w.admin));

    expect(result.failedLocales).toEqual(['it']);
    expect(result.failedResources).toEqual([METAFIELD]);
    const data = lastTaskUpdate(db);
    expect(data.status).toBe('completed_with_errors');
    expect(JSON.parse(data.result)).toMatchObject({ translatedLocales: ['fr'], failedLocales: ['it'], failedResources: [METAFIELD] });
    expect(db.contentTranslation.upsert.mock.calls.map((c: any[]) => c[0].create.locale)).toEqual(['fr']);
  });

  it('an unechoed write in a locale is a failed locale too', async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await run(db, w.admin));

    expect(result.failedLocales.sort()).toEqual(['fr', 'it']);
    expect(db.contentTranslation.upsert).not.toHaveBeenCalled();
    expect(lastTaskUpdate(db).status).toBe('completed_with_errors');
  });
});

// ---------------------------------------------------------------------------
describe('handleSavePrimarySubResources — the primary-change purges', () => {
  const echoRemoved = (keys: string[], locales: string[]) => ({
    data: {
      translationsRemove: {
        userErrors: [],
        translations: locales.flatMap((locale) => keys.map((key) => ({ key, locale }))),
      },
    },
  });
  const save = (db: any, admin: any, optionsChanges: any = {}, metafieldChanges: any = {}) =>
    handleSavePrimarySubResources(
      makeCtx(admin, db),
      form({
        productId: PRODUCT,
        optionsChanges: JSON.stringify(optionsChanges),
        metafieldChanges: JSON.stringify(metafieldChanges),
      }),
    );

  it('removes the option NAME translations in every foreign locale (one call) and deletes the global local rows', async () => {
    const w = installAdmin({ remove: (v) => echoRemoved(v.translationKeys, v.locales) });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [OPTION]: { name: 'Farbe' } }));

    expect(result.savedOptions).toEqual([OPTION]);
    const removals = w.of('remove');
    expect(removals).toHaveLength(1);
    expect(removals[0].variables).toMatchObject({ resourceId: OPTION, translationKeys: ['name'], locales: ['fr', 'it'] });
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({
      resourceId: OPTION, resourceType: 'ProductOption', key: 'name', marketId: '', locale: { in: ['fr', 'it'] },
    });
  });

  it('removes the option VALUE translations on each value\'s own resource', async () => {
    const w = installAdmin({ remove: (v) => echoRemoved(v.translationKeys, v.locales) });
    const db = makeDb();
    await save(db, w.admin, { [OPTION]: { valueUpdates: [{ id: VALUE, name: 'Rot' }] } });

    const removals = w.of('remove');
    expect(removals).toHaveLength(1);
    expect(removals[0].variables).toMatchObject({ resourceId: VALUE, translationKeys: ['name'], locales: ['fr', 'it'] });
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({ resourceId: VALUE, resourceType: 'ProductOptionValue', key: 'name' });
  });

  it('removes the metafield `value` translations', async () => {
    const w = installAdmin({ remove: (v) => echoRemoved(v.translationKeys, v.locales) });
    const db = makeDb();
    const result = body(await save(db, w.admin, {}, { [METAFIELD]: 'new' }));

    expect(result.savedMetafields).toEqual([METAFIELD]);
    expect(w.of('remove')[0].variables).toMatchObject({ resourceId: METAFIELD, translationKeys: ['value'], locales: ['fr', 'it'] });
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({ resourceId: METAFIELD, resourceType: 'Metafield', key: 'value' });
  });

  it('a removal Shopify rejected (userErrors) keeps the local rows', async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [{ message: 'refused' }], translations: [] } } }),
    });
    const db = makeDb();
    await save(db, w.admin, { [OPTION]: { name: 'Farbe' } }, { [METAFIELD]: 'new' });

    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes NOTHING locally when Shopify confirmed nothing and still holds the translation', async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
      reread: () => ({ data: { translatableResource: { translations: [{ key: 'name', value: 'Couleur', market: null }] } } }),
    });
    const db = makeDb();
    db.contentTranslation.findMany.mockResolvedValue([{ locale: 'fr', key: 'name' }, { locale: 'it', key: 'name' }]);
    await save(db, w.admin, { [OPTION]: { name: 'Farbe' } });

    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('a gap locale gets the re-read only for THAT locale; only the confirmed locale is deleted locally (shop-scoped)', async () => {
    const w = installAdmin({
      remove: (v) => echoRemoved(v.translationKeys, v.locales.filter((l: string) => l === 'fr')),
      reread: () => ({ data: { translatableResource: { translations: [{ key: 'name', value: 'Colore', market: null }] } } }),
    });
    const db = makeDb();
    db.contentTranslation.findMany.mockResolvedValue([{ locale: 'fr', key: 'name' }, { locale: 'it', key: 'name' }]);
    await save(db, w.admin, { [OPTION]: { name: 'Farbe' } });

    const rereads = w.of('reread');
    expect(rereads).toHaveLength(1);
    expect(rereads[0].variables.locale).toBe('it');
    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({
      shop: SHOP, resourceId: OPTION, key: 'name', locale: { in: ['fr'] }, marketId: '',
    });
  });

  it('a DB-only row (Shopify never held it) IS cleared: the re-read confirms the key gone', async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    db.contentTranslation.findMany.mockResolvedValue([{ locale: 'it', key: 'value' }]);
    await save(db, w.admin, {}, { [METAFIELD]: 'new' });

    expect(w.of('reread')).toHaveLength(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({ shop: SHOP, resourceId: METAFIELD, key: 'value', locale: { in: ['it'] } });
  });

  it('a gap locale with NO local row costs no re-read and deletes nothing', async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    await save(db, w.admin, { [OPTION]: { name: 'Farbe' } });

    expect(w.of('reread')).toHaveLength(0);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  describe('reports the resources whose MARKET overrides the purge confirmed removed', () => {
    beforeEach(() => { marketFailed.length = 0; });

    it('names every changed option, option value and metafield when the purge confirmed', async () => {
      const w = installAdmin({ remove: (v) => echoRemoved(v.translationKeys, v.locales) });
      const result = body(await save(makeDb(), w.admin, { [OPTION]: { name: 'Farbe', valueUpdates: [{ id: VALUE, name: 'Rot' }] } }, { [METAFIELD]: 'new' }));
      expect([...result.marketPurgedResourceIds].sort()).toEqual([METAFIELD, OPTION, VALUE].sort());
    });

    it('holds back the resources of a key whose market removal was not confirmed', async () => {
      marketFailed.push('name');
      const w = installAdmin({ remove: (v) => echoRemoved(v.translationKeys, v.locales) });
      const result = body(await save(makeDb(), w.admin, { [OPTION]: { name: 'Farbe' } }, { [METAFIELD]: 'new' }));
      expect(result.marketPurgedResourceIds).toEqual([METAFIELD]);
      marketFailed.length = 0;
    });

    it('reports nothing when every key failed', async () => {
      marketFailed.push('name', 'value');
      const w = installAdmin({ remove: (v) => echoRemoved(v.translationKeys, v.locales) });
      const result = body(await save(makeDb(), w.admin, { [OPTION]: { name: 'Farbe' } }, { [METAFIELD]: 'new' }));
      expect(result.marketPurgedResourceIds).toBeUndefined();
      marketFailed.length = 0;
    });

    it('reports nothing with the deletion switched off', async () => {
      policy.purgeUnreconciledSurfaces = false;
      const w = installAdmin();
      const result = body(await save(makeDb(), w.admin, { [OPTION]: { name: 'Farbe' } }));
      expect(result.marketPurgedResourceIds).toBeUndefined();
    });

    it('auto-translate on: takes the keys the repair reports as purged', async () => {
      policy.autoTranslateExternalChanges = true;
      policy.purgeOnPrimaryChange = false;
      vi.mocked(reconcileAfterPrimarySave).mockResolvedValueOnce({ removed: 0, retranslating: 2, marketPurgedKeys: ['name'] } as any);
      const w = installAdmin();
      const result = body(await save(makeDb(), w.admin, { [OPTION]: { name: 'Farbe' } }, { [METAFIELD]: 'new' }));
      expect(result.marketPurgedResourceIds).toEqual([OPTION]);
    });
  });

  it('does nothing when the merchant switched the deletion off', async () => {
    policy.purgeUnreconciledSurfaces = false;
    const w = installAdmin();
    const db = makeDb();
    await save(db, w.admin, { [OPTION]: { name: 'Farbe' } });

    expect(w.of('remove')).toHaveLength(0);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('handleLoadSubResourceTranslations — read-back backfill', () => {
  it('mirrors the translations Shopify holds for a resource with no local row, WITH the digest of the same read', async () => {
    const w = installAdmin({
      readBack: () => ({
        data: {
          translatableResource: {
            translatableContent: [{ key: 'value', digest: 'dg-read' }, { key: 'name', digest: 'dg-name-read' }],
            translations: [
              { key: 'value', value: 'Rouge', locale: 'fr', outdated: false },
              { key: 'name', value: 'Couleur', locale: 'fr', outdated: true },
              { key: 'other', value: null, locale: 'fr', outdated: false },
            ],
          },
        },
      }),
    });
    const db = makeDb();
    const result = body(
      await handleLoadSubResourceTranslations(
        makeCtx(w.admin, db),
        form({ locale: 'fr', resourceIds: JSON.stringify([METAFIELD]) }),
      ),
    );

    expect(result.translations).toEqual({ [METAFIELD]: { value: 'Rouge', name: 'Couleur' } });
    const created = Object.fromEntries(db.contentTranslation.upsert.mock.calls.map((c: any[]) => [c[0].create.key, c[0].create]));
    expect(Object.keys(created).sort()).toEqual(['name', 'value']); // the value-less row is not a translation
    expect(created.value).toMatchObject({ shop: SHOP, resourceId: METAFIELD, resourceType: 'Metafield', value: 'Rouge', locale: 'fr', digest: 'dg-read' });
    // An OUTDATED row was written against an older source: no digest, or it would hide that it is stale.
    expect(created.name.digest).toBeNull();
  });
});

/**
 * The early validation refusals answer 400 WITHOUT having reached the handler's
 * try: the client reads `actionType` (and `fieldId`) to decide whose spinner to
 * clear and which message to show. Without them a refused load left the hook's
 * `isLoading` stuck and a refused translate cleared every spinner.
 */
describe('early 400s carry the actionType (and fieldId) of the request', () => {
  const w = () => installAdmin();
  const answer = async (promise: Promise<unknown>) => {
    const r: any = await promise;
    return { body: body(r), status: r?.init?.status };
  };

  it('load: invalid locale and invalid resource id', async () => {
    const world = w();
    const a = await answer(handleLoadSubResourceTranslations(makeCtx(world.admin, makeDb()), form({ locale: '!!', resourceIds: '[]' })));
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ success: false, actionType: 'loadSubResourceTranslations' });
    const b = await answer(
      handleLoadSubResourceTranslations(makeCtx(world.admin, makeDb()), form({ locale: 'fr', resourceIds: JSON.stringify(['not-a-gid']) })),
    );
    expect(b.status).toBe(400);
    expect(b.body).toMatchObject({ success: false, actionType: 'loadSubResourceTranslations' });
  });

  it('save: invalid locale', async () => {
    const a = await answer(handleSaveSubResourceTranslations(makeCtx(w().admin, makeDb()), form({ locale: '!!' })));
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ success: false, actionType: 'saveSubResourceTranslations' });
  });

  it('translate: invalid target locale echoes the fieldId', async () => {
    const a = await answer(
      handleTranslateSubResources(makeCtx(w().admin, makeDb()), form({ targetLocale: '!!', fieldId: 'option-1' })),
    );
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ success: false, actionType: 'translateSubResources', fieldId: 'option-1' });
  });

  it('primary save: invalid product id', async () => {
    const a = await answer(handleSavePrimarySubResources(makeCtx(w().admin, makeDb()), form({ productId: 'nope' })));
    expect(a.status).toBe(400);
    expect(a.body).toMatchObject({ success: false, actionType: 'savePrimarySubResources' });
  });
});


// ---------------------------------------------------------------------------
describe('the SYNC-ONLY shield of the options & metafields card', () => {
  const marks = () => vi.mocked(markTranslationSaved).mock.calls.map((c) => c[0]);
  const SHIELD = subResourceSyncShieldId(PRODUCT);
  const LOCK = subResourceLockId(PRODUCT);
  const source = [{ resourceId: METAFIELD, resourceType: 'Metafield', key: 'value', value: 'Red', label: 'Colour' }];

  beforeEach(() => {
    vi.mocked(markTranslationSaved).mockClear();
  });

  it('a foreign save marks it (and never the repair lock), on the global AND the market layer', async () => {
    for (const marketId of ['', 'gid://shopify/Market/5']) {
      vi.mocked(markTranslationSaved).mockClear();
      const w = installAdmin();
      await handleSaveSubResourceTranslations(
        makeCtx(w.admin, makeDb()),
        form({
          locale: 'fr',
          marketId,
          translationsData: JSON.stringify({ [OPTION]: { name: 'Couleur' } }),
          resourceTypes: JSON.stringify({ [OPTION]: 'ProductOption' }),
        }),
      );
      expect(marks()).toContain(SHIELD);
      expect(marks()).not.toContain(LOCK);
    }
  });

  it('a MARKET-layer save marks the market variant of the sub-resource, never the bare GID a repair watches', async () => {
    const w = installAdmin();
    await handleSaveSubResourceTranslations(
      makeCtx(w.admin, makeDb()),
      form({
        locale: 'fr',
        marketId: 'gid://shopify/Market/5',
        translationsData: JSON.stringify({ [OPTION]: { name: 'Couleur' } }),
        resourceTypes: JSON.stringify({ [OPTION]: 'ProductOption' }),
      }),
    );
    expect(marks()).toContain(marketLayerLockId(OPTION));
    expect(marks()).not.toContain(OPTION);

    vi.mocked(markTranslationSaved).mockClear();
    await handleSaveSubResourceTranslations(
      makeCtx(installAdmin().admin, makeDb()),
      form({
        locale: 'fr',
        translationsData: JSON.stringify({ [OPTION]: { name: 'Couleur' } }),
        resourceTypes: JSON.stringify({ [OPTION]: 'ProductOption' }),
      }),
    );
    expect(marks()).toContain(OPTION);
    expect(marks()).not.toContain(marketLayerLockId(OPTION));
  });

  it('a "clear all" (every value "") marks it too', async () => {
    const w = installAdmin();
    await handleSaveSubResourceTranslations(
      makeCtx(w.admin, makeDb()),
      form({
        locale: 'fr',
        translationsData: JSON.stringify({ [OPTION]: { name: '' }, [METAFIELD]: { value: '' } }),
        resourceTypes: JSON.stringify({ [OPTION]: 'ProductOption', [METAFIELD]: 'Metafield' }),
      }),
    );
    expect(marks()).toContain(SHIELD);
    expect(marks()).not.toContain(LOCK);
  });

  it('a translate and a translate-to-all mark it after a confirmed write, never the repair lock', async () => {
    ai.translateBatchValues = async (values) => values.map(() => 'Rouge');
    await handleTranslateSubResources(
      makeCtx(installAdmin().admin, makeDb()),
      form({ targetLocale: 'fr', primaryLocale: 'de', sourceData: JSON.stringify(source) }),
    );
    expect(marks()).toContain(SHIELD);
    expect(marks()).not.toContain(LOCK);

    vi.mocked(markTranslationSaved).mockClear();
    ai.translateBatchValuesToLocales = async (_v, _p, locales) => Object.fromEntries(locales.map((l) => [l, [`Rot-${l}`]]));
    await handleTranslateSubResourceToAllLocales(
      makeCtx(installAdmin().admin, makeDb()),
      form({ primaryLocale: 'de', sourceData: JSON.stringify(source) }),
    );
    expect(marks()).toContain(SHIELD);
    expect(marks()).not.toContain(LOCK);
  });

  it('a translate Shopify refused marks nothing for the sync', async () => {
    ai.translateBatchValues = async (values) => values.map(() => 'Rouge');
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [{ message: 'no' }], translations: [] } } }),
    });
    await handleTranslateSubResources(
      makeCtx(w.admin, makeDb()),
      form({ targetLocale: 'fr', primaryLocale: 'de', sourceData: JSON.stringify(source) }),
    );
    expect(marks()).not.toContain(SHIELD);
  });

  it("a primary save's purge marks it", async () => {
    const w = installAdmin({
      remove: (v) => ({
        data: {
          translationsRemove: {
            userErrors: [],
            translations: v.locales.flatMap((locale: string) => v.translationKeys.map((key: string) => ({ key, locale }))),
          },
        },
      }),
    });
    await handleSavePrimarySubResources(
      makeCtx(w.admin, makeDb()),
      form({ productId: PRODUCT, optionsChanges: JSON.stringify({ [OPTION]: { name: 'Farbe' } }), metafieldChanges: '{}' }),
    );
    expect(marks()).toContain(SHIELD);
  });
});
