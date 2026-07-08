/**
 * Content Sync Service
 *
 * Synchronizes content data (Collections, Articles) from Shopify to local PostgreSQL database
 * including all translations for all available locales.
 *
 * Note: Pages and Policies are NOT cached as they don't have webhook support and are rarely modified.
 */

import type { Prisma } from '@prisma/client';
import { logger } from '~/utils/logger.server';
import { isTranslationRecentlySaved } from '~/utils/translation-save-lock.server';
import type { ShopifyGraphQLClient, ShopLocale, GraphQLEdge, ResolvedTranslation, ProgressCallback } from './sync-types';
import type { MarketInfo } from '~/types/content-editor.types';
import { fetchShopLocales, fetchAllTranslations, fetchShopMarkets, fetchedMarketLayers } from './sync-utils';

/** Collection data from Shopify GraphQL */
interface ShopifyCollectionData {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string | null;
  updatedAt: string;
  image: {
    id: string | null;
    url: string;
    altText: string | null;
  } | null;
  seo: {
    title: string | null;
    description: string | null;
  } | null;
}

/** Article data from Shopify GraphQL */
interface ShopifyArticleData {
  id: string;
  title: string;
  handle: string;
  body: string | null;
  summary: string | null;
  updatedAt: string;
  image: {
    id: string | null;
    url: string;
    altText: string | null;
  } | null;
  blog: {
    id: string;
    title: string;
  } | null;
  seo?: {
    title: string | null;
    description: string | null;
  };
}

/** Menu data from Shopify GraphQL */
interface ShopifyMenuData {
  id: string;
  title: string;
  handle: string;
  items: unknown[];
}

export class ContentSyncService {
  /** Markets memo — loaded once per service instance (one instance ≈ one sync run). */
  private marketsPromise: Promise<MarketInfo[]> | null = null;

  constructor(
    private admin: ShopifyGraphQLClient,
    private shop: string
  ) {}

  /** Shop markets for the market-aware read-back; [] when scope/markets missing. */
  private getMarkets(): Promise<MarketInfo[]> {
    if (!this.marketsPromise) {
      this.marketsPromise = fetchShopMarkets(this.graphqlFn());
    }
    return this.marketsPromise;
  }

  // ============================================
  // COLLECTION SYNC
  // ============================================

