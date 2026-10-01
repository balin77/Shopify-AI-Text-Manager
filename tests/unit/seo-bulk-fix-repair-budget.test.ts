/**
 * Two rails on the SEO "Fix with AI" runners, both about the detached
 * re-translation every editor save may start:
 *
 * 1. "Fix all issues for one item" writes ALL the text fields it generated in
 *    ONE editor save. One save per field made each save's claim
 *    (`markTranslationSaved`) abort the previous save's repair run mid-locale
 *    ("a merchant saved meanwhile"), so its remaining entries landed in neither
 *    list and stayed stale.
 * 2. A bulk task carries ONE budget of repair groups (the bulk editor's
 *    MAX_REPAIR_GROUPS): past it saves start no run, and the overflow is
 *    reported in the task result.
 *
 * Also pinned: a failed shop-locale lookup refuses the whole task up front
 * instead of failing every item, and the content service is built on the
 * gateway (THROTTLED retries), not the raw client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateContent = vi.fn();
const handleUpdateProduct = vi.fn();
const analyzeStore = vi.fn();
const getCachedShopLocales = vi.fn();
const serviceCtorArgs: unknown[] = [];

vi.mock('~/actions/product/update.actions', () => ({
  handleUpdateProduct: (...a: unknown[]) => handleUpdateProduct(...a),
}));
vi.mock('../../src/services/shopify-content.service', () => ({
  ShopifyContentService: class {
    constructor(client: unknown) {
      serviceCtorArgs.push(client);
    }
    updateContent(...a: unknown[]) {
      return updateContent(...a);
    }
    async loadShopLocales() {
      return { shopLocales: [{ locale: 'de', primary: true, name: 'German', published: true }] };
    }
  },
}));
vi.mock('~/services/shopify-api-gateway.service', () => ({
  ShopifyApiGateway: class {
    readonly isGateway = true;
  },
}));
vi.mock('~/services/seo/audit.service', () => ({
  analyzeStore: (...a: unknown[]) => analyzeStore(...a),
}));
vi.mock('~/utils/shop-locales-cache.server', () => ({
  getCachedShopLocales: (...a: unknown[]) => getCachedShopLocales(...a),
}));
vi.mock('../../app/routes/api-ai-handlers/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app/routes/api-ai-handlers/shared')>();
  return {
    ...actual,
    createAIService: () => ({
      generateProductTitle: vi.fn(async () => 'Generated'),
      generateProductDescription: vi.fn(async () => '<p>Generated</p>'),
      generateImageAltText: vi.fn(async () => 'Alt'),
    }),
  };
});

import { handleSeoBulkFix } from '../../app/routes/api-ai-handlers/seo-bulk-fix.handler';
import { MAX_REPAIR_GROUPS } from '../../app/services/bulk-editor/retranslate.server';

const shop = 'shop.myshopify.com';

function makeDb(collectionIds: string[]) {
  const taskUpdates: Array<Record<string, any>> = [];
  const db: any = {
    task: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'task-1' }),
      update: vi.fn(async (args: { data: Record<string, any> }) => {
        taskUpdates.push(args.data);
        return {};
      }),
    },
    aISettings: { findUnique: vi.fn().mockResolvedValue({ subscriptionPlan: 'pro' }) },
    aIInstructions: { findUnique: vi.fn().mockResolvedValue(null) },
    collection: {
      findMany: vi.fn().mockResolvedValue(
        collectionIds.map((id) => ({
          id,
          title: 'Old',
          descriptionHtml: '',
          seoTitle: '',
          seoDescription: '',
        })),
      ),
    },
  };
  return { db, taskUpdates };
}

function ctxFor(db: unknown, form: Record<string, string>) {
  const formData = new FormData();
  for (const [k, v] of Object.entries(form)) formData.set(k, v);
  return {
    session: { shop },
    admin: { graphql: vi.fn() },
    db,
    settings: null,
    formData,
    seoTitleMaxChars: 60,
    seoLimits: {},
  } as never;
}

async function finalUpdate(taskUpdates: Array<Record<string, any>>) {
  await vi.waitFor(() => {
    expect(taskUpdates.some((u) => u.completedAt)).toBe(true);
  });
  return taskUpdates.find((u) => u.completedAt)!;
}

beforeEach(() => {
  updateContent.mockReset();
  handleUpdateProduct.mockReset();
  analyzeStore.mockReset();
  getCachedShopLocales.mockReset();
  serviceCtorArgs.length = 0;
  updateContent.mockResolvedValue({ success: true });
  getCachedShopLocales.mockResolvedValue([{ locale: 'de', primary: true, name: 'German', published: true }]);
});

describe('fixAllForItem: one editor save for all of an item\'s text fields', () => {
  const id = 'gid://shopify/Collection/1';
  beforeEach(() => {
    analyzeStore.mockResolvedValue({
      problems: [
        { code: 'titleLength', items: [{ id, type: 'collection' }] },
        { code: 'seoTitleMissing', items: [{ id, type: 'collection' }] },
        { code: 'metaDescriptionMissing', items: [{ id, type: 'collection' }] },
      ],
    });
  });

  it('writes every changed field in ONE updateContent with all keys in changedFields', async () => {
    const { db, taskUpdates } = makeDb([id]);
    const res = await handleSeoBulkFix(
      ctxFor(db, { fixAllForItem: 'true', itemId: id, itemType: 'collection' }),
    );
    expect((res as any).data?.success ?? (res as any).success).toBe(true);
    const final = await finalUpdate(taskUpdates);

    expect(updateContent).toHaveBeenCalledTimes(1);
    const call = updateContent.mock.calls[0][0];
    expect([...call.changedFields].sort()).toEqual(['metaDescription', 'seoTitle', 'title']);
    expect(Object.keys(call.updates).sort()).toEqual(['metaDescription', 'seoTitle', 'title']);
    expect(call.repairBudget).toBeDefined();

    const result = JSON.parse(final.result);
    expect(result.succeeded.map((s: { code: string }) => s.code).sort()).toEqual([
      'metaDescriptionMissing',
      'seoTitleMissing',
      'titleLength',
    ]);
    expect(result.failed).toEqual([]);
  });

  it('a refused save fails each of those codes - none is reported as written', async () => {
    updateContent.mockResolvedValue({ success: false, error: 'boom' });
    const { db, taskUpdates } = makeDb([id]);
    await handleSeoBulkFix(ctxFor(db, { fixAllForItem: 'true', itemId: id, itemType: 'collection' }));
    const final = await finalUpdate(taskUpdates);

    expect(updateContent).toHaveBeenCalledTimes(1);
    const result = JSON.parse(final.result);
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toHaveLength(3);
    expect(final.status).toBe('failed');
  });

  it('a product item goes through ONE handleUpdateProduct naming every field', async () => {
    const pid = 'gid://shopify/Product/9';
    analyzeStore.mockResolvedValue({
      problems: [
        { code: 'titleLength', items: [{ id: pid, type: 'product' }] },
        { code: 'seoTitleMissing', items: [{ id: pid, type: 'product' }] },
      ],
    });
    handleUpdateProduct.mockResolvedValue({ data: { success: true }, init: { status: 200 } });
    const { db, taskUpdates } = makeDb([]);
    db.product = {
      findMany: vi.fn().mockResolvedValue([
        { id: pid, title: 'Old', descriptionHtml: '', seoTitle: '', seoDescription: '' },
      ]),
    };
    await handleSeoBulkFix(ctxFor(db, { fixAllForItem: 'true', itemId: pid, itemType: 'product' }));
    await finalUpdate(taskUpdates);

    expect(handleUpdateProduct).toHaveBeenCalledTimes(1);
    const form = handleUpdateProduct.mock.calls[0][1] as FormData;
    expect(JSON.parse(String(form.get('changedFields'))).sort()).toEqual(['seoTitle', 'title']);
    expect(form.get('title')).toBe('Generated');
    expect(form.get('seoTitle')).toBe('Generated');
  });
});

describe('bulk run: one repair budget for the whole task', () => {
  it('hands the SAME budget (the bulk editor\'s cap) to every item and reports the overflow', async () => {
    const ids = Array.from({ length: MAX_REPAIR_GROUPS + 5 }, (_, i) => `gid://shopify/Collection/${i + 1}`);
    analyzeStore.mockResolvedValue({
      problems: [{ code: 'seoTitleMissing', items: ids.map((id) => ({ id, type: 'collection' })) }],
    });
    // Behave like the real save: ask the budget for the item's group.
    updateContent.mockImplementation(async (p: any) => {
      p.repairBudget.take('content', p.resourceId);
      return { success: true };
    });
    const { db, taskUpdates } = makeDb(ids);
    await handleSeoBulkFix(ctxFor(db, { problemCode: 'seoTitleMissing' }));
    const final = await finalUpdate(taskUpdates);

    expect(updateContent).toHaveBeenCalledTimes(ids.length);
    const budgets = new Set(updateContent.mock.calls.map((c) => c[0].repairBudget));
    expect(budgets.size).toBe(1);
    expect([...budgets][0].maxGroups).toBe(MAX_REPAIR_GROUPS);

    const result = JSON.parse(final.result);
    expect(result.succeeded).toHaveLength(ids.length);
    // The five items past the cap followed the stored deletion answer: reported.
    expect(result.retranslation).toEqual({ capped: 5 });
  });

  it('reports nothing extra when the budget was never exceeded', async () => {
    const ids = ['gid://shopify/Collection/1', 'gid://shopify/Collection/2'];
    analyzeStore.mockResolvedValue({
      problems: [{ code: 'seoTitleMissing', items: ids.map((id) => ({ id, type: 'collection' })) }],
    });
    updateContent.mockImplementation(async (p: any) => {
      p.repairBudget.take('content', p.resourceId);
      return { success: true };
    });
    const { db, taskUpdates } = makeDb(ids);
    await handleSeoBulkFix(ctxFor(db, { problemCode: 'seoTitleMissing' }));
    const final = await finalUpdate(taskUpdates);

    expect(JSON.parse(final.result).retranslation).toBeUndefined();
  });

  it('builds the editor content service on the GATEWAY (THROTTLED retries), never the raw client', async () => {
    const ids = ['gid://shopify/Collection/1'];
    analyzeStore.mockResolvedValue({
      problems: [{ code: 'seoTitleMissing', items: ids.map((id) => ({ id, type: 'collection' })) }],
    });
    const { db, taskUpdates } = makeDb(ids);
    await handleSeoBulkFix(ctxFor(db, { problemCode: 'seoTitleMissing' }));
    await finalUpdate(taskUpdates);

    expect(serviceCtorArgs.length).toBeGreaterThan(0);
    expect(serviceCtorArgs.every((c) => (c as { isGateway?: boolean }).isGateway === true)).toBe(true);
  });
});

describe('a failed shop-locale lookup fails ONCE, up front', () => {
  it('refuses the whole run (no Task, no AI spend) instead of failing every item', async () => {
    getCachedShopLocales.mockResolvedValue([]); // the swallowed-error shape
    const { db } = makeDb(['gid://shopify/Collection/1']);
    const res = (await handleSeoBulkFix(ctxFor(db, { problemCode: 'seoTitleMissing' }))) as any;

    expect(res.init?.status).toBe(400);
    expect(String(res.data?.error)).toMatch(/languages could not be loaded/);
    expect(db.task.create).not.toHaveBeenCalled();
    expect(updateContent).not.toHaveBeenCalled();
  });
});
