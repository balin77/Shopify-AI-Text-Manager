/**
 * "Fix with AI" (SEO bulk fix) changes PRIMARY text, so it owes the same
 * follow-up the single editor runs: the foreign translations of that text are
 * purged or re-translated per the merchant's policy, market overrides included.
 * It used to write through its own mutations and mirror the cache, and no
 * translation repair ever ran for it.
 *
 * The follow-up is not re-implemented in the handler: products go through the
 * product editor's `handleUpdateProduct` and collections / pages / articles
 * through `ShopifyContentService.updateContent`. What has to stay true is that
 * the handler routes each type through those, names the changed field, and
 * refuses to write when the primary locale is unknown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handleUpdateProduct = vi.fn();
const updateContent = vi.fn();

vi.mock('~/actions/product/update.actions', () => ({
  handleUpdateProduct: (...a: unknown[]) => handleUpdateProduct(...a),
}));
vi.mock('../../src/services/shopify-content.service', () => ({
  ShopifyContentService: class {
    updateContent(...a: unknown[]) {
      return updateContent(...a);
    }
  },
}));

import { persistField, persistImageAltText } from '../../app/routes/api-ai-handlers/seo-bulk-fix.handler';

const admin = { graphql: vi.fn() } as never;
const db = {} as never;
const base = {
  db,
  shop: 'shop.myshopify.com',
  admin,
  gateway: {} as never,
  contentService: {} as never,
  primaryLocale: 'de',
};

function ok(body: Record<string, unknown> = { success: true }) {
  return { data: body, init: { status: 200 } };
}

beforeEach(() => {
  handleUpdateProduct.mockReset();
  updateContent.mockReset();
  handleUpdateProduct.mockResolvedValue(ok());
  updateContent.mockResolvedValue({ success: true });
});

describe('persistField routes a primary write through the editor save paths', () => {
  it('product: one partial save naming the changed field, as a primary-locale write', async () => {
    await persistField({ ...base, type: 'product', id: 'gid://shopify/Product/1', field: 'description', value: '<p>x</p>' });

    expect(handleUpdateProduct).toHaveBeenCalledTimes(1);
    const [ctx, form, id] = handleUpdateProduct.mock.calls[0];
    expect(ctx.session.shop).toBe('shop.myshopify.com');
    expect(id).toBe('gid://shopify/Product/1');
    expect((form as FormData).get('locale')).toBe('de');
    expect((form as FormData).get('primaryLocale')).toBe('de');
    expect((form as FormData).get('descriptionHtml')).toBe('<p>x</p>');
    expect((form as FormData).get('title')).toBeNull();
    expect(JSON.parse(String((form as FormData).get('changedFields')))).toEqual(['description']);
  });

  it('product: a refused write (e.g. no echo) is a failure, never a success', async () => {
    handleUpdateProduct.mockResolvedValue(ok({ success: false, error: 'Shopify did not confirm the product update' }));
    await expect(
      persistField({ ...base, type: 'product', id: 'gid://shopify/Product/1', field: 'title', value: 'T' }),
    ).rejects.toThrow(/did not confirm/);
  });

  it.each([
    ['collection', 'Collection', 'description', 'description'],
    ['page', 'Page', 'description', 'description'],
    ['article', 'Article', 'description', 'body'],
    ['article', 'Article', 'metaDescription', 'metaDescription'],
  ] as const)('%s: updateContent with the field as the ONLY change (%s %s -> %s)', async (type, resourceType, field, key) => {
    await persistField({ ...base, type, id: 'gid://x/1', field, value: 'V' });

    expect(updateContent).toHaveBeenCalledTimes(1);
    expect(updateContent.mock.calls[0][0]).toMatchObject({
      resourceId: 'gid://x/1',
      resourceType,
      locale: 'de',
      primaryLocale: 'de',
      updates: { [key]: 'V' },
      changedFields: [field],
    });
  });

  it('collection / page / article: an updateContent failure is a failure', async () => {
    updateContent.mockResolvedValue({ success: false, error: 'boom' });
    await expect(
      persistField({ ...base, type: 'page', id: 'gid://x/1', field: 'title', value: 'T' }),
    ).rejects.toThrow('boom');
  });

  it('refuses to write at all when the primary locale is unknown (the follow-up could not be decided)', async () => {
    await expect(
      persistField({ ...base, primaryLocale: '', type: 'collection', id: 'gid://x/1', field: 'title', value: 'T' }),
    ).rejects.toThrow(/primary language/);
    expect(updateContent).not.toHaveBeenCalled();
    expect(handleUpdateProduct).not.toHaveBeenCalled();
  });
});

describe('persistImageAltText: a collection / article featured alt rides updateContent', () => {
  it.each([
    ['collection', 'Collection'],
    ['article', 'Article'],
  ] as const)('%s: featured alt is index 0 with no field change', async (type, resourceType) => {
    await persistImageAltText({
      ...base,
      job: { type, id: 'gid://x/9', imageUrl: 'https://cdn.example/a.jpg' },
      altText: 'Ein Stuhl',
    });

    expect(updateContent.mock.calls[0][0]).toMatchObject({
      resourceId: 'gid://x/9',
      resourceType,
      updates: { imageAltText: 'Ein Stuhl' },
      changedAltTextIndices: [0],
      changedFields: [],
    });
  });

  it('an unconfirmed alt (updateContent refuses on the echo) is a failure', async () => {
    updateContent.mockRejectedValue(new Error('Shopify did not confirm the image alt text'));
    await expect(
      persistImageAltText({
        ...base,
        job: { type: 'collection', id: 'gid://x/9', imageUrl: 'https://cdn.example/a.jpg' },
        altText: 'Ein Stuhl',
      }),
    ).rejects.toThrow(/did not confirm/);
  });
});