  /**
   * Sync a single collection with all its translations
   */
  async syncCollection(collectionId: string, forceSync = false): Promise<void> {
    logger.debug(`[ContentSync] Starting sync for collection: ${collectionId}`);

    try {
      // 1. Fetch collection data
      const collectionData = await this.fetchCollectionData(collectionId);

      if (!collectionData) {
        logger.warn(`[ContentSync] Collection not found: ${collectionId}`);
        return;
      }

      // 2. Fetch all available locales + markets (market-aware read-back)
      const locales = await fetchShopLocales(this.graphqlFn());
      const markets = await this.getMarkets();
      logger.debug(`[ContentSync] Found ${locales.length} locales, ${markets.length} market(s)`);

      // 3. Fetch translations for all non-primary locales (global + market layers)
      const allTranslations = await fetchAllTranslations(this.graphqlFn(),
        collectionId,
        locales.filter((l) => !l.primary),
        "Collection",
        markets
      );
      logger.debug(`[ContentSync] Fetched ${allTranslations.length} translations`);

      // 3b. Fetch collection image alt-text translations (separate Shopify resource type).
      // The CollectionImage GID uses the image's OWN id, not the parent collection id.
      if (collectionData.image?.id) {
        const imageResourceId = collectionData.image.id;
        try {
          const imageTranslations = await fetchAllTranslations(this.graphqlFn(),
            imageResourceId,
            locales.filter((l) => !l.primary),
            "Collection", // Store under Collection resourceType with the parent's resourceId
            markets
          );
          // Remap: store with key "image_alt_text" and use the collection's resourceId
          for (const t of imageTranslations) {
            if (t.key === 'alt') {
              allTranslations.push({
                ...t,
                key: 'image_alt_text',
                resourceType: 'Collection',
              });
            }
          }
        } catch (imgErr) {
          logger.debug(`[ContentSync] Could not fetch CollectionImage translations (image may not exist)`, { collectionId });
        }
      }

      // 4. Save to database
      await this.saveCollectionToDatabase(collectionData, allTranslations, forceSync, markets);

      logger.debug(`[ContentSync] Successfully synced collection: ${collectionId}`);
    } catch (error) {
      logger.error(`[ContentSync] Error syncing collection ${collectionId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a collection from the database
   */
  async deleteCollection(collectionId: string): Promise<void> {
    logger.debug(`[ContentSync] Deleting collection: ${collectionId}`);

    const { db } = await import("../db.server");

    // Also remove polymorphic ContentTranslation rows (no FK/cascade —
    // resourceId is polymorphic). Atomic + idempotent: see deleteProduct.
    await db.$transaction([
      db.contentTranslation.deleteMany({
        where: { shop: this.shop, resourceId: collectionId },
      }),
      db.collection.deleteMany({
        where: { shop: this.shop, id: collectionId },
      }),
    ]);

    logger.debug(`[ContentSync] Successfully deleted collection: ${collectionId}`);
  }

  // ============================================
  // ARTICLE (BLOG) SYNC
  // ============================================

  /**
   * Sync a single article with all its translations
   */
  async syncArticle(articleId: string, forceSync = false): Promise<void> {
    logger.debug(`[ContentSync] Starting sync for article: ${articleId}`);

    try {
      // 1. Fetch article data
      const articleData = await this.fetchArticleData(articleId);

      if (!articleData) {
        logger.warn(`[ContentSync] Article not found: ${articleId}`);
        return;
      }

      // 2. Fetch all available locales + markets (market-aware read-back)
      const locales = await fetchShopLocales(this.graphqlFn());
      const markets = await this.getMarkets();

      // 3. Fetch translations (global + market layers)
      const allTranslations = await fetchAllTranslations(this.graphqlFn(),
        articleId,
        locales.filter((l) => !l.primary),
        "Article",
        markets
      );

      // 3b. Fetch article image alt-text translations (separate Shopify resource type).
      // The ArticleImage GID uses the image's OWN id, not the parent article id.
      if (articleData.image?.id) {
        const imageResourceId = articleData.image.id;
        try {
          const imageTranslations = await fetchAllTranslations(this.graphqlFn(),
            imageResourceId,
            locales.filter((l) => !l.primary),
            "Article",
            markets
          );
          for (const t of imageTranslations) {
            if (t.key === 'alt') {
              allTranslations.push({
                ...t,
                key: 'image_alt_text',
                resourceType: 'Article',
              });
            }
          }
        } catch (imgErr) {
          logger.debug(`[ContentSync] Could not fetch ArticleImage translations (image may not exist)`, { articleId });
        }
      }

      // 4. Save to database
      await this.saveArticleToDatabase(articleData, allTranslations, forceSync, markets);

      logger.debug(`[ContentSync] Successfully synced article: ${articleId}`);
    } catch (error) {
      logger.error(`[ContentSync] Error syncing article ${articleId}:`, error);
      throw error;
    }
  }

  /**
   * Delete an article from the database
   */
  async deleteArticle(articleId: string): Promise<void> {
    logger.debug(`[ContentSync] Deleting article: ${articleId}`);

    const { db } = await import("../db.server");

    // Also remove polymorphic ContentTranslation rows (no FK/cascade —
    // resourceId is polymorphic). Atomic + idempotent: see deleteProduct.
    await db.$transaction([
      db.contentTranslation.deleteMany({
        where: { shop: this.shop, resourceId: articleId },
      }),
      db.article.deleteMany({
        where: { shop: this.shop, id: articleId },
      }),
    ]);

    logger.debug(`[ContentSync] Successfully deleted article: ${articleId}`);
  }

  // ============================================
  // MENU SYNC
  // ============================================

  /**
   * Sync a single menu with its items structure
   */
  async syncMenu(menuId: string): Promise<void> {
    logger.debug(`[ContentSync] Starting sync for menu: ${menuId}`);

    try {
      // 1. Fetch menu data
      const menuData = await this.fetchMenuData(menuId);

      if (!menuData) {
        logger.warn(`[ContentSync] Menu not found: ${menuId}`);
        return;
      }

      // 2. Save to database (menus don't have translations via API)
      await this.saveMenuToDatabase(menuData);

      logger.debug(`[ContentSync] Successfully synced menu: ${menuId}`);
    } catch (error) {
      logger.error(`[ContentSync] Error syncing menu ${menuId}:`, error);
      throw error;
    }
  }

  /**
   * Delete a menu from the database
   */
  async deleteMenu(menuId: string): Promise<void> {
    logger.debug(`[ContentSync] Deleting menu: ${menuId}`);

    const { db } = await import("../db.server");

    await db.menu.delete({
      where: {
        shop_id: {
          shop: this.shop,
          id: menuId,
        },
      },
    });

    logger.debug(`[ContentSync] Successfully deleted menu: ${menuId}`);
  }


  // ============================================
  // FETCH DATA FROM SHOPIFY
  // ============================================

  private async fetchCollectionData(collectionId: string): Promise<ShopifyCollectionData | null> {
    const response = await this.admin.graphql(
      `#graphql
        query getCollection($id: ID!) {
          collection(id: $id) {
            id
            title
            handle
            descriptionHtml
            updatedAt
            image {
              id
              url
              altText
            }
            seo {
              title
              description
            }
          }
        }`,
      { variables: { id: collectionId } }
    );

    const data = await response.json();
    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in fetchCollectionData: ${data.errors[0].message}`);
    }
    return data.data?.collection || null;
  }

