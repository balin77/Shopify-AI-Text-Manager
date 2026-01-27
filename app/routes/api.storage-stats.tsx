/**
 * API Route: Storage Statistics
 *
 * Returns the database storage usage per content type in bytes/MB for the current shop
 */

import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { db } from '~/db.server';

export interface StorageStats {
  products: number;
  collections: number;
  articles: number;
  pages: number;
  policies: number;
  themeContent: number;
  translations: number;
  total: number;
}

// Helper to calculate string byte size (UTF-8)
function getByteSize(str: string | null | undefined): number {
  if (!str) return 0;
  return new TextEncoder().encode(str).length;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  if (!session) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const shop = session.shop;

    // Calculate storage for Products
    const products = await db.product.findMany({
      where: { shop },
      select: {
        title: true,
        descriptionHtml: true,
        handle: true,
        seoTitle: true,
        seoDescription: true,
        featuredImageUrl: true,
        featuredImageAlt: true,
        images: {
          select: {
            url: true,
            altText: true,
            mediaId: true,
            altTextTranslations: {
              select: { altText: true, locale: true }
            }
          }
        },
        options: {
          select: { name: true, values: true }
        },
        metafields: {
          select: { namespace: true, key: true, value: true, type: true }
        }
      }
    });

    let productBytes = 0;
    for (const p of products) {
      productBytes += getByteSize(p.title);
      productBytes += getByteSize(p.descriptionHtml);
      productBytes += getByteSize(p.handle);
      productBytes += getByteSize(p.seoTitle);
      productBytes += getByteSize(p.seoDescription);
      productBytes += getByteSize(p.featuredImageUrl);
      productBytes += getByteSize(p.featuredImageAlt);
      for (const img of p.images) {
        productBytes += getByteSize(img.url);
        productBytes += getByteSize(img.altText);
        productBytes += getByteSize(img.mediaId);
        for (const trans of img.altTextTranslations) {
          productBytes += getByteSize(trans.altText);
          productBytes += getByteSize(trans.locale);
        }
      }
      for (const opt of p.options) {
        productBytes += getByteSize(opt.name);
        productBytes += getByteSize(opt.values);
      }
      for (const mf of p.metafields) {
        productBytes += getByteSize(mf.namespace);
        productBytes += getByteSize(mf.key);
        productBytes += getByteSize(mf.value);
        productBytes += getByteSize(mf.type);
      }
    }

    // Calculate storage for Collections
    const collections = await db.collection.findMany({
      where: { shop },
      select: {
        title: true,
        descriptionHtml: true,
        handle: true,
        seoTitle: true,
        seoDescription: true,
      }
    });

    let collectionBytes = 0;
    for (const c of collections) {
      collectionBytes += getByteSize(c.title);
      collectionBytes += getByteSize(c.descriptionHtml);
      collectionBytes += getByteSize(c.handle);
      collectionBytes += getByteSize(c.seoTitle);
      collectionBytes += getByteSize(c.seoDescription);
    }

    // Calculate storage for Articles
    const articles = await db.article.findMany({
      where: { shop },
      select: {
        title: true,
        body: true,
        handle: true,
        blogTitle: true,
        seoTitle: true,
        seoDescription: true,
      }
    });

    let articleBytes = 0;
    for (const a of articles) {
      articleBytes += getByteSize(a.title);
      articleBytes += getByteSize(a.body);
      articleBytes += getByteSize(a.handle);
      articleBytes += getByteSize(a.blogTitle);
      articleBytes += getByteSize(a.seoTitle);
      articleBytes += getByteSize(a.seoDescription);
    }

    // Calculate storage for Pages
    const pages = await db.page.findMany({
      where: { shop },
      select: {
        title: true,
        body: true,
        handle: true,
      }
    });

    let pageBytes = 0;
    for (const p of pages) {
      pageBytes += getByteSize(p.title);
      pageBytes += getByteSize(p.body);
      pageBytes += getByteSize(p.handle);
    }

    // Calculate storage for Policies
    const policies = await db.shopPolicy.findMany({
      where: { shop },
      select: {
        title: true,
        body: true,
        type: true,
        url: true,
      }
    });

    let policyBytes = 0;
    for (const p of policies) {
      policyBytes += getByteSize(p.title);
      policyBytes += getByteSize(p.body);
      policyBytes += getByteSize(p.type);
      policyBytes += getByteSize(p.url);
    }

    // Calculate storage for Theme Content
    const themeContent = await db.themeContent.findMany({
      where: { shop },
      select: {
        resourceId: true,
        resourceType: true,
        resourceTypeLabel: true,
        groupId: true,
        groupName: true,
        groupIcon: true,
        translatableContent: true,
      }
    });

    let themeContentBytes = 0;
    for (const tc of themeContent) {
      themeContentBytes += getByteSize(tc.resourceId);
      themeContentBytes += getByteSize(tc.resourceType);
      themeContentBytes += getByteSize(tc.resourceTypeLabel);
      themeContentBytes += getByteSize(tc.groupId);
      themeContentBytes += getByteSize(tc.groupName);
      themeContentBytes += getByteSize(tc.groupIcon);
      themeContentBytes += getByteSize(JSON.stringify(tc.translatableContent));
    }

    // Calculate storage for Theme Translations
    const themeTranslations = await db.themeTranslation.findMany({
      where: { shop },
      select: {
        key: true,
        value: true,
        locale: true,
      }
    });

    for (const tt of themeTranslations) {
      themeContentBytes += getByteSize(tt.key);
      themeContentBytes += getByteSize(tt.value);
      themeContentBytes += getByteSize(tt.locale);
    }

    // Calculate storage for Content Translations (all resource types)
    const productIds = products.length > 0
      ? await db.product.findMany({ where: { shop }, select: { id: true } })
      : [];
    const collectionIds = await db.collection.findMany({ where: { shop }, select: { id: true } });
    const articleIds = await db.article.findMany({ where: { shop }, select: { id: true } });
    const pageIds = await db.page.findMany({ where: { shop }, select: { id: true } });
    const policyIds = await db.shopPolicy.findMany({ where: { shop }, select: { id: true } });

    const allResourceIds = [
      ...productIds.map(p => p.id),
      ...collectionIds.map(c => c.id),
      ...articleIds.map(a => a.id),
      ...pageIds.map(p => p.id),
      ...policyIds.map(p => p.id),
    ];

    let translationBytes = 0;
    if (allResourceIds.length > 0) {
      const contentTranslations = await db.contentTranslation.findMany({
        where: { resourceId: { in: allResourceIds } },
        select: {
          key: true,
          value: true,
          locale: true,
        }
      });

      for (const ct of contentTranslations) {
        translationBytes += getByteSize(ct.key);
        translationBytes += getByteSize(ct.value);
        translationBytes += getByteSize(ct.locale);
      }
    }

    const stats: StorageStats = {
      products: productBytes,
      collections: collectionBytes,
      articles: articleBytes,
      pages: pageBytes,
      policies: policyBytes,
      themeContent: themeContentBytes,
      translations: translationBytes,
      total: productBytes + collectionBytes + articleBytes + pageBytes + policyBytes + themeContentBytes + translationBytes,
    };

    return json({
      success: true,
      stats,
      // Also return in MB for convenience
      statsMB: {
        products: Number((productBytes / (1024 * 1024)).toFixed(3)),
        collections: Number((collectionBytes / (1024 * 1024)).toFixed(3)),
        articles: Number((articleBytes / (1024 * 1024)).toFixed(3)),
        pages: Number((pageBytes / (1024 * 1024)).toFixed(3)),
        policies: Number((policyBytes / (1024 * 1024)).toFixed(3)),
        themeContent: Number((themeContentBytes / (1024 * 1024)).toFixed(3)),
        translations: Number((translationBytes / (1024 * 1024)).toFixed(3)),
        total: Number(((productBytes + collectionBytes + articleBytes + pageBytes + policyBytes + themeContentBytes + translationBytes) / (1024 * 1024)).toFixed(3)),
      }
    });
  } catch (error) {
    console.error('Error calculating storage stats:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to calculate storage stats' },
      { status: 500 }
    );
  }
};
