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
 * translateAllContent() — a locale whose writes SHOPIFY refused must reach
 * `failedLocales`.
 *
 * The save stage used to discard `savePerLocaleBatch`'s `failed` list, so a run
 * where the AI succeeded and every `translationsRegister` came back with
 * `userErrors` was returned with `failedLocales: []` — the call sites in
 * translation.action.ts read that as `status: "completed"` and the merchant was
 * told it had worked. These pin the three answers the fix has to give:
 * refused ⇒ failed, saved ⇒ not failed, and a DELIBERATE skip ⇒ not failed.
 */
describe('ShopifyContentService.translateAllContent() — failure reporting', () => {
  const productId = 'gid://shopify/Product/42';

  /**
   * One admin mock for both documents the run uses: the digest query and the
   * register mutation. `registerResponse` decides what Shopify answers to the
   * write, which is the whole variable under test.
   */
  function makeTranslateAdmin(registerResponse: any) {
    const graphql = vi.fn().mockImplementation(async (document: string) => ({
      ok: true,
      json: async () => {
        if (document.includes('translationsRegister')) return registerResponse;
        return {
          data: {
            translatableResource: {
              translatableContent: [
                { key: 'body_html', digest: 'digest-body', value: 'Vase aus Ton' },
              ],
            },
          },
        };
      },
    }));
    return { graphql };
  }

  function makeDb() {
    return {
      $transaction: vi.fn(async (fn: any) => fn({ contentTranslation: { upsert: vi.fn() } })),
      contentTranslation: { upsert: vi.fn() },
    } as any;
  }

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

  it('reports nothing when Shopify accepts the writes', async () => {
    const admin = makeTranslateAdmin({
      data: { translationsRegister: { userErrors: [], translations: [{ locale: 'fr', key: 'body_html', value: 'x' }] } },
    });
    const service = new ShopifyContentService(admin as any);

    const result = await service.translateAllContent(params(admin, makeDb()) as any);

    expect(result.failedLocales).toEqual([]);
    expect(result.rejectedFields).toEqual({});
    expect(result.translations.fr.description).toBe('[fr] Vase aus Ton');
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
});