  private async fetchArticleData(articleId: string): Promise<ShopifyArticleData | null> {
    // Fetch article basic data
    const response = await this.admin.graphql(
      `#graphql
        query getArticle($id: ID!) {
          article(id: $id) {
            id
            title
            handle
            body
            summary
            updatedAt
            image {
              id
              url
              altText
            }
            blog {
              id
              title
            }
          }
        }`,
      { variables: { id: articleId } }
    );

    const data = await response.json();
    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in fetchArticleData: ${data.errors[0].message}`);
    }
    const article: ShopifyArticleData | null = data.data?.article || null;

    if (!article) return null;

    // Fetch SEO fields from translatableContent (they're not on the Article object directly)
    const translatableResponse = await this.admin.graphql(
      `#graphql
        query getArticleTranslatableContent($resourceId: ID!) {
          translatableResource(resourceId: $resourceId) {
            translatableContent {
              key
              value
            }
          }
        }`,
      { variables: { resourceId: articleId } }
    );

    const translatableData = await translatableResponse.json();
    if (translatableData.errors?.length > 0) {
      throw new Error(`GraphQL error in fetchArticleData (translatableContent): ${translatableData.errors[0].message}`);
    }
    const translatableContent: Array<{ key: string; value: string | null }> =
      translatableData.data?.translatableResource?.translatableContent || [];

    // Extract SEO fields from translatableContent
    // Article translatableContent keys: title, body_html, summary_html, meta_title, meta_description
    const seoTitle = translatableContent.find((c) => c.key === 'meta_title')?.value || null;
    const seoDescription = translatableContent.find((c) => c.key === 'meta_description')?.value || null;

    article.seo = {
      title: seoTitle,
      description: seoDescription,
    };

    return article;
  }

  private async fetchMenuData(menuId: string): Promise<ShopifyMenuData | null> {
    const response = await this.admin.graphql(
      `#graphql
        query getMenu($id: ID!) {
          menu(id: $id) {
            id
            title
            handle
            items {
              id
              title
              url
              type
              items {
                id
                title
                url
                type
                items {
                  id
                  title
                  url
                  type
                  items {
                    id
                    title
                    url
                    type
                  }
                }
              }
            }
          }
        }`,
      { variables: { id: menuId } }
    );

    const data = await response.json();
    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in fetchMenuData: ${data.errors[0].message}`);
    }
    return data.data?.menu || null;
  }


  private graphqlFn() {
    return this.admin.graphql.bind(this.admin);
  }

  // ============================================
  // SAVE TO DATABASE
  // ============================================

  private async saveCollectionToDatabase(collectionData: ShopifyCollectionData, translations: ResolvedTranslation[], forceSync = false, markets: MarketInfo[] = []) {
    const { db } = await import("../db.server");

    logger.debug(`[ContentSync] Saving collection to database: ${collectionData.id}`);

    // Prepare valid translations outside transaction
    const validTranslations = translations.filter(t => t.value != null && t.value !== undefined);
    const skippedCount = translations.length - validTranslations.length;
    if (skippedCount > 0) {
      logger.debug(`[ContentSync] Skipping ${skippedCount} translations with null/undefined values`);
    }

    // Use transaction to ensure all-or-nothing data consistency
    await db.$transaction(async (tx) => {
      // Upsert collection
      await tx.collection.upsert({
        where: {
          shop_id: {
            shop: this.shop,
            id: collectionData.id,
          },
        },
        create: {
          id: collectionData.id,
          shop: this.shop,
          title: collectionData.title,
          descriptionHtml: collectionData.descriptionHtml || "",
          handle: collectionData.handle,
          imageUrl: collectionData.image?.url || null,
          imageAltText: collectionData.image?.altText || null,
          seoTitle: collectionData.seo?.title || null,
          seoDescription: collectionData.seo?.description || null,
          shopifyUpdatedAt: new Date(collectionData.updatedAt),
          lastSyncedAt: new Date(),
        },
        update: {
          title: collectionData.title,
          descriptionHtml: collectionData.descriptionHtml || "",
          handle: collectionData.handle,
          imageUrl: collectionData.image?.url || null,
          imageAltText: collectionData.image?.altText || null,
          seoTitle: collectionData.seo?.title || null,
          seoDescription: collectionData.seo?.description || null,
          shopifyUpdatedAt: new Date(collectionData.updatedAt),
          lastSyncedAt: new Date(),
        },
      });

      // Check if user recently saved translations for this collection
      // Skip this check on manual reload (forceSync) - user explicitly wants fresh data
      if (!forceSync && isTranslationRecentlySaved(collectionData.id)) {
        logger.info(`[ContentSync] Skipping translation sync for collection - recently saved by user`, { collectionId: collectionData.id });
      } else {
        // Delete old translations — SCOPED to the layers this run actually
        // fetched (global + listed markets). If loadMarkets degraded to []
        // (missing scope / API error), existing market rows must survive.
        await tx.contentTranslation.deleteMany({
          where: {
            shop: this.shop,
            resourceId: collectionData.id,
            resourceType: "Collection",
            marketId: { in: fetchedMarketLayers(markets) },
          },
        });

        // Insert new translations
        if (validTranslations.length > 0) {
          await tx.contentTranslation.createMany({
            data: validTranslations.map(t => ({
              shop: this.shop,
              resourceId: collectionData.id,
              resourceType: "Collection",
              key: t.key,
              value: t.value,
              locale: t.locale,
              digest: t.digest || null,
              marketId: t.marketId || "",
            })),
          });
          logger.debug(`[ContentSync] ✓ Saved ${validTranslations.length} translations`);
        }
      }
    });

    logger.debug(`[ContentSync] ✓ Transaction completed successfully for collection ${collectionData.id}`);
  }

  private async saveArticleToDatabase(articleData: ShopifyArticleData, translations: ResolvedTranslation[], forceSync = false, markets: MarketInfo[] = []) {
    const { db } = await import("../db.server");

    logger.debug(`[ContentSync] Saving article to database: ${articleData.id}`);

    // Prepare valid translations outside transaction
    const validTranslations = translations.filter(t => t.value != null && t.value !== undefined);
    const skippedCount = translations.length - validTranslations.length;
    if (skippedCount > 0) {
      logger.debug(`[ContentSync] Skipping ${skippedCount} translations with null/undefined values`);
    }

    // Use transaction to ensure all-or-nothing data consistency
    await db.$transaction(async (tx) => {
      // Upsert article
      await tx.article.upsert({
        where: {
          shop_id: {
            shop: this.shop,
            id: articleData.id,
          },
        },
        create: {
          id: articleData.id,
          shop: this.shop,
          blogId: articleData.blog?.id || "",
          blogTitle: articleData.blog?.title || "",
          title: articleData.title,
          body: articleData.body || "",
          summary: articleData.summary || null,
          handle: articleData.handle,
          imageUrl: articleData.image?.url || null,
          imageAltText: articleData.image?.altText || null,
          seoTitle: articleData.seo?.title || null,
          seoDescription: articleData.seo?.description || null,
          shopifyUpdatedAt: new Date(articleData.updatedAt),
          lastSyncedAt: new Date(),
        },
        update: {
          blogId: articleData.blog?.id || "",
          blogTitle: articleData.blog?.title || "",
          title: articleData.title,
          body: articleData.body || "",
          summary: articleData.summary || null,
          handle: articleData.handle,
          imageUrl: articleData.image?.url || null,
          imageAltText: articleData.image?.altText || null,
          seoTitle: articleData.seo?.title || null,
          seoDescription: articleData.seo?.description || null,
          shopifyUpdatedAt: new Date(articleData.updatedAt),
          lastSyncedAt: new Date(),
        },
      });

      // Check if user recently saved translations for this article
      // Skip this check on manual reload (forceSync) - user explicitly wants fresh data
      if (!forceSync && isTranslationRecentlySaved(articleData.id)) {
        logger.info(`[ContentSync] Skipping translation sync for article - recently saved by user`, { articleId: articleData.id });
      } else {
        // Delete old translations — SCOPED to the layers this run actually
        // fetched (global + listed markets); see saveCollectionToDatabase.
        await tx.contentTranslation.deleteMany({
          where: {
            shop: this.shop,
            resourceId: articleData.id,
            resourceType: "Article",
            marketId: { in: fetchedMarketLayers(markets) },
          },
        });

        // Insert new translations
        if (validTranslations.length > 0) {
          await tx.contentTranslation.createMany({
            data: validTranslations.map(t => ({
              shop: this.shop,
              resourceId: articleData.id,
              resourceType: "Article",
              key: t.key,
              value: t.value,
              locale: t.locale,
              digest: t.digest || null,
              marketId: t.marketId || "",
            })),
          });
          logger.debug(`[ContentSync] ✓ Saved ${validTranslations.length} translations`);
        }
      }
    });

    logger.debug(`[ContentSync] ✓ Transaction completed successfully for article ${articleData.id}`);
  }

  private async saveMenuToDatabase(menuData: ShopifyMenuData) {
    const { db } = await import("../db.server");

    logger.debug(`[ContentSync] Saving menu to database: ${menuData.id}`);

    // Upsert menu
    await db.menu.upsert({
      where: {
        shop_id: {
          shop: this.shop,
          id: menuData.id,
        },
      },
      create: {
        id: menuData.id,
        shop: this.shop,
        title: menuData.title,
        handle: menuData.handle,
        items: (menuData.items || []) as Prisma.InputJsonValue,
        lastSyncedAt: new Date(),
      },
      update: {
        title: menuData.title,
        handle: menuData.handle,
        items: (menuData.items || []) as Prisma.InputJsonValue,
        lastSyncedAt: new Date(),
      },
    });

    logger.debug(`[ContentSync] ✓ Menu saved successfully`);
  }


  // ============================================
  // BULK SYNC
  // ============================================

  /**
   * Sync all collections (respects plan limit if provided)
   */
  async syncAllCollections(maxCount?: number, onProgress?: ProgressCallback): Promise<number> {
    logger.debug(`[ContentSync] Syncing all collections...`);
    if (maxCount !== undefined) {
      logger.debug(`[ContentSync] Plan limit: ${maxCount} collections`);
    }

    const response = await this.admin.graphql(
      `#graphql
        query getCollections {
          collections(first: 250) {
            edges {
              node {
                id
              }
            }
          }
        }`
    );

    const data = await response.json();
    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in syncAllCollections: ${data.errors[0].message}`);
    }
    let collections: Array<{ id: string }> = data.data?.collections?.edges?.map((e: GraphQLEdge<{ id: string }>) => e.node) || [];

    // Apply plan limit if specified
    if (maxCount !== undefined && maxCount > 0 && collections.length > maxCount) {
      logger.debug(`[ContentSync] Limiting to ${maxCount} collections (found ${collections.length})`);
      collections = collections.slice(0, maxCount);
    }

    logger.debug(`[ContentSync] Syncing ${collections.length} collections`);

    let index = 0;
    for (const collection of collections) {
      index++;
      if (onProgress) {
        onProgress(index, collections.length, `Syncing collection ${index}/${collections.length}`);
      }
      try {
        await this.syncCollection(collection.id);
      } catch (error) {
        logger.error(`[ContentSync] Failed to sync collection ${collection.id}, continuing with next`, { error });
      }
    }

    return collections.length;
  }

  /**
   * Sync all articles (respects plan limit if provided)
   */
  async syncAllArticles(maxCount?: number, onProgress?: ProgressCallback): Promise<number> {
    logger.debug(`[ContentSync] Syncing all articles...`);
    if (maxCount !== undefined) {
      logger.debug(`[ContentSync] Plan limit: ${maxCount} articles`);
    }

    // If limit is 0, skip articles entirely
    if (maxCount === 0) {
      logger.debug(`[ContentSync] Articles disabled for this plan, skipping`);
      return 0;
    }

    // First, get all blogs
    const blogsResponse = await this.admin.graphql(
      `#graphql
        query getBlogs {
          blogs(first: 250) {
            edges {
              node {
                id
                articles(first: 250) {
                  edges {
                    node {
                      id
                    }
                  }
                }
              }
            }
          }
        }`
    );

    const blogsData = await blogsResponse.json();
    if (blogsData.errors?.length > 0) {
      throw new Error(`GraphQL error in syncAllArticles: ${blogsData.errors[0].message}`);
    }
    const blogEdges = blogsData.data?.blogs?.edges || [];
    const blogs: Array<{ id: string; articles?: { edges: GraphQLEdge<{ id: string }>[] } }> =
      blogEdges.map((e: GraphQLEdge<{ id: string; articles?: { edges: GraphQLEdge<{ id: string }>[] } }>) => e.node);

    // Collect ALL Shopify article ids (before applying the plan cap — the cap
    // must not drive stale-deletes; over-cap pruning is planCacheCleanup's job).
    const allShopifyArticles: Array<{ id: string }> = [];
    let possiblyTruncated = blogEdges.length >= 250; // un-paginated blogs query
    for (const blog of blogs) {
      const edges = blog.articles?.edges || [];
      if (edges.length >= 250) possiblyTruncated = true; // un-paginated articles
      allShopifyArticles.push(...edges.map((e: GraphQLEdge<{ id: string }>) => e.node));
    }

    const { db } = await import("../db.server");

    // Stale-delete: articles deleted in Shopify have no webhook, so without
    // this they would linger forever. Skip when the query may be truncated
    // (>=250 blogs or any blog with >=250 articles) to avoid deleting real
    // articles we simply did not page through.
    if (possiblyTruncated) {
      logger.warn(`[ContentSync] Skipping article stale-delete: Shopify result possibly truncated (>=250)`);
    } else if (allShopifyArticles.length === 0) {
      // Health check: refuse to wipe local data on an empty/outage response.
      const localCount = await db.article.count({ where: { shop: this.shop } });
      if (localCount > 0) {
        throw new Error(`Shopify returned 0 articles but ${localCount} exist locally - aborting to prevent data loss`);
      }
    } else {
      const shopifyArticleIds = allShopifyArticles.map((a) => a.id);
      const { deleted } = await db.$transaction(async (tx) => {
        const stale = await tx.article.findMany({
          where: { shop: this.shop, id: { notIn: shopifyArticleIds } },
          select: { id: true },
        });
        const staleIds = stale.map((s) => s.id);
        const del = await tx.article.deleteMany({
          where: { shop: this.shop, id: { notIn: shopifyArticleIds } },
        });
        if (staleIds.length > 0) {
          await tx.contentTranslation.deleteMany({
            where: { shop: this.shop, resourceType: "Article", resourceId: { in: staleIds } },
          });
        }
        return { deleted: del.count };
      });
      if (deleted > 0) {
        logger.debug(`[ContentSync] 🗑️ Deleted ${deleted} articles that no longer exist in Shopify`);
      }
    }

    // Apply plan limit if specified (AFTER stale-delete, BEFORE syncing)
    let allArticles: Array<{ id: string }> = allShopifyArticles;
    if (maxCount !== undefined && maxCount > 0 && allArticles.length > maxCount) {
      logger.debug(`[ContentSync] Limiting to ${maxCount} articles (found ${allArticles.length})`);
      allArticles = allArticles.slice(0, maxCount);
    }

    logger.debug(`[ContentSync] Syncing ${allArticles.length} articles`);

    let index = 0;
    for (const article of allArticles) {
      index++;
      if (onProgress) {
        onProgress(index, allArticles.length, `Syncing article ${index}/${allArticles.length}`);
      }
      try {
        await this.syncArticle(article.id);
      } catch (error) {
        logger.error(`[ContentSync] Failed to sync article ${article.id}, continuing with next`, { error });
      }
    }

    return allArticles.length;
  }

  /**
   * Sync all menus
   */
  async syncAllMenus(): Promise<number> {
    logger.debug(`[ContentSync] Syncing all menus...`);

    const response = await this.admin.graphql(
      `#graphql
        query getMenus {
          menus(first: 250) {
            edges {
              node {
                id
              }
            }
          }
        }`
    );

    const data = await response.json();
    if (data.errors?.length > 0) {
      throw new Error(`GraphQL error in syncAllMenus: ${data.errors[0].message}`);
    }
    const menuEdges = data.data?.menus?.edges || [];
    const menus: Array<{ id: string }> = menuEdges.map((e: GraphQLEdge<{ id: string }>) => e.node);

    logger.debug(`[ContentSync] Found ${menus.length} menus to sync`);

    // Stale-delete: menus deleted in Shopify have no webhook. Skip when the
    // query may be truncated (>=250) to avoid deleting unseen menus.
    const { db } = await import("../db.server");
    if (menuEdges.length >= 250) {
      logger.warn(`[ContentSync] Skipping menu stale-delete: Shopify result possibly truncated (>=250)`);
    } else if (menus.length === 0) {
      const localCount = await db.menu.count({ where: { shop: this.shop } });
      if (localCount > 0) {
        throw new Error(`Shopify returned 0 menus but ${localCount} exist locally - aborting to prevent data loss`);
      }
    } else {
      const shopifyMenuIds = menus.map((m) => m.id);
      const del = await db.menu.deleteMany({
        where: { shop: this.shop, id: { notIn: shopifyMenuIds } },
      });
      if (del.count > 0) {
        logger.debug(`[ContentSync] 🗑️ Deleted ${del.count} menus that no longer exist in Shopify`);
      }
    }

    for (const menu of menus) {
      try {
        await this.syncMenu(menu.id);
      } catch (error) {
        logger.error(`[ContentSync] Failed to sync menu ${menu.id}, continuing with next`, { error });
      }
    }

    return menus.length;
  }

  // ============================================
  // SINGLE RESOURCE SYNC (for manual reload)
  // ============================================

  /**
   * Sync a single collection (wrapper for manual reload)
   */
  async syncSingleCollection(collectionId: string): Promise<Record<string, unknown>> {
    const gid = collectionId.startsWith("gid://")
      ? collectionId
      : `gid://shopify/Collection/${collectionId}`;

    await this.syncCollection(gid, /* forceSync */ true);

    const { db } = await import("../db.server");
    const collection = await db.collection.findUnique({
      where: {
        shop_id: {
          shop: this.shop,
          id: gid,
        },
      },
    });

    const translations = await db.contentTranslation.findMany({
      where: {
        shop: this.shop,
        resourceId: gid,
        resourceType: "Collection",
      },
    });

    return {
      ...collection,
      translations,
    };
  }

  /**
   * Sync a single article (wrapper for manual reload)
   */
  async syncSingleArticle(articleId: string): Promise<Record<string, unknown>> {
    const gid = articleId.startsWith("gid://")
      ? articleId
      : `gid://shopify/Article/${articleId}`;

    await this.syncArticle(gid, /* forceSync */ true);

    const { db } = await import("../db.server");
    const article = await db.article.findUnique({
      where: {
        shop_id: {
          shop: this.shop,
          id: gid,
        },
      },
    });

    const translations = await db.contentTranslation.findMany({
      where: {
        shop: this.shop,
        resourceId: gid,
        resourceType: "Article",
      },
    });

    return {
      ...article,
      translations,
    };
  }

}
