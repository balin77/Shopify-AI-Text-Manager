/**
 * Plan Cache Cleanup Utility
 * Handles database cache cleanup when switching plans
 */

import { db } from "../db.server";
import { type Plan } from "../config/plans";
import { getPlanLimits, getSyncScope } from "./planUtils";
import { logger } from "./logger.server";

export interface CleanupStats {
  deletedProducts: number;
  deletedProductImages: number;
  deletedProductOptions: number;
  deletedProductMetafields: number;
  deletedProductTranslations: number;
  deletedCollections: number;
  deletedArticles: number;
  deletedPages: number;
  deletedPolicies: number;
  deletedThemeContent: number;
  deletedThemeTranslations: number;
  deletedContentTranslations: number;
  deletedMenus: number;
  deletedMetaobjects: number;
  deletedMediaLibraryImages: number;
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
    deletedCollections: 0,
    deletedArticles: 0,
    deletedPages: 0,
    deletedPolicies: 0,
    deletedThemeContent: 0,
    deletedThemeTranslations: 0,
    deletedContentTranslations: 0,
    deletedMenus: 0,
    deletedMetaobjects: 0,
    deletedMediaLibraryImages: 0,
  };

  // Single source of truth — same scope the sync uses, so cleanup and sync can
  // never disagree about which content types a plan is entitled to.
  const scope = getSyncScope(newPlan);

  logger.info(`[PlanCleanup] Starting cleanup for shop ${shop} → ${newPlan}`);

  // 1. Delete products over limit
  if (limits.maxProducts !== Infinity) {
    stats.deletedProducts = await deleteProductsOverLimit(shop, limits.maxProducts);
  }

  // 2. Delete product-related data if cache is disabled
  if (!limits.cacheEnabled.productImages || limits.productImages === "featured-only") {
    stats.deletedProductImages = await deleteNonFeaturedImages(shop);
  }

  // Die Bildbibliothek (MediaImage-Cache) hängt am selben Flag wie die
  // Produktbilder. "featured-only" betrifft nur Produktgalerien — die
  // Dateien-Bibliothek kennt kein Featured-Bild, deshalb hier nur das Flag.
  if (!limits.cacheEnabled.productImages) {
    stats.deletedMediaLibraryImages = await deleteMediaLibraryCache(shop);
  }

  if (!limits.cacheEnabled.productOptions) {
    stats.deletedProductOptions = await deleteProductOptions(shop);
  }

  if (!limits.cacheEnabled.productMetafields) {
    stats.deletedProductMetafields = await deleteProductMetafields(shop);
  }

  // 3. Delete collections over limit
  const { collections, collectionTranslations } = await deleteCollectionsOverLimit(shop, limits.maxCollections);
  stats.deletedCollections = collections;
  stats.deletedContentTranslations += collectionTranslations;

  // 4. Delete articles over limit or entirely if disabled
  if (!limits.cacheEnabled.articles || limits.maxArticles === 0) {
    const { articles, translations } = await deleteArticles(shop);
    stats.deletedArticles = articles;
    stats.deletedContentTranslations += translations;
  } else if (limits.maxArticles > 0) {
    const { articles, translations } = await deleteArticlesOverLimit(shop, limits.maxArticles);
    stats.deletedArticles = articles;
    stats.deletedContentTranslations += translations;
  }

  // 5. Delete pages over limit or entirely if disabled
  if (!limits.cacheEnabled.pages || limits.maxPages === 0) {
    const { pages, translations } = await deletePages(shop);
    stats.deletedPages = pages;
    stats.deletedContentTranslations += translations;
  } else if (limits.maxPages > 0) {
    const { pages, translations } = await deletePagesOverLimit(shop, limits.maxPages);
    stats.deletedPages = pages;
    stats.deletedContentTranslations += translations;
  }

  // 6. Delete policies if disabled
  if (!limits.cacheEnabled.policies) {
    const { policies, translations } = await deletePolicies(shop);
    stats.deletedPolicies = policies;
    stats.deletedContentTranslations += translations;
  }

  // 7. Delete theme content if disabled or over limit
  if (!limits.cacheEnabled.themes || limits.maxThemeTranslations === 0) {
    const { themeContent, themeTranslations } = await deleteThemeContent(shop);
    stats.deletedThemeContent = themeContent;
    stats.deletedThemeTranslations = themeTranslations;
  } else if (limits.maxThemeTranslations > 0) {
    stats.deletedThemeTranslations = await deleteThemeTranslationsOverLimit(shop, limits.maxThemeTranslations);
  }

  // 7b. Delivery domain (Basic+) — pruned only where the plan is not entitled
  // (i.e. Free). It shares the ThemeContent tables but is NOT covered by the
  // themes (Pro+) prune above, so it survives a Pro→Basic downgrade correctly.
  if (!limits.contentTypes.includes("delivery")) {
    const r = await deleteThemeDomain(shop, "delivery");
    stats.deletedThemeContent += r.themeContent;
    stats.deletedThemeTranslations += r.themeTranslations;
  }

  // 8. Delete menus if the plan is no longer entitled (no per-item cap)
  if (!scope.menus.enabled) {
    stats.deletedMenus = await deleteMenus(shop);
  }

  // 9. Delete metaobjects + definitions + translations if not entitled
  if (!scope.metaobjects.enabled) {
    stats.deletedMetaobjects = await deleteMetaobjects(shop);
  }

  logger.info(`[PlanCleanup] Cleanup complete:`, stats);

  return stats;
}

