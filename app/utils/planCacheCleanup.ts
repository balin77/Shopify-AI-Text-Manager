/**
 * Plan Cache Cleanup Utility
 * Handles database cache cleanup when switching plans
 */

import { db } from "../db.server";
import { getPlanLimits, type Plan } from "../config/plans";

export interface CleanupStats {
  deletedProducts: number;
  deletedProductImages: number;
  deletedProductOptions: number;
  deletedProductMetafields: number;
  deletedProductTranslations: number;
  deletedArticles: number;
  deletedPages: number;
  deletedPolicies: number;
  deletedThemeContent: number;
  deletedThemeTranslations: number;
  deletedContentTranslations: number;
}

/**
 * Clean up database cache based on the new plan limits
 */
export async function cleanupCacheForPlan(shop: string, newPlan: Plan): Promise<CleanupStats> {
  const limits = getPlanLimits(newPlan);
  const stats: CleanupStats = {
    deletedProducts: 0,
    deletedProductImages: 0,
    deletedProductOptions: 0,
    deletedProductMetafields: 0,
    deletedProductTranslations: 0,
    deletedArticles: 0,
    deletedPages: 0,
    deletedPolicies: 0,
    deletedThemeContent: 0,
    deletedThemeTranslations: 0,
    deletedContentTranslations: 0,
  };

  console.log(`[PlanCleanup] Starting cleanup for shop ${shop} → ${newPlan}`);

  // 1. Delete products over limit
  if (limits.maxProducts !== Infinity) {
    stats.deletedProducts = await deleteProductsOverLimit(shop, limits.maxProducts);
  }

  // 2. Delete product-related data if cache is disabled
  if (!limits.cacheEnabled.productImages || limits.productImages === "featured-only") {
    stats.deletedProductImages = await deleteNonFeaturedImages(shop);
  }

  if (!limits.cacheEnabled.productOptions) {
    stats.deletedProductOptions = await deleteProductOptions(shop);
  }

  if (!limits.cacheEnabled.productMetafields) {
    stats.deletedProductMetafields = await deleteProductMetafields(shop);
  }

  // 3. Delete content types not allowed in plan
  if (!limits.cacheEnabled.articles) {
    const { articles, translations } = await deleteArticles(shop);
    stats.deletedArticles = articles;
    stats.deletedContentTranslations += translations;
  }

  if (!limits.cacheEnabled.pages) {
    const { pages, translations } = await deletePages(shop);
    stats.deletedPages = pages;
    stats.deletedContentTranslations += translations;
  }

  if (!limits.cacheEnabled.policies) {
    const { policies, translations } = await deletePolicies(shop);
    stats.deletedPolicies = policies;
    stats.deletedContentTranslations += translations;
  }

  if (!limits.cacheEnabled.themes) {
    const { themeContent, themeTranslations } = await deleteThemeContent(shop);
    stats.deletedThemeContent = themeContent;
    stats.deletedThemeTranslations = themeTranslations;
  }

  console.log(`[PlanCleanup] Cleanup complete:`, stats);

  return stats;
}

/**
 * Delete products over the specified limit (keep oldest products)
 */
async function deleteProductsOverLimit(shop: string, maxProducts: number): Promise<number> {
  // Get products sorted by lastSyncedAt (oldest first)
  const products = await db.product.findMany({
    where: { shop },
    orderBy: { lastSyncedAt: "asc" },
    select: { id: true },
  });

  if (products.length <= maxProducts) {
    return 0; // No need to delete
  }

  const productsToDelete = products.slice(maxProducts);
  const productIds = productsToDelete.map((p) => p.id);

  // Delete products (cascade will handle related data)
  await db.product.deleteMany({
    where: {
      shop,
      id: { in: productIds },
    },
  });

  return productIds.length;
}

/**
 * Delete all product images except featured images
 */
async function deleteNonFeaturedImages(shop: string): Promise<number> {
  const result = await db.productImage.deleteMany({
    where: {
      product: {
        shop,
      },
    },
  });

  return result.count;
}

