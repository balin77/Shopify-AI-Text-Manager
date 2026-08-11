/**
 * API Route: Storage Statistics
 *
 * Returns the database storage usage per content type in bytes/MB for the current shop.
 * Uses PostgreSQL aggregate queries (octet_length) to avoid loading all records into memory.
 */

import type { LoaderFunctionArgs } from "react-router";
import { data as json } from "react-router";
import { authenticate } from '~/shopify.server';
import { db } from '~/db.server';
import { logger } from '~/utils/logger.server';

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

/** Extract a bigint sum result as a JS number */
function toNum(rows: Array<{ bytes: bigint | null }>): number {
  return Number(rows[0]?.bytes ?? 0);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  if (!session) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const shop = session.shop;

    // Run all aggregate queries in parallel — no records loaded into JS memory
    const [
      productMain,
      productImages,
      productImgTranslations,
      productOptions,
      productMetafields,
      collectionRows,
      articleRows,
      pageRows,
      policyRows,
      themeContentRows,
      themeTranslationRows,
      contentTranslationRows,
    ] = await Promise.all([
      // Products: main columns
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(title, '')) +
          octet_length(COALESCE("descriptionHtml", '')) +
          octet_length(COALESCE(handle, '')) +
          octet_length(COALESCE("seoTitle", '')) +
          octet_length(COALESCE("seoDescription", '')) +
          octet_length(COALESCE("featuredImageUrl", '')) +
          octet_length(COALESCE("featuredImageAlt", ''))
        ), 0)::bigint AS bytes
        FROM "Product" WHERE shop = ${shop}`,

      // Products: images
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(pi.url, '')) +
          octet_length(COALESCE(pi."altText", '')) +
          octet_length(COALESCE(pi."mediaId", ''))
        ), 0)::bigint AS bytes
        FROM "ProductImage" pi
        JOIN "Product" p ON p.id = pi."productId"
        WHERE p.shop = ${shop}`,

      // Products: image alt-text translations
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(pat."altText", '')) +
          octet_length(COALESCE(pat.locale, ''))
        ), 0)::bigint AS bytes
        FROM "ProductImageAltTranslation" pat
        JOIN "ProductImage" pi ON pi.id = pat."imageId"
        JOIN "Product" p ON p.id = pi."productId"
        WHERE p.shop = ${shop}`,

      // Products: options
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(po.name, '')) +
          octet_length(COALESCE(po.values, ''))
        ), 0)::bigint AS bytes
        FROM "ProductOption" po
        JOIN "Product" p ON p.id = po."productId"
        WHERE p.shop = ${shop}`,

      // Products: metafields
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(pm.namespace, '')) +
          octet_length(COALESCE(pm.key, '')) +
          octet_length(COALESCE(pm.value, '')) +
          octet_length(COALESCE(pm.type, ''))
        ), 0)::bigint AS bytes
        FROM "ProductMetafield" pm
        JOIN "Product" p ON p.id = pm."productId"
        WHERE p.shop = ${shop}`,

      // Collections
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(title, '')) +
          octet_length(COALESCE("descriptionHtml", '')) +
          octet_length(COALESCE(handle, '')) +
          octet_length(COALESCE("seoTitle", '')) +
          octet_length(COALESCE("seoDescription", ''))
        ), 0)::bigint AS bytes
        FROM "Collection" WHERE shop = ${shop}`,

      // Articles
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(title, '')) +
          octet_length(COALESCE(body, '')) +
          octet_length(COALESCE(handle, '')) +
          octet_length(COALESCE("blogTitle", '')) +
          octet_length(COALESCE("seoTitle", '')) +
          octet_length(COALESCE("seoDescription", ''))
        ), 0)::bigint AS bytes
        FROM "Article" WHERE shop = ${shop}`,

      // Pages
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(title, '')) +
          octet_length(COALESCE(body, '')) +
          octet_length(COALESCE(handle, ''))
        ), 0)::bigint AS bytes
        FROM "Page" WHERE shop = ${shop}`,

      // Policies
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(title, '')) +
          octet_length(COALESCE(body, '')) +
          octet_length(COALESCE(type, '')) +
          octet_length(COALESCE(url, ''))
        ), 0)::bigint AS bytes
        FROM "ShopPolicy" WHERE shop = ${shop}`,

      // Theme content + theme translatable JSON
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE("resourceId", '')) +
          octet_length(COALESCE("resourceType", '')) +
          octet_length(COALESCE("resourceTypeLabel", '')) +
          octet_length(COALESCE("groupId", '')) +
          octet_length(COALESCE("groupName", '')) +
          octet_length(COALESCE("groupIcon", '')) +
          octet_length(COALESCE("translatableContent"::text, ''))
        ), 0)::bigint AS bytes
        FROM "ThemeContent" WHERE shop = ${shop}`,

      // Theme translations
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(key, '')) +
          octet_length(COALESCE(value, '')) +
          octet_length(COALESCE(locale, ''))
        ), 0)::bigint AS bytes
        FROM "ThemeTranslation" WHERE shop = ${shop}`,

      // Content translations (polymorphic — join through all resource tables)
      db.$queryRaw<Array<{ bytes: bigint }>>`
        SELECT COALESCE(SUM(
          octet_length(COALESCE(ct.key, '')) +
          octet_length(COALESCE(ct.value, '')) +
          octet_length(COALESCE(ct.locale, ''))
        ), 0)::bigint AS bytes
        FROM "ContentTranslation" ct
        WHERE EXISTS (SELECT 1 FROM "Product"    r WHERE r.id = ct."resourceId" AND r.shop = ${shop})
           OR EXISTS (SELECT 1 FROM "Collection" r WHERE r.id = ct."resourceId" AND r.shop = ${shop})
           OR EXISTS (SELECT 1 FROM "Article"    r WHERE r.id = ct."resourceId" AND r.shop = ${shop})
           OR EXISTS (SELECT 1 FROM "Page"       r WHERE r.id = ct."resourceId" AND r.shop = ${shop})
           OR EXISTS (SELECT 1 FROM "ShopPolicy" r WHERE r.id = ct."resourceId" AND r.shop = ${shop})`,
    ]);

    const productBytes =
      toNum(productMain) +
      toNum(productImages) +
      toNum(productImgTranslations) +
      toNum(productOptions) +
      toNum(productMetafields);

    const collectionBytes = toNum(collectionRows);
    const articleBytes = toNum(articleRows);
    const pageBytes = toNum(pageRows);
    const policyBytes = toNum(policyRows);
    const themeContentBytes = toNum(themeContentRows) + toNum(themeTranslationRows);
    const translationBytes = toNum(contentTranslationRows);

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

    const toMB = (b: number) => Number((b / (1024 * 1024)).toFixed(3));

    return json({
      success: true,
      stats,
      statsMB: {
        products: toMB(productBytes),
        collections: toMB(collectionBytes),
        articles: toMB(articleBytes),
        pages: toMB(pageBytes),
        policies: toMB(policyBytes),
        themeContent: toMB(themeContentBytes),
        translations: toMB(translationBytes),
        total: toMB(stats.total),
      }
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error('Error calculating storage stats', { error: error instanceof Error ? error.message : String(error) });
    return json(
      { success: false, error: 'Failed to calculate storage stats.' },
      { status: 500 }
    );
  }
};