/**
 * Delete all menus (menus have no ContentTranslation rows).
 */
async function deleteMenus(shop: string): Promise<number> {
  const result = await db.menu.deleteMany({ where: { shop } });
  return result.count;
}

/**
 * Delete all metaobjects, their translations and definitions (transaction).
 */
async function deleteMetaobjects(shop: string): Promise<number> {
  const { metaobjectsCount } = await db.$transaction(async (tx) => {
    await tx.metaobjectTranslation.deleteMany({ where: { shop } });
    const mo = await tx.metaobject.deleteMany({ where: { shop } });
    await tx.metaobjectDefinition.deleteMany({ where: { shop } });
    return { metaobjectsCount: mo.count };
  });
  return metaobjectsCount;
}

/**
 * Delete products over the specified limit (keep newest products)
 */
async function deleteProductsOverLimit(shop: string, maxProducts: number): Promise<number> {
  // Get products sorted by lastSyncedAt (newest first)
  const products = await db.product.findMany({
    where: { shop },
    orderBy: { lastSyncedAt: "desc" },
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
 * Delete the media-library cache and its sync marker.
 *
 * Beides zusammen in einer Transaktion, damit nie ein "vollständig
 * synchronisiert"-Marker ohne Bilder zurückbleibt (der Loader würde sonst
 * `neverSynced: false` bei leerer Liste melden und der Editor keinen
 * Sync-Hinweis anzeigen).
 */
async function deleteMediaLibraryCache(shop: string): Promise<number> {
  const { imagesCount } = await db.$transaction(async (tx) => {
    const images = await tx.mediaLibraryImage.deleteMany({ where: { shop } });
    await tx.mediaLibrarySyncState.deleteMany({ where: { shop } });
    return { imagesCount: images.count };
  });
  return imagesCount;
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
 * Delete all articles and their translations (using transaction for consistency)
 */
async function deleteArticles(shop: string): Promise<{ articles: number; translations: number }> {
  // Get article IDs first
  const articles = await db.article.findMany({
    where: { shop },
    select: { id: true },
  });

  const articleIds = articles.map((a) => a.id);

  // Use transaction to ensure both deletes succeed or fail together
  const { translationsCount, articlesCount } = await db.$transaction(async (tx) => {
    // Delete content translations for articles
    const translationResult = await tx.contentTranslation.deleteMany({
      where: {
        shop,
        resourceType: "Article",
        resourceId: { in: articleIds },
      },
    });

    // Delete articles
    const articleResult = await tx.article.deleteMany({
      where: { shop },
    });

    return {
      translationsCount: translationResult.count,
      articlesCount: articleResult.count,
    };
  });

  return {
    articles: articlesCount,
    translations: translationsCount,
  };
}

/**
 * Delete all pages and their translations (using transaction for consistency)
 */
async function deletePages(shop: string): Promise<{ pages: number; translations: number }> {
  const pages = await db.page.findMany({
    where: { shop },
    select: { id: true },
  });

  const pageIds = pages.map((p) => p.id);

  // Use transaction to ensure both deletes succeed or fail together
  const { translationsCount, pagesCount } = await db.$transaction(async (tx) => {
    const translationResult = await tx.contentTranslation.deleteMany({
      where: {
        shop,
        resourceType: "Page",
        resourceId: { in: pageIds },
      },
    });

    const pageResult = await tx.page.deleteMany({
      where: { shop },
    });

    return {
      translationsCount: translationResult.count,
      pagesCount: pageResult.count,
    };
  });

  return {
    pages: pagesCount,
    translations: translationsCount,
  };
}

/**
 * Delete all shop policies and their translations (using transaction for consistency)
 */
async function deletePolicies(shop: string): Promise<{ policies: number; translations: number }> {
  const policies = await db.shopPolicy.findMany({
    where: { shop },
    select: { id: true },
  });

  const policyIds = policies.map((p) => p.id);

  // Use transaction to ensure both deletes succeed or fail together
  const { translationsCount, policiesCount } = await db.$transaction(async (tx) => {
    const translationResult = await tx.contentTranslation.deleteMany({
      where: {
        shop,
        resourceType: "ShopPolicy",
        resourceId: { in: policyIds },
      },
    });

    const policyResult = await tx.shopPolicy.deleteMany({
      where: { shop },
    });

    return {
      translationsCount: translationResult.count,
      policiesCount: policyResult.count,
    };
  });

  return {
    policies: policiesCount,
    translations: translationsCount,
  };
}

/**
 * Delete all theme content and translations (using transaction for consistency)
 */
async function deleteThemeContent(
  shop: string
): Promise<{ themeContent: number; themeTranslations: number }> {
  // The ThemeContent / ThemeTranslation tables hold four domains. This prune runs
  // when the plan loses the themes (Pro+) entitlement, which also gates the
  // "system" and "selling_plans" domains — so those are pruned too. The
  // "online_store_extras" domain (Filter + Shop-Metadaten) is entitled on EVERY
  // tier and must be kept.
  const PRUNE_DOMAINS = ["theme", "system", "selling_plans"];
  // Use transaction to ensure both deletes succeed or fail together
  const { themeTranslationsCount, themeContentCount } = await db.$transaction(async (tx) => {
    const themeTranslationResult = await tx.themeTranslation.deleteMany({
      where: { shop, domain: { in: PRUNE_DOMAINS } },
    });

    const themeContentResult = await tx.themeContent.deleteMany({
      where: { shop, domain: { in: PRUNE_DOMAINS } },
    });

    return {
      themeTranslationsCount: themeTranslationResult.count,
      themeContentCount: themeContentResult.count,
    };
  });

  return {
    themeContent: themeContentCount,
    themeTranslations: themeTranslationsCount,
  };
}

/**
 * Delete collections over the specified limit (keep newest collections)
 */
async function deleteCollectionsOverLimit(shop: string, maxCollections: number): Promise<{ collections: number; collectionTranslations: number }> {
  const collections = await db.collection.findMany({
    where: { shop },
    orderBy: { lastSyncedAt: "desc" },
    select: { id: true },
  });

  if (collections.length <= maxCollections) {
    return { collections: 0, collectionTranslations: 0 };
  }

  const collectionsToDelete = collections.slice(maxCollections);
  const collectionIds = collectionsToDelete.map((c) => c.id);

  const { translationsCount, collectionsCount } = await db.$transaction(async (tx) => {
    const translationResult = await tx.contentTranslation.deleteMany({
      where: {
        shop,
        resourceType: "Collection",
        resourceId: { in: collectionIds },
      },
    });

    const collectionResult = await tx.collection.deleteMany({
      where: {
        shop,
        id: { in: collectionIds },
      },
    });

    return {
      translationsCount: translationResult.count,
      collectionsCount: collectionResult.count,
    };
  });

  return {
    collections: collectionsCount,
    collectionTranslations: translationsCount,
  };
}

/**
 * Delete articles over the specified limit (keep newest articles)
 */
async function deleteArticlesOverLimit(shop: string, maxArticles: number): Promise<{ articles: number; translations: number }> {
  const articles = await db.article.findMany({
    where: { shop },
    orderBy: { lastSyncedAt: "desc" },
    select: { id: true },
  });

  if (articles.length <= maxArticles) {
    return { articles: 0, translations: 0 };
  }

  const articlesToDelete = articles.slice(maxArticles);
  const articleIds = articlesToDelete.map((a) => a.id);

  const { translationsCount, articlesCount } = await db.$transaction(async (tx) => {
    const translationResult = await tx.contentTranslation.deleteMany({
      where: {
        shop,
        resourceType: "Article",
        resourceId: { in: articleIds },
      },
    });

    const articleResult = await tx.article.deleteMany({
      where: {
        shop,
        id: { in: articleIds },
      },
    });

    return {
      translationsCount: translationResult.count,
      articlesCount: articleResult.count,
    };
  });

  return {
    articles: articlesCount,
    translations: translationsCount,
  };
}

/**
 * Delete pages over the specified limit (keep newest pages)
 */
async function deletePagesOverLimit(shop: string, maxPages: number): Promise<{ pages: number; translations: number }> {
  const pages = await db.page.findMany({
    where: { shop },
    orderBy: { lastSyncedAt: "desc" },
    select: { id: true },
  });

  if (pages.length <= maxPages) {
    return { pages: 0, translations: 0 };
  }

  const pagesToDelete = pages.slice(maxPages);
  const pageIds = pagesToDelete.map((p) => p.id);

  const { translationsCount, pagesCount } = await db.$transaction(async (tx) => {
    const translationResult = await tx.contentTranslation.deleteMany({
      where: {
        shop,
        resourceType: "Page",
        resourceId: { in: pageIds },
      },
    });

    const pageResult = await tx.page.deleteMany({
      where: {
        shop,
        id: { in: pageIds },
      },
    });

    return {
      translationsCount: translationResult.count,
      pagesCount: pageResult.count,
    };
  });

  return {
    pages: pagesCount,
    translations: translationsCount,
  };
}

/**
 * Delete all ThemeContent + ThemeTranslation rows for one domain (used to prune
 * a non-"theme" rubric whose entitlement the plan no longer grants).
 */
async function deleteThemeDomain(
  shop: string,
  domain: string
): Promise<{ themeContent: number; themeTranslations: number }> {
  const { themeTranslationsCount, themeContentCount } = await db.$transaction(async (tx) => {
    const t = await tx.themeTranslation.deleteMany({ where: { shop, domain } });
    const c = await tx.themeContent.deleteMany({ where: { shop, domain } });
    return { themeTranslationsCount: t.count, themeContentCount: c.count };
  });
  return { themeContent: themeContentCount, themeTranslations: themeTranslationsCount };
}

/**
 * Delete theme translations over the specified limit (keep newest)
 */
async function deleteThemeTranslationsOverLimit(shop: string, maxTranslations: number): Promise<number> {
  // The maxThemeTranslations cap governs the THEME domain only. Scope the prune
  // accordingly so it never deletes online_store_extras rows (entitled on every
  // tier) or the Pro-only system/selling_plans rows to satisfy a theme cap.
  const translations = await db.themeTranslation.findMany({
    where: { shop, domain: "theme" },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });

  if (translations.length <= maxTranslations) {
    return 0;
  }

  const translationsToDelete = translations.slice(maxTranslations);
  const translationIds = translationsToDelete.map((t) => t.id);

  const result = await db.themeTranslation.deleteMany({
    where: {
      shop,
      id: { in: translationIds },
    },
  });

  return result.count;
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