/**
 * Delete all product options
 */
async function deleteProductOptions(shop: string): Promise<number> {
  const result = await db.productOption.deleteMany({
    where: {
      product: {
        shop,
      },
    },
  });

  return result.count;
}

/**
 * Delete all product metafields
 */
async function deleteProductMetafields(shop: string): Promise<number> {
  const result = await db.productMetafield.deleteMany({
    where: {
      product: {
        shop,
      },
    },
  });

  return result.count;
}

/**
 * Delete all articles and their translations
 */
async function deleteArticles(shop: string): Promise<{ articles: number; translations: number }> {
  // Get article IDs first
  const articles = await db.article.findMany({
    where: { shop },
    select: { id: true },
  });

  const articleIds = articles.map((a) => a.id);

  // Delete content translations for articles
  const translationResult = await db.contentTranslation.deleteMany({
    where: {
      resourceType: "Article",
      resourceId: { in: articleIds },
    },
  });

  // Delete articles
  const articleResult = await db.article.deleteMany({
    where: { shop },
  });

  return {
    articles: articleResult.count,
    translations: translationResult.count,
  };
}

/**
 * Delete all pages and their translations
 */
async function deletePages(shop: string): Promise<{ pages: number; translations: number }> {
  const pages = await db.page.findMany({
    where: { shop },
    select: { id: true },
  });

  const pageIds = pages.map((p) => p.id);

  const translationResult = await db.contentTranslation.deleteMany({
    where: {
      resourceType: "Page",
      resourceId: { in: pageIds },
    },
  });

  const pageResult = await db.page.deleteMany({
    where: { shop },
  });

  return {
    pages: pageResult.count,
    translations: translationResult.count,
  };
}

/**
 * Delete all shop policies and their translations
 */
async function deletePolicies(shop: string): Promise<{ policies: number; translations: number }> {
  const policies = await db.shopPolicy.findMany({
    where: { shop },
    select: { id: true },
  });

  const policyIds = policies.map((p) => p.id);

  const translationResult = await db.contentTranslation.deleteMany({
    where: {
      resourceType: "ShopPolicy",
      resourceId: { in: policyIds },
    },
  });

  const policyResult = await db.shopPolicy.deleteMany({
    where: { shop },
  });

  return {
    policies: policyResult.count,
    translations: translationResult.count,
  };
}

/**
 * Delete all theme content and translations
 */
async function deleteThemeContent(
  shop: string
): Promise<{ themeContent: number; themeTranslations: number }> {
  const themeTranslationResult = await db.themeTranslation.deleteMany({
    where: { shop },
  });

  const themeContentResult = await db.themeContent.deleteMany({
    where: { shop },
  });

  return {
    themeContent: themeContentResult.count,
    themeTranslations: themeTranslationResult.count,
  };
}

/**
 * Get current cache statistics for a shop
 */
export async function getCacheStats(shop: string) {
  const [
    productCount,
    productImageCount,
    productOptionCount,
    productMetafieldCount,
    collectionCount,
    articleCount,
    pageCount,
    policyCount,
    themeContentCount,
  ] = await Promise.all([
    db.product.count({ where: { shop } }),
    db.productImage.count({ where: { product: { shop } } }),
    db.productOption.count({ where: { product: { shop } } }),
    db.productMetafield.count({ where: { product: { shop } } }),
    db.collection.count({ where: { shop } }),
    db.article.count({ where: { shop } }),
    db.page.count({ where: { shop } }),
    db.shopPolicy.count({ where: { shop } }),
    db.themeContent.count({ where: { shop } }),
  ]);

  return {
    products: productCount,
    productImages: productImageCount,
    productOptions: productOptionCount,
    productMetafields: productMetafieldCount,
    collections: collectionCount,
    articles: articleCount,
    pages: pageCount,
    policies: policyCount,
    themeContent: themeContentCount,
  };
}
