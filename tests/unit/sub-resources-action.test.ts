/**
 * CHARACTERISATION (docs/plans/PLAN_TRANSLATION_WRITE_UNIFICATION.md, Phase B+C)
 * of app/actions/content/sub-resources.action.ts: what the save / translate /
 * primary-change handlers do with Shopify's answers and the local mirror.
 *
 * The real ShopifyContentService runs over a mocked `admin.graphql`, so these
 * tests keep describing the same observable behaviour across the verified
 * rewrite; the cases tagged (current) pin behaviour the rewrite changes on
 * purpose and are updated in that commit.
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

vi.mock('~/services/translations/market-layer-purge.server', () => ({
  purgeMarketOverrides: vi.fn(async () => undefined),
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

  it('registers the key with its digest and mirrors the row (currently WITHOUT a digest)', async () => {
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
    expect(arg.create.digest).toBeUndefined(); // (current) the digest-less upsert this phase fixes
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
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).toMatchObject({ resourceId: VALUE, key: 'name', locale: 'fr', marketId: '' });
    expect(result.savedResources).toEqual([VALUE]);
  });

  it('a removal Shopify rejected (userErrors) fails the resource and keeps the local row', async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [{ message: 'refused' }], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [VALUE]: { name: '' } }, { [VALUE]: 'ProductOptionValue' }));

    expect(result.failedResources).toEqual([VALUE]);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it('a market-scoped clear removes only that market\'s override', async () => {
    const w = installAdmin();
    const db = makeDb();
    await save(db, w.admin, { [METAFIELD]: { value: '' } }, { [METAFIELD]: 'Metafield' }, { marketId: 'gid://shopify/Market/9' });

    expect(w.of('remove')[0].variables.marketIds).toEqual(['gid://shopify/Market/9']);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where.marketId).toBe('gid://shopify/Market/9');
  });

  it('(current) a GLOBAL metafield clear REGISTERS the empty string instead of removing the translation', async () => {
    const w = installAdmin();
    const db = makeDb();
    await save(db, w.admin, { [METAFIELD]: { value: '' } }, { [METAFIELD]: 'Metafield' });

    expect(w.of('register')[0].variables.translations[0]).toMatchObject({ key: 'value', value: '' });
    expect(w.of('remove')).toHaveLength(0);
  });

  it('(current) an accepted-but-un-echoed write is reported SAVED and mirrored without a digest', async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    const result = body(await save(db, w.admin, { [OPTION]: { name: 'Couleur' } }, { [OPTION]: 'ProductOption' }));

    expect(result.savedResources).toEqual([OPTION]);
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
  });

  it('(current) a removal Shopify did not echo deletes the local row anyway, and the delete has no shop filter', async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    await save(db, w.admin, { [VALUE]: { name: '' } }, { [VALUE]: 'ProductOptionValue' });

    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.contentTranslation.deleteMany.mock.calls[0][0].where).not.toHaveProperty('shop');
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

  it('registers with the digest and mirrors the row (currently WITHOUT a digest)', async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await run(db, w.admin));

    expect(w.of('register')[0].variables.translations).toEqual([
      { key: 'value', value: 'Rouge', locale: 'fr', translatableContentDigest: 'dg-value' },
    ]);
    expect(db.contentTranslation.upsert.mock.calls[0][0].create).toMatchObject({ key: 'value', value: 'Rouge', locale: 'fr' });
    expect(db.contentTranslation.upsert.mock.calls[0][0].create.digest).toBeUndefined(); // (current)
    expect(result.savedResources).toEqual([METAFIELD]);
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

  it('(current) a failed resource still ends the Task as "completed"', async () => {
    const w = installAdmin({
      register: () => ({ data: { translationsRegister: { userErrors: [{ message: 'no' }], translations: [] } } }),
    });
    const db = makeDb();
    await run(db, w.admin);

    const data = lastTaskUpdate(db);
    expect(data.status).toBe('completed');
    expect(JSON.parse(data.result)).toMatchObject({ failedCount: 1 });
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

  it('writes every foreign locale (digest sent) and mirrors the rows (currently WITHOUT a digest)', async () => {
    const w = installAdmin();
    const db = makeDb();
    const result = body(await run(db, w.admin));

    expect(w.of('register').map((c) => c.variables.translations[0].locale).sort()).toEqual(['fr', 'it']);
    const created = db.contentTranslation.upsert.mock.calls.map((c: any[]) => c[0].create);
    expect(created.map((c: any) => c.locale).sort()).toEqual(['fr', 'it']);
    expect(created.every((c: any) => c.digest === undefined)).toBe(true); // (current)
    expect(result.failedLocales).toEqual([]);
    expect(lastTaskUpdate(db).status).toBe('completed');
  });

  it('(current) a locale Shopify refused is neither reported nor reflected in the Task status', async () => {
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

    expect(result.failedLocales).toEqual([]);
    expect(lastTaskUpdate(db).status).toBe('completed');
    // ...and the refused locale was not mirrored.
    expect(db.contentTranslation.upsert.mock.calls.map((c: any[]) => c[0].create.locale)).toEqual(['fr']);
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

  it('(current) a removal Shopify did not echo deletes the local rows anyway', async () => {
    const w = installAdmin({
      remove: () => ({ data: { translationsRemove: { userErrors: [], translations: [] } } }),
    });
    const db = makeDb();
    await save(db, w.admin, { [OPTION]: { name: 'Farbe' } });

    expect(db.contentTranslation.deleteMany).toHaveBeenCalledTimes(1);
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
  it('(current) mirrors the translations Shopify holds for a resource with no local row, WITHOUT a digest', async () => {
    const w = installAdmin({
      readBack: () => ({ data: { translatableResource: { translations: [{ key: 'value', value: 'Rouge', locale: 'fr' }] } } }),
    });
    const db = makeDb();
    const result = body(
      await handleLoadSubResourceTranslations(
        makeCtx(w.admin, db),
        form({ locale: 'fr', resourceIds: JSON.stringify([METAFIELD]) }),
      ),
    );

    expect(result.translations).toEqual({ [METAFIELD]: { value: 'Rouge' } });
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
    const create = db.contentTranslation.upsert.mock.calls[0][0].create;
    expect(create).toMatchObject({ shop: SHOP, resourceId: METAFIELD, resourceType: 'Metafield', key: 'value', value: 'Rouge', locale: 'fr' });
    expect(create.digest).toBeUndefined();
  });
});
